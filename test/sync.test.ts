import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptySharedState, serializeSharedState } from '../src/shared-state';
import {
  CHUNK_SIZE,
  SYNC_BUCKET_COUNT,
  decodeLegacySharedState,
  decodeSyncBucket,
  encodeSyncBucket,
  splitSyncState,
  startSyncPolling,
  syncBucketIndex,
  syncPayloadState,
  validateSyncBucket,
  validateSyncManifest,
  type SyncManifestV1,
  type SyncManifestV3,
} from '../src/sync';
import { bookmark, folder, resetFixtureCounter } from './fixtures';

beforeEach(() => resetFixtureCounter());

function stateWith(count: number) {
  const state = createEmptySharedState();
  for (let index = 0; index < count; index += 1) {
    state.bookmarks[`b${index}`] = {
      revision: index + 1,
      deviceId: 'device-a',
      value: bookmark({ id: `b${index}`, note: `备注 ${index}` }),
    };
  }
  state.clock = count;
  return state;
}

describe('同步数据编解码', () => {
  it('单桶往返后与原状态一致', async () => {
    const state = syncPayloadState(stateWith(20));
    const bucket = await encodeSyncBucket(state, 3);

    expect(await decodeSyncBucket(bucket)).toEqual(state);
  });

  it('桶载荷超过限制时拒绝编码', async () => {
    const state = createEmptySharedState();
    state.bookmarks.b1 = {
      revision: 1,
      deviceId: 'device-a',
      value: bookmark({ id: 'b1', note: randomBytes(CHUNK_SIZE).toString('base64') }),
    };

    await expect(encodeSyncBucket(state, 0)).rejects.toThrow('过大');
  });

  it('兼容读取旧版分块快照', async () => {
    const state = stateWith(20);
    const current = await encodeSyncBucket(state, 0);
    const chunks = Array.from(
      { length: Math.ceil(current.payload.length / CHUNK_SIZE) },
      (_, index) => current.payload.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE),
    );
    const legacy: SyncManifestV1 = {
      version: 1,
      generation: state.syncGeneration,
      updatedAt: Date.now(),
      snapshotId: 'legacy-snapshot',
      chunkCount: chunks.length,
      encoding: current.encoding,
      checksum: current.checksum,
    };

    expect(await decodeLegacySharedState(legacy, chunks)).toEqual(syncPayloadState(state));
  });
});

describe('稳定分桶', () => {
  it('同一类型与 id 始终落到同一桶', () => {
    expect(syncBucketIndex('bookmark', 'b1')).toBe(syncBucketIndex('bookmark', 'b1'));
    expect(syncBucketIndex('bookmark', 'b1')).not.toBeGreaterThanOrEqual(SYNC_BUCKET_COUNT);
  });

  it('书签和文件夹按类型独立分桶，墓碑仍保留在原桶', () => {
    const state = createEmptySharedState();
    state.bookmarks.same = { revision: 1, deviceId: 'a', deleted: true };
    state.folders.same = { revision: 2, deviceId: 'a', value: folder({ id: 'same' }) };

    const buckets = splitSyncState(state);
    expect(buckets).toHaveLength(SYNC_BUCKET_COUNT);
    expect(buckets[syncBucketIndex('bookmark', 'same')]!.bookmarks.same?.deleted).toBe(true);
    expect(buckets[syncBucketIndex('folder', 'same')]!.folders.same?.value?.id).toBe('same');
  });
});

describe('清单与桶校验', () => {
  const manifest: SyncManifestV3 = {
    version: 3,
    generation: 1,
    bucketCount: SYNC_BUCKET_COUNT,
    updatedAt: 1,
  };

  it('接受合法控制信息', () => {
    expect(() => validateSyncManifest(manifest)).not.toThrow();
  });

  it('拒绝非法控制信息', () => {
    expect(() => validateSyncManifest({ ...manifest, bucketCount: 1 })).toThrow('桶数量非法');
    expect(() => validateSyncManifest({ ...manifest, generation: -1 })).toThrow('代次非法');
  });

  it('拒绝非法桶', () => {
    expect(() => validateSyncBucket({
      version: 3,
      generation: 1,
      bucket: SYNC_BUCKET_COUNT,
      payload: 'AAAA',
      encoding: 'deflate-raw-base64',
      checksum: 'checksum',
    })).toThrow('桶编号非法');
  });
});

describe('发布前的净化', () => {
  it('剔除位置表并重算逻辑时钟', () => {
    const state = createEmptySharedState();
    state.bookmarks.b1 = { revision: 3, deviceId: 'a', value: bookmark({ id: 'b1' }) };
    state.folders.f1 = { revision: 5, deviceId: 'a', value: folder({ id: 'f1' }) };
    state.positions.b1 = { revision: 99, deviceId: 'a', value: { line: 1 } };
    state.clock = 99;

    const payload = syncPayloadState(state);
    expect(payload.positions).toEqual({});
    expect(payload.clock).toBe(5);
  });

  it('只有位置变化时待发布内容不变', () => {
    const before = stateWith(1);
    const after = structuredClone(before);
    after.positions.b0 = { revision: 2, deviceId: 'a', value: { line: 99 } };
    after.clock = 2;

    expect(serializeSharedState(syncPayloadState(after))).toBe(serializeSharedState(syncPayloadState(before)));
  });
});

describe('轮询', () => {
  it('上一轮未结束时跳过本拍', async () => {
    vi.useFakeTimers();
    let started = 0;
    let release = (): void => undefined;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const polling = startSyncPolling(() => { started += 1; return pending; }, () => undefined, 1_000);

    await vi.advanceTimersByTimeAsync(3_500);
    expect(started).toBe(1);

    release();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(started).toBe(2);

    polling.dispose();
    vi.useRealTimers();
  });
});
