import { beforeEach, describe, expect, it } from 'vitest';
import {
  collectTombstones,
  createEmptySharedState,
  deletedFolderIds,
  materializeBookmarks,
  materializeFolders,
  materializePositions,
  mergeSharedStates,
  parseSharedState,
  serializeSharedState,
  TOMBSTONE_RETENTION_MS,
  UnsupportedStateVersionError,
} from '../src/shared-state';
import { bookmark, folder, resetFixtureCounter } from './fixtures';

beforeEach(() => resetFixtureCounter());

describe('共享状态合并', () => {
  it('按逻辑版本合并，并用设备 ID 稳定裁决同版本冲突', () => {
    const left = createEmptySharedState();
    const right = createEmptySharedState();
    left.bookmarks['b1'] = { revision: 2, deviceId: 'device-a', value: bookmark({ id: 'b1', note: '设备 A' }) };
    right.bookmarks['b1'] = { revision: 2, deviceId: 'device-b', value: bookmark({ id: 'b1', note: '设备 B' }) };

    expect(materializeBookmarks(mergeSharedStates(left, right))[0]?.note).toBe('设备 B');
    expect(materializeBookmarks(mergeSharedStates(right, left))[0]?.note).toBe('设备 B');
  });

  it('保留删除标记，防止旧设备复活已删除的记录', () => {
    const active = createEmptySharedState();
    const removed = createEmptySharedState();
    active.bookmarks['b1'] = { revision: 4, deviceId: 'device-a', value: bookmark({ id: 'b1' }) };
    removed.bookmarks['b1'] = { revision: 5, deviceId: 'device-b', deleted: true };

    const merged = mergeSharedStates(active, removed);

    expect(materializeBookmarks(merged)).toEqual([]);
    expect(merged.bookmarks['b1']).toMatchObject({ revision: 5, deleted: true });
  });

  it('三张表各自独立合并', () => {
    const left = createEmptySharedState();
    const right = createEmptySharedState();
    left.bookmarks['b1'] = { revision: 2, deviceId: 'a', value: bookmark({ id: 'b1' }) };
    left.folders['f1'] = { revision: 1, deviceId: 'a', value: folder({ id: 'f1' }) };
    right.positions['b1'] = { revision: 3, deviceId: 'b', value: { line: 42 } };

    const merged = mergeSharedStates(left, right);

    expect(materializeBookmarks(merged)).toHaveLength(1);
    expect(materializeFolders(merged)).toHaveLength(1);
    expect(materializePositions(merged).get('b1')).toBe(42);
  });

  it('物化结果是深拷贝，外部修改不会污染内部状态', () => {
    const state = createEmptySharedState();
    state.bookmarks['b1'] = { revision: 1, deviceId: 'a', value: bookmark({ id: 'b1', note: '原始' }) };

    const first = materializeBookmarks(state);
    first[0]!.note = '被改写';

    expect(materializeBookmarks(state)[0]?.note).toBe('原始');
  });
});

describe('共享状态解析', () => {
  it('跳过内容非法的单条记录，保留其余记录', () => {
    const state = createEmptySharedState();
    state.bookmarks['good'] = { revision: 1, deviceId: 'a', value: bookmark({ id: 'good' }) };
    const raw = JSON.parse(serializeSharedState(state));
    raw.bookmarks['bad'] = { revision: 2, deviceId: 'a', value: { id: 'bad' } };

    const parsed = parseSharedState(raw);

    expect(materializeBookmarks(parsed).map((item) => item.id)).toEqual(['good']);
  });

  it('拒绝排序键非法的记录', () => {
    const state = createEmptySharedState();
    const raw = JSON.parse(serializeSharedState(state));
    // 末位为零的排序键无法在其左侧插入，必须在入口处就挡掉。
    raw.bookmarks['bad'] = { revision: 1, deviceId: 'a', value: bookmark({ id: 'bad', order: 'a0V0' }) };

    expect(materializeBookmarks(parseSharedState(raw))).toEqual([]);
  });

  it('记录骨架非法时整体拒绝', () => {
    const raw = JSON.parse(serializeSharedState(createEmptySharedState()));
    raw.bookmarks['bad'] = { deviceId: 'a', value: bookmark() };

    expect(() => parseSharedState(raw)).toThrow('共享状态记录格式错误');
  });

  it('版本过高时抛出专用错误以便只读降级', () => {
    expect(() => parseSharedState({ version: 2, clock: 0, syncGeneration: 0 }))
      .toThrow(UnsupportedStateVersionError);
    expect(() => parseSharedState({ version: 0, clock: 0, syncGeneration: 0 }))
      .toThrow('共享状态格式错误');
  });

  it('记录表使用无原型对象，__proto__ 作为键不会污染原型', () => {
    // 必须经由 JSON.parse 构造：直接给普通对象赋值 __proto__ 是在设置原型，键根本不会存在。
    const record = JSON.stringify({ revision: 1, deviceId: 'a', value: bookmark({ id: '__proto__' }) });
    const raw = JSON.parse(
      `{"version":1,"clock":0,"syncGeneration":0,"bookmarks":{"__proto__":${record}},"folders":{},"positions":{}}`,
    );

    const parsed = parseSharedState(raw);

    expect(Object.getPrototypeOf(parsed.bookmarks)).toBeNull();
    expect(materializeBookmarks(parsed).map((item) => item.id)).toEqual(['__proto__']);
    expect(({} as any).revision).toBeUndefined();
  });
});

describe('序列化', () => {
  it('内容等价的状态序列化后逐字节相同', () => {
    const first = bookmark({ id: 'a' });
    const second = bookmark({ id: 'b' });
    const left = createEmptySharedState();
    const right = createEmptySharedState();
    // 两张表插入顺序相反，内容完全相同：写入判等与同步的「是否需要发布」都依赖二者字节一致。
    left.bookmarks['b'] = { revision: 1, deviceId: 'a', value: second };
    left.bookmarks['a'] = { revision: 2, deviceId: 'a', value: first };
    right.bookmarks['a'] = { revision: 2, deviceId: 'a', value: first };
    right.bookmarks['b'] = { revision: 1, deviceId: 'a', value: second };

    expect(serializeSharedState(left)).toBe(serializeSharedState(right));
  });
});

describe('墓碑回收', () => {
  it('为缺少时间戳的墓碑补上时间而不是立即回收', () => {
    const state = createEmptySharedState();
    state.folders['f1'] = { revision: 1, deviceId: 'a', deleted: true };

    expect(collectTombstones(state, 1_000)).toBe(true);
    expect(state.folders['f1']).toMatchObject({ deleted: true, deletedAt: 1_000 });
  });

  it('只回收超过保留期的墓碑', () => {
    const state = createEmptySharedState();
    state.folders['fresh'] = { revision: 1, deviceId: 'a', deleted: true, deletedAt: 5_000 };
    state.folders['stale'] = { revision: 2, deviceId: 'a', deleted: true, deletedAt: 0 };

    collectTombstones(state, TOMBSTONE_RETENTION_MS + 1_000);

    expect(state.folders['fresh']).toBeDefined();
    expect(state.folders['stale']).toBeUndefined();
  });

  it('墓碑在保留期内可被识别，供树构建区分「已删除」与「未同步到」', () => {
    const state = createEmptySharedState();
    state.folders['gone'] = { revision: 1, deviceId: 'a', deleted: true, deletedAt: 1_000 };

    expect(deletedFolderIds(state)).toEqual(new Set(['gone']));
  });
});
