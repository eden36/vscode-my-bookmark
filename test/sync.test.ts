import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEmptySharedState, serializeSharedState } from '../src/shared-state';
import {
  CHUNK_SIZE,
  decodeSharedState,
  encodeSharedState,
  manifestKey,
  startSyncPolling,
  syncPayloadState,
  validateManifest,
  type SyncManifestV1,
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
  it('往返后与原状态一致', async () => {
    const state = stateWith(20);
    const { manifest, chunks } = await encodeSharedState(state);

    expect(manifest.encoding).toBe('deflate-raw-base64');
    expect(await decodeSharedState(manifest, chunks)).toEqual(state);
  });

  it('大状态被切分成多个分块', async () => {
    const { manifest, chunks } = await encodeSharedState(stateWith(4_000));

    expect(chunks.length).toBeGreaterThan(1);
    expect(manifest.chunkCount).toBe(chunks.length);
    expect(Math.max(...chunks.map((chunk) => chunk.length))).toBeLessThanOrEqual(CHUNK_SIZE);
  });

  it('分块被篡改时校验失败', async () => {
    const { manifest, chunks } = await encodeSharedState(stateWith(5));
    const tampered = [...chunks];
    tampered[0] = Buffer.from('伪造内容').toString('base64');

    await expect(decodeSharedState(manifest, tampered)).rejects.toThrow('同步数据校验失败');
  });

  it('分块数量不符时拒绝解码', async () => {
    const { manifest, chunks } = await encodeSharedState(stateWith(5));

    await expect(decodeSharedState(manifest, chunks.slice(0, -1))).rejects.toThrow('分块不完整');
  });

  it('重置广播不需要分块', async () => {
    const manifest: SyncManifestV1 = {
      version: 1,
      generation: 7,
      updatedAt: Date.now(),
      snapshotId: 'reset-snapshot',
      chunkCount: 0,
      encoding: 'deflate-raw-base64',
      checksum: 'unused',
      reset: true,
    };

    const decoded = await decodeSharedState(manifest, []);

    expect(decoded.syncGeneration).toBe(7);
    expect(decoded.bookmarks).toEqual({});
  });

  it('每次发布使用新的快照标识，避免新旧分块混拼', async () => {
    const state = stateWith(3);
    const first = await encodeSharedState(state);
    const second = await encodeSharedState(state);

    expect(first.manifest.snapshotId).not.toBe(second.manifest.snapshotId);
    // 内容相同，因此校验值一致——上层据此判断是否需要真正发布。
    expect(first.manifest.checksum).toBe(second.manifest.checksum);
  });
});

describe('清单校验', () => {
  const base: SyncManifestV1 = {
    version: 1,
    generation: 1,
    updatedAt: 0,
    snapshotId: 'abc-123',
    chunkCount: 1,
    encoding: 'deflate-raw-base64',
    checksum: 'deadbeef',
  };

  it('接受合法清单', () => {
    expect(() => validateManifest(base)).not.toThrow();
  });

  it('拒绝来自云端的非法字段', () => {
    // snapshotId 会被拼进 globalState 的键，必须严格限制字符集。
    expect(() => validateManifest({ ...base, snapshotId: '../../etc/passwd' })).toThrow('标识非法');
    expect(() => validateManifest({ ...base, chunkCount: 9_999 })).toThrow('分块数非法');
    expect(() => validateManifest({ ...base, chunkCount: -1 })).toThrow('分块数非法');
    expect(() => validateManifest({ ...base, generation: -1 })).toThrow('代次非法');
    expect(() => validateManifest({ ...base, version: 2 as 1 })).toThrow('不支持的同步数据版本');
    expect(() => validateManifest({ ...base, encoding: 'gzip' as 'deflate-raw-base64' })).toThrow('不支持的同步数据编码');
    expect(() => validateManifest({ ...base, checksum: '' })).toThrow('校验值缺失');
  });

  it('清单指纹能区分不同的快照', () => {
    expect(manifestKey(base)).not.toBe(manifestKey({ ...base, snapshotId: 'other' }));
    expect(manifestKey(base)).toBe(manifestKey({ ...base, updatedAt: 999 }));
  });
});

describe('发布前的净化', () => {
  it('剔除位置表：跨设备可能停在不同分支，行号本就不该共享', () => {
    const state = createEmptySharedState();
    state.bookmarks['b1'] = { revision: 1, deviceId: 'a', value: bookmark({ id: 'b1' }) };
    state.positions['b1'] = { revision: 2, deviceId: 'a', value: { line: 42 } };
    state.clock = 2;

    expect(syncPayloadState(state).positions).toEqual({});
  });

  it('只有位置变化时不产生新的待发布内容', () => {
    // 这是防止「每次保存文件都往云端推一份完整快照」的关键回归。
    const before = createEmptySharedState();
    before.bookmarks['b1'] = { revision: 1, deviceId: 'a', value: bookmark({ id: 'b1' }) };
    before.clock = 1;
    const after = structuredClone(before);
    after.positions['b1'] = { revision: 2, deviceId: 'a', value: { line: 99 } };
    after.clock = 2;

    expect(serializeSharedState(syncPayloadState(after))).toBe(serializeSharedState(syncPayloadState(before)));
  });

  it('书签变化时待发布内容随之变化', () => {
    const before = createEmptySharedState();
    before.bookmarks['b1'] = { revision: 1, deviceId: 'a', value: bookmark({ id: 'b1', note: '旧' }) };
    const after = createEmptySharedState();
    after.bookmarks['b1'] = { revision: 2, deviceId: 'a', value: bookmark({ id: 'b1', note: '新' }) };

    expect(serializeSharedState(syncPayloadState(after))).not.toBe(serializeSharedState(syncPayloadState(before)));
  });

  it('clock 重算为实际最大版本号', () => {
    const state = createEmptySharedState();
    state.bookmarks['b1'] = { revision: 3, deviceId: 'a', value: bookmark({ id: 'b1' }) };
    state.folders['f1'] = { revision: 5, deviceId: 'a', value: folder({ id: 'f1' }) };
    state.positions['b1'] = { revision: 99, deviceId: 'a', value: { line: 1 } };
    state.clock = 99;

    expect(syncPayloadState(state).clock).toBe(5);
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

  it('失败被交给错误回调且不中断后续轮询', async () => {
    vi.useFakeTimers();
    const errors: unknown[] = [];
    let calls = 0;
    const polling = startSyncPolling(
      () => { calls += 1; return Promise.reject(new Error(`第 ${calls} 次失败`)); },
      (error) => errors.push(error),
      1_000,
    );

    await vi.advanceTimersByTimeAsync(2_500);

    expect(calls).toBe(2);
    expect(errors).toHaveLength(2);

    polling.dispose();
    vi.useRealTimers();
  });

  it('释放后不再触发', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const polling = startSyncPolling(() => { calls += 1; return Promise.resolve(); }, () => undefined, 1_000);

    polling.dispose();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(calls).toBe(0);
    vi.useRealTimers();
  });
});
