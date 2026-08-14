import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptySharedState, type SharedStateV1 } from '../src/shared-state';
import {
  encodeSharedState,
  INCOMPLETE_CHUNK_ATTEMPTS,
  SyncService,
  syncPayloadState,
  type SyncManifestV1,
  type SyncStorage,
} from '../src/sync';
import { bookmark, resetFixtureCounter } from './fixtures';

class FakeSyncStorage implements SyncStorage {
  state = createEmptySharedState();
  manifest: SyncManifestV1 | undefined;
  chunks = new Map<string, string>();
  /** 模拟设置同步的传播延迟：只有登记过的分块键才会被投递下来。 */
  withheldChunks = new Map<string, string>();
  registeredKeys: string[] = [];
  appliedResetGeneration = 0;
  savedSnapshots = 0;
  mergedStates: SharedStateV1[] = [];

  getSharedState(): SharedStateV1 { return structuredClone(this.state); }
  getSyncGeneration(): number { return this.state.syncGeneration; }
  getSyncManifest(): SyncManifestV1 | undefined { return this.manifest; }
  getSyncChunk(snapshotId: string, index: number): string | undefined {
    return this.chunks.get(`${snapshotId}.${index}`);
  }

  async saveSyncSnapshot(manifest: SyncManifestV1, chunks: readonly string[]): Promise<void> {
    this.savedSnapshots += 1;
    this.manifest = manifest;
    chunks.forEach((chunk, index) => this.chunks.set(`${manifest.snapshotId}.${index}`, chunk));
  }

  registerSyncKeys(manifest?: SyncManifestV1): void {
    if (manifest === undefined) return;
    // 真实行为：本轮登记分块键，设置同步下一轮才会把分块投递下来。
    if (this.registeredKeys.includes(manifest.snapshotId)) {
      for (const [key, value] of this.withheldChunks) {
        if (key.startsWith(`${manifest.snapshotId}.`)) this.chunks.set(key, value);
      }
      this.withheldChunks.clear();
    }
    this.registeredKeys.push(manifest.snapshotId);
  }

  async mergeRemoteState(remote: SharedStateV1): Promise<boolean> {
    this.mergedStates.push(remote);
    this.state = remote;
    return true;
  }

  getAppliedResetGeneration(): number { return this.appliedResetGeneration; }
  async saveAppliedResetGeneration(generation: number): Promise<void> { this.appliedResetGeneration = generation; }
}

function stateWithBookmark(id: string, note: string): SharedStateV1 {
  const state = createEmptySharedState();
  state.bookmarks[id] = { revision: 1, deviceId: 'remote', value: bookmark({ id, note }) };
  state.clock = 1;
  return state;
}

beforeEach(() => resetFixtureCounter());

describe('SyncService', () => {
  it('构造时即登记同步键', () => {
    const storage = new FakeSyncStorage();
    const registered: unknown[] = [];
    storage.registerSyncKeys = (manifest) => { registered.push(manifest); };

    new SyncService(storage);

    expect(registered).toHaveLength(1);
  });

  it('首次同步发布本地状态', async () => {
    const storage = new FakeSyncStorage();
    storage.state = stateWithBookmark('b1', '本地');
    const sync = new SyncService(storage);

    await sync.reconcile();

    expect(storage.savedSnapshots).toBe(1);
    expect(sync.getStatus().lastError).toBeUndefined();
  });

  it('内容未变化时不重复发布', async () => {
    const storage = new FakeSyncStorage();
    storage.state = stateWithBookmark('b1', '本地');
    const sync = new SyncService(storage);

    await sync.reconcile();
    await sync.reconcile();
    await sync.reconcile();

    expect(storage.savedSnapshots).toBe(1);
  });

  it('只有位置变化时不产生新快照', async () => {
    const storage = new FakeSyncStorage();
    storage.state = stateWithBookmark('b1', '本地');
    const sync = new SyncService(storage);
    await sync.reconcile();

    // 这是防止「每保存一次文件就往云端推一份完整快照」的关键回归。
    storage.state.positions['b1'] = { revision: 2, deviceId: 'local', value: { line: 99 } };
    storage.state.clock = 2;
    await sync.reconcile();

    expect(storage.savedSnapshots).toBe(1);
  });

  it('拉取远端后不会把同一份内容再推回去', async () => {
    const storage = new FakeSyncStorage();
    const remote = stateWithBookmark('b1', '远端');
    const encoded = await encodeSharedState(syncPayloadState(remote));
    storage.manifest = encoded.manifest;
    encoded.chunks.forEach((chunk, index) => storage.chunks.set(`${encoded.manifest.snapshotId}.${index}`, chunk));
    const sync = new SyncService(storage);

    await sync.reconcile();

    expect(storage.mergedStates).toHaveLength(1);
    // 合并后本地内容与远端一致，不该产生一次「回声」发布。
    expect(storage.savedSnapshots).toBe(0);
  });

  it('分块尚未到齐时先等待，不当作故障上报', async () => {
    const storage = new FakeSyncStorage();
    const encoded = await encodeSharedState(stateWithBookmark('b1', '远端'));
    storage.manifest = encoded.manifest;
    // 分块被扣住，直到本机登记过该快照的键、且经过一轮往返之后才投递——新设备的真实情形。
    encoded.chunks.forEach((chunk, index) => {
      storage.withheldChunks.set(`${encoded.manifest.snapshotId}.${index}`, chunk);
    });
    const sync = new SyncService(storage);

    await sync.reconcile();
    expect(storage.mergedStates).toHaveLength(0);

    // 下一轮分块已到达，同步自然完成。
    await sync.reconcile();
    expect(storage.mergedStates).toHaveLength(1);
  });

  it('分块长期不到齐才报告错误', async () => {
    const storage = new FakeSyncStorage();
    const encoded = await encodeSharedState(stateWithBookmark('b1', '远端'));
    storage.manifest = { ...encoded.manifest, chunkCount: 3 };
    const sync = new SyncService(storage);

    for (let attempt = 0; attempt < INCOMPLETE_CHUNK_ATTEMPTS + 1; attempt += 1) await sync.reconcile();

    expect(sync.getStatus().lastError).toBeDefined();
    expect(storage.mergedStates).toHaveLength(0);
  });

  it('远端代次落后时忽略', async () => {
    const storage = new FakeSyncStorage();
    storage.state.syncGeneration = 5;
    const encoded = await encodeSharedState(createEmptySharedState());
    storage.manifest = { ...encoded.manifest, generation: 2 };
    const sync = new SyncService(storage);

    await sync.reconcile();

    expect(storage.mergedStates).toHaveLength(0);
  });

  it('重置广播只应用一次', async () => {
    const storage = new FakeSyncStorage();
    storage.manifest = {
      version: 1,
      generation: 3,
      updatedAt: 0,
      snapshotId: 'reset-1',
      chunkCount: 0,
      encoding: 'deflate-raw-base64',
      checksum: 'unused',
      reset: true,
    };
    const sync = new SyncService(storage);

    await sync.reconcile();
    expect(storage.appliedResetGeneration).toBe(3);

    storage.mergedStates = [];
    await sync.reconcile();
    expect(storage.mergedStates).toHaveLength(0);
  });

  it('连续失败达到阈值才向用户报告', async () => {
    const storage = new FakeSyncStorage();
    storage.manifest = { ...(await encodeSharedState(createEmptySharedState())).manifest, checksum: 'wrong' };
    storage.chunks.set(`${storage.manifest.snapshotId}.0`, 'AAAA');
    const sync = new SyncService(storage);

    await sync.reconcile();
    expect(sync.getStatus().lastError).toBeUndefined();
    await sync.reconcile();
    expect(sync.getStatus().lastError).toBeUndefined();
    await sync.reconcile();
    expect(sync.getStatus().lastError).toBeDefined();
  });

  it('多次本地变更只合并成一次发布', async () => {
    const storage = new FakeSyncStorage();
    storage.state = stateWithBookmark('b1', '本地');
    // 压缩走的是真实异步 I/O，假定时器推不动它，因此缩短真实的合并窗口来测。
    const sync = new SyncService(storage, () => undefined, 10);

    sync.schedulePublish();
    sync.schedulePublish();
    sync.schedulePublish();
    await vi.waitFor(() => expect(storage.savedSnapshots).toBe(1));

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(storage.savedSnapshots).toBe(1);
    sync.dispose();
  });

  it('释放后不再发布', async () => {
    const storage = new FakeSyncStorage();
    storage.state = stateWithBookmark('b1', '本地');
    const sync = new SyncService(storage, () => undefined, 10);

    sync.schedulePublish();
    sync.dispose();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(storage.savedSnapshots).toBe(0);
  });
});
