import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptySharedState, type SharedStateV1 } from '../src/shared-state';
import {
  CHUNK_SIZE,
  SYNC_BUCKET_COUNT,
  SyncService,
  encodeSyncBucket,
  splitSyncState,
  syncPayloadState,
  type SyncBucketV3,
  type SyncManifestV1,
  type SyncManifestV3,
  type SyncStorage,
} from '../src/sync';
import { bookmark, resetFixtureCounter } from './fixtures';

class FakeSyncStorage implements SyncStorage {
  state = createEmptySharedState();
  manifest: SyncManifestV3 | undefined;
  buckets = new Map<number, SyncBucketV3>();
  legacyManifest: SyncManifestV1 | undefined;
  legacyChunks = new Map<string, string>();
  registered = 0;
  savedBuckets: SyncBucketV3[][] = [];
  savedManifests = 0;
  legacyCleared = false;
  mergedStates: SharedStateV1[] = [];
  resetGenerations: number[] = [];

  getSharedState(): SharedStateV1 { return structuredClone(this.state); }
  getSyncGeneration(): number { return this.state.syncGeneration; }
  getSyncManifest(): SyncManifestV3 | undefined { return this.manifest; }
  getSyncBucket(index: number): SyncBucketV3 | undefined { return this.buckets.get(index); }
  getLegacySyncManifest(): SyncManifestV1 | undefined { return this.legacyManifest; }
  getLegacySyncChunk(snapshotId: string, index: number): string | undefined {
    return this.legacyChunks.get(`${snapshotId}.${index}`);
  }

  async saveSyncBuckets(buckets: readonly SyncBucketV3[]): Promise<void> {
    this.savedBuckets.push([...buckets]);
    for (const bucket of buckets) this.buckets.set(bucket.bucket, bucket);
  }

  async saveSyncManifest(manifest: SyncManifestV3): Promise<void> {
    this.savedManifests += 1;
    this.manifest = manifest;
  }

  async clearLegacySyncSnapshot(manifest: SyncManifestV1): Promise<void> {
    this.legacyCleared = true;
    this.legacyManifest = undefined;
    for (let index = 0; index < manifest.chunkCount; index += 1) {
      this.legacyChunks.delete(`${manifest.snapshotId}.${index}`);
    }
  }

  registerSyncKeys(): void { this.registered += 1; }

  async mergeRemoteState(remote: SharedStateV1): Promise<boolean> {
    this.mergedStates.push(remote);
    Object.assign(this.state.bookmarks, remote.bookmarks);
    Object.assign(this.state.folders, remote.folders);
    this.state.clock = Math.max(this.state.clock, remote.clock);
    this.state.syncGeneration = Math.max(this.state.syncGeneration, remote.syncGeneration);
    return true;
  }

  async resetRemoteState(generation: number): Promise<void> {
    this.resetGenerations.push(generation);
    this.state = { ...createEmptySharedState(), syncGeneration: generation };
  }
}

function stateWithBookmark(id: string, note: string): SharedStateV1 {
  const state = createEmptySharedState();
  state.bookmarks[id] = { revision: 1, deviceId: 'remote', value: bookmark({ id, note }) };
  state.clock = 1;
  return state;
}

async function installV3Snapshot(storage: FakeSyncStorage, state: SharedStateV1): Promise<void> {
  const payload = syncPayloadState(state);
  const buckets = await Promise.all(splitSyncState(payload).map((bucket, index) => encodeSyncBucket(bucket, index)));
  for (const bucket of buckets) storage.buckets.set(bucket.bucket, bucket);
  storage.manifest = {
    version: 3,
    generation: payload.syncGeneration,
    bucketCount: SYNC_BUCKET_COUNT,
    updatedAt: 1,
  };
}

async function installV1Snapshot(storage: FakeSyncStorage, state: SharedStateV1): Promise<void> {
  const encoded = await encodeSyncBucket(syncPayloadState(state), 0);
  const chunks = Array.from(
    { length: Math.ceil(encoded.payload.length / CHUNK_SIZE) },
    (_, index) => encoded.payload.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE),
  );
  storage.legacyManifest = {
    version: 1,
    generation: state.syncGeneration,
    updatedAt: 1,
    snapshotId: 'legacy-snapshot',
    chunkCount: chunks.length,
    encoding: encoded.encoding,
    checksum: encoded.checksum,
  };
  chunks.forEach((chunk, index) => storage.legacyChunks.set(`legacy-snapshot.${index}`, chunk));
}

beforeEach(() => resetFixtureCounter());

describe('SyncService', () => {
  it('构造时即登记全部固定同步键', () => {
    const storage = new FakeSyncStorage();

    new SyncService(storage);

    expect(storage.registered).toBe(1);
  });

  it('首次同步发布全部固定桶和控制键', async () => {
    const storage = new FakeSyncStorage();
    storage.state = stateWithBookmark('b1', '本地');
    const sync = new SyncService(storage);

    await sync.reconcile();

    expect(storage.savedBuckets).toHaveLength(1);
    expect(storage.savedBuckets[0]).toHaveLength(SYNC_BUCKET_COUNT);
    expect(storage.savedManifests).toBe(1);
  });

  it('内容未变化时不重复发布', async () => {
    const storage = new FakeSyncStorage();
    storage.state = stateWithBookmark('b1', '本地');
    const sync = new SyncService(storage);

    await sync.reconcile();
    await sync.reconcile();

    expect(storage.savedBuckets).toHaveLength(1);
  });

  it('单条书签变化只重写所属桶', async () => {
    const storage = new FakeSyncStorage();
    storage.state = stateWithBookmark('b1', '本地');
    const sync = new SyncService(storage);
    await sync.reconcile();

    storage.state.bookmarks.b1 = { revision: 2, deviceId: 'local', value: bookmark({ id: 'b1', note: '已修改' }) };
    storage.state.clock = 2;
    await sync.reconcile();

    expect(storage.savedBuckets).toHaveLength(2);
    expect(storage.savedBuckets[1]).toHaveLength(1);
    expect(storage.savedManifests).toBe(1);
  });

  it('只有位置变化时不产生新桶', async () => {
    const storage = new FakeSyncStorage();
    storage.state = stateWithBookmark('b1', '本地');
    const sync = new SyncService(storage);
    await sync.reconcile();

    storage.state.positions.b1 = { revision: 2, deviceId: 'local', value: { line: 99 } };
    storage.state.clock = 2;
    await sync.reconcile();

    expect(storage.savedBuckets).toHaveLength(1);
  });

  it('拉取远端桶后不会把相同内容再推回去', async () => {
    const storage = new FakeSyncStorage();
    await installV3Snapshot(storage, stateWithBookmark('b1', '远端'));
    const sync = new SyncService(storage);

    await sync.reconcile();

    expect(storage.mergedStates).toHaveLength(1);
    expect(storage.savedBuckets).toHaveLength(0);
  });

  it('首次读取 V1 后迁移为 V3 并立即清理 V1', async () => {
    const storage = new FakeSyncStorage();
    await installV1Snapshot(storage, stateWithBookmark('b1', '旧版远端'));
    const sync = new SyncService(storage);

    await sync.reconcile();

    expect(storage.manifest?.version).toBe(3);
    expect(storage.savedBuckets[0]).toHaveLength(SYNC_BUCKET_COUNT);
    expect(storage.legacyCleared).toBe(true);
  });

  it('V3 已激活时清理被旧设备重新写入的 V1 快照', async () => {
    const storage = new FakeSyncStorage();
    await installV3Snapshot(storage, stateWithBookmark('b1', 'V3'));
    await installV1Snapshot(storage, stateWithBookmark('b2', '过期 V1'));
    const sync = new SyncService(storage);

    await sync.reconcile();

    expect(storage.legacyCleared).toBe(true);
    expect(storage.legacyManifest).toBeUndefined();
  });

  it('V1 分块未到齐时不发布空 V3', async () => {
    const storage = new FakeSyncStorage();
    await installV1Snapshot(storage, stateWithBookmark('b1', '旧版远端'));
    storage.legacyChunks.clear();
    const sync = new SyncService(storage);

    await sync.reconcile();

    expect(storage.manifest).toBeUndefined();
    expect(sync.getStatus().lastError).toBe('同步数据尚未接收完整，正在等待');
  });

  it('空设备首次启动不发布空快照', async () => {
    const storage = new FakeSyncStorage();
    const sync = new SyncService(storage);

    await sync.reconcile();

    expect(storage.savedBuckets).toHaveLength(0);
  });

  it('代次提升时重置本地状态并重写全部桶', async () => {
    const storage = new FakeSyncStorage();
    storage.state = stateWithBookmark('b1', '本地');
    const sync = new SyncService(storage);
    await sync.reconcile();

    storage.state = { ...createEmptySharedState(), syncGeneration: 1 };
    await sync.reconcile();

    expect(storage.savedBuckets[1]).toHaveLength(SYNC_BUCKET_COUNT);
    expect(storage.manifest?.generation).toBe(1);
  });

  it('V3 桶未到齐时等待而不改写', async () => {
    const storage = new FakeSyncStorage();
    await installV3Snapshot(storage, stateWithBookmark('b1', '远端'));
    storage.buckets.delete(10);
    const sync = new SyncService(storage);

    await sync.reconcile();

    expect(storage.savedBuckets).toHaveLength(0);
    expect(sync.getStatus().lastError).toBe('同步数据尚未接收完整，正在等待');
  });

  it('多次本地变更只合并成一次发布', async () => {
    const storage = new FakeSyncStorage();
    storage.state = stateWithBookmark('b1', '本地');
    const sync = new SyncService(storage, () => undefined, 10);

    sync.schedulePublish();
    sync.schedulePublish();
    sync.schedulePublish();
    await vi.waitFor(() => expect(storage.savedBuckets).toHaveLength(1));

    sync.dispose();
  });
});
