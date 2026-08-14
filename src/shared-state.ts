import {
  isBookmark,
  isBookmarkFolder,
  isBookmarkPosition,
  type Bookmark,
  type BookmarkFolder,
  type BookmarkPosition,
} from './core/model';

/**
 * 共享状态：多个窗口、多个 Profile、多台设备之间流转的数据结构。
 *
 * 合并策略是按记录的最后写入者胜出：每条记录带一个逻辑版本 revision，比较时先比 revision，
 * 相同再比 deviceId。删除用墓碑表示，否则旧设备的一次同步就会让已删除的记录复活。
 */

export interface VersionedRecord<T> {
  revision: number;
  deviceId: string;
  value?: T;
  deleted?: true;
  /** 墓碑的产生时间，用于延迟回收。见下方关于回收时机的说明。 */
  deletedAt?: number;
}

export interface SharedStateV1 {
  version: 1;
  clock: number;
  syncGeneration: number;
  bookmarks: Record<string, VersionedRecord<Bookmark>>;
  folders: Record<string, VersionedRecord<BookmarkFolder>>;
  /**
   * 书签在磁盘文件中的当前行号。
   *
   * 单独成表有两个原因：一是行号随保存自动变化，与备注/分组这类人工字段合用一条记录会让
   * 自动行为覆盖人工意图；二是这张表不参与跨设备同步——两台设备可能停在不同的分支上，
   * 同一书签的行号本就不该相同。
   */
  positions: Record<string, VersionedRecord<BookmarkPosition>>;
}

export interface SharedStoreChange {
  source: 'local' | 'external' | 'remote';
  revision: number;
}

/**
 * 墓碑保留时长。
 *
 * 不能激进回收：树构建要靠「墓碑存在与否」区分「文件夹确实被删了」和「记录还没同步到」，
 * 一旦回收，这两种情况就无法分辨，孤儿书签会被误判并永久丢失分组。
 */
export const TOMBSTONE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export function createEmptySharedState(): SharedStateV1 {
  return {
    version: 1,
    clock: 0,
    syncGeneration: 0,
    bookmarks: emptyRecordMap(),
    folders: emptyRecordMap(),
    positions: emptyRecordMap(),
  };
}

export function mergeSharedStates(left: SharedStateV1, right: SharedStateV1): SharedStateV1 {
  return {
    version: 1,
    clock: Math.max(left.clock, right.clock),
    syncGeneration: Math.max(left.syncGeneration, right.syncGeneration),
    bookmarks: mergeRecordMaps(left.bookmarks, right.bookmarks),
    folders: mergeRecordMaps(left.folders, right.folders),
    positions: mergeRecordMaps(left.positions, right.positions),
  };
}

export function materializeBookmarks(state: SharedStateV1): Bookmark[] {
  return materialize(state.bookmarks);
}

export function materializeFolders(state: SharedStateV1): BookmarkFolder[] {
  return materialize(state.folders);
}

export function materializePositions(state: SharedStateV1): Map<string, number> {
  const result = new Map<string, number>();
  for (const [id, record] of Object.entries(state.positions)) {
    if (record.deleted || record.value === undefined) continue;
    result.set(id, record.value.line);
  }
  return result;
}

/** 已确认删除的文件夹 id，供树构建区分「已删除」与「尚未同步到」。 */
export function deletedFolderIds(state: SharedStateV1): Set<string> {
  const result = new Set<string>();
  for (const [id, record] of Object.entries(state.folders)) {
    if (record.deleted) result.add(id);
  }
  return result;
}

/** 状态文件由更高版本的扩展写入。此时必须只读降级，不能当作损坏文件接管。 */
export class UnsupportedStateVersionError extends Error {
  override readonly name = 'UnsupportedStateVersionError';

  constructor(readonly foundVersion: number) {
    super(`共享状态版本 ${foundVersion} 由更高版本的 My Bookmark 写入，请升级扩展后再使用`);
  }
}

export function parseSharedState(value: unknown): SharedStateV1 {
  if (isObject(value) && isNonNegativeInteger(value.version) && value.version > 1) {
    throw new UnsupportedStateVersionError(value.version);
  }
  if (!isObject(value) || value.version !== 1
    || !isNonNegativeInteger(value.clock) || !isNonNegativeInteger(value.syncGeneration)) {
    throw new Error('共享状态格式错误');
  }
  return {
    version: 1,
    clock: value.clock,
    syncGeneration: value.syncGeneration,
    bookmarks: parseRecordMap(value.bookmarks, isBookmark),
    folders: parseRecordMap(value.folders, isBookmarkFolder),
    positions: parseRecordMap(value.positions, isBookmarkPosition),
  };
}

export function compareSharedStates(left: SharedStateV1, right: SharedStateV1): boolean {
  return serializeSharedState(left) === serializeSharedState(right);
}

/**
 * 序列化时固定 key 顺序，使内容等价的状态得到逐字节相同的结果——写入前的变更判定与
 * 同步前的「是否需要发布」判定都依赖这一点。
 */
export function serializeSharedState(state: SharedStateV1): string {
  return JSON.stringify({
    ...state,
    bookmarks: sortRecordMap(state.bookmarks),
    folders: sortRecordMap(state.folders),
    positions: sortRecordMap(state.positions),
  });
}

/** 清理过期墓碑。只应在已持有写锁时调用。 */
export function collectTombstones(state: SharedStateV1, now: number): boolean {
  let changed = false;
  for (const records of [state.bookmarks, state.folders, state.positions]) {
    for (const [key, record] of Object.entries(records)) {
      if (!record.deleted) continue;
      // 缺少 deletedAt 的墓碑来自更早的写入，补一个时间戳而不是立刻回收。
      if (record.deletedAt === undefined) {
        records[key] = { ...record, deletedAt: now };
        changed = true;
        continue;
      }
      if (now - record.deletedAt < TOMBSTONE_RETENTION_MS) continue;
      delete records[key];
      changed = true;
    }
  }
  return changed;
}

function materialize<T>(records: Record<string, VersionedRecord<T>>): T[] {
  // 必须返回深拷贝：调用方原地修改会污染内部状态，并让写入时的序列化判等误认为「无变化」。
  return Object.values(records).flatMap((record) => (
    record.deleted || record.value === undefined ? [] : [structuredClone(record.value)]
  ));
}

function mergeRecordMaps<T>(
  left: Record<string, VersionedRecord<T>>,
  right: Record<string, VersionedRecord<T>>,
): Record<string, VersionedRecord<T>> {
  const result = emptyRecordMap<T>();
  Object.assign(result, left);
  for (const [key, candidate] of Object.entries(right)) {
    const current = result[key];
    if (current === undefined || compareRecord(candidate, current) > 0) result[key] = candidate;
  }
  return result;
}

function compareRecord<T>(left: VersionedRecord<T>, right: VersionedRecord<T>): number {
  if (left.revision !== right.revision) return left.revision - right.revision;
  // 用 ASCII 比较而不是 localeCompare：不同设备的 ICU 排序结果可能不同，
  // 那会让两端对同一冲突得出不同的赢家，形成永不收敛的分歧。
  return left.deviceId < right.deviceId ? -1 : left.deviceId > right.deviceId ? 1 : 0;
}

function sortRecordMap<T>(records: Record<string, VersionedRecord<T>>): Record<string, VersionedRecord<T>> {
  return Object.fromEntries(
    Object.entries(records).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );
}

/**
 * 共享文件在本机可被编辑，远端记录来自 Settings Sync，两者都不可信。
 * 记录骨架非法时整体拒绝；单条记录内容非法时跳过该条，避免一条脏数据拖垮全部书签。
 */
function parseRecordMap<T>(value: unknown, isValidValue: (candidate: unknown) => boolean): Record<string, VersionedRecord<T>> {
  if (value === undefined) return emptyRecordMap();
  if (!isObject(value)) throw new Error('共享状态记录格式错误');
  const result = emptyRecordMap<T>();
  for (const [key, record] of Object.entries(value)) {
    if (!isObject(record)
      || !isNonNegativeInteger(record.revision)
      || typeof record.deviceId !== 'string'
      || (record.deleted !== true && !Object.hasOwn(record, 'value'))) {
      throw new Error(`共享状态记录格式错误：${key}`);
    }
    if (record.deleted !== true && !isValidValue(record.value)) continue;
    result[key] = {
      revision: record.revision,
      deviceId: record.deviceId,
      ...(record.deleted === true
        ? { deleted: true as const, ...(isNonNegativeInteger(record.deletedAt) ? { deletedAt: record.deletedAt } : {}) }
        : { value: record.value as T }),
    };
  }
  return result;
}

/**
 * 记录表一律用无原型对象承载：记录键来自共享文件与远端同步，`__proto__` 这类键直接
 * 赋值到普通对象上会被当成原型设置而静默丢失，甚至改变后续所有取值的行为。
 */
export function emptyRecordMap<T>(): Record<string, VersionedRecord<T>> {
  return Object.create(null) as Record<string, VersionedRecord<T>>;
}

function isObject(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}
