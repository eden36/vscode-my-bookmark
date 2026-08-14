import { watch, type FSWatcher } from 'node:fs';
import { mkdir, open, readFile, rename, rm, stat, writeFile, type FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as vscode from 'vscode';
import type { Bookmark, BookmarkFolder } from './core/model';
import {
  collectTombstones,
  compareSharedStates,
  createEmptySharedState,
  deletedFolderIds,
  emptyRecordMap,
  materializeBookmarks,
  materializeFolders,
  materializePositions,
  mergeSharedStates,
  parseSharedState,
  serializeSharedState,
  UnsupportedStateVersionError,
  type SharedStateV1,
  type SharedStoreChange,
  type VersionedRecord,
} from './shared-state';
import type { SyncManifestV1 } from './sync';

const SYNC_MANIFEST_KEY = 'myBookmark.sync.manifest.v1';
const SYNC_CHUNK_PREFIX = 'myBookmark.sync.chunk.v1.';
// 前缀刻意不用 myBookmark.sync.：这些是每个 Profile 各自的状态，不能被 setKeysForSync 带上云。
const PROFILE_SNAPSHOTS_KEY = 'myBookmark.profile.snapshots.v1';
const PROFILE_APPLIED_RESET_KEY = 'myBookmark.profile.appliedReset.v1';

const STATE_FILE = 'state-v1.json';
const LOCK_FILE = 'state.lock';
const LOCK_STALE_MS = 30_000;
/** 书签操作是前台手势，等待过久等同于「按了没反应」；上层的乐观更新会兜住这段延迟。 */
const LOCK_WAIT_MS = 3_000;
// 重试期间一直持有 state.lock，总退避时间必须明显小于 LOCK_WAIT_MS，否则等锁的窗口会被顶到超时。
const ATOMIC_WRITE_RETRIES = 5;
const ATOMIC_WRITE_RETRY_BASE_MS = 40;
const MAX_SYNC_CHUNKS = 256;
/** 超过此规模意味着每次写入都要重写一个很大的文件，需要提醒用户清理。 */
const RECORD_COUNT_WARNING_THRESHOLD = 20_000;

// 多个窗口同时写入时锁冲突属于可恢复的临时状态，调用方据此重试，不必当作故障提示用户。
export class SharedStateLockBusyError extends Error {
  override readonly name = 'SharedStateLockBusyError';

  constructor(cause?: unknown) {
    super('书签数据正被其他 VS Code 窗口占用，请稍后重试', { cause });
  }
}

export interface StorageServiceOptions {
  directory?: string;
  deviceId?: string;
  appName?: string;
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  watch?: boolean;
  /** 等待共享文件锁的上限，仅供测试缩短等待；生产使用 LOCK_WAIT_MS。 */
  lockWaitMs?: number;
  onWarning?: (message: string) => void;
}

/** 在已持锁、已与磁盘合并的状态上计算变更，避免调用方基于过期快照做决策。 */
export interface SharedStateView {
  bookmarks: Bookmark[];
  folders: BookmarkFolder[];
  positions: Map<string, number>;
  deletedFolderIds: Set<string>;
}

export interface BookmarkMutation {
  upsertBookmarks?: readonly Bookmark[];
  deleteBookmarks?: readonly string[];
  upsertFolders?: readonly BookmarkFolder[];
  deleteFolders?: readonly string[];
  setPositions?: readonly { id: string; line: number }[];
  deletePositions?: readonly string[];
}

interface SyncSnapshotRef {
  snapshotId: string;
  chunkCount: number;
}

export class StorageService implements vscode.Disposable {
  private state = createEmptySharedState();
  private initialized = false;
  private stateWriteQueue: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<(change: SharedStoreChange) => void>();
  private watcher: FSWatcher | undefined;
  private watchTimer: NodeJS.Timeout | undefined;
  private lastSerializedState = '';
  private stateError: string | undefined;
  private watchError: string | undefined;
  private readOnlyReason: string | undefined;
  readonly directory: string;
  readonly deviceId: string;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly options: StorageServiceOptions = {},
  ) {
    const environment = options.environment ?? process.env;
    this.deviceId = options.deviceId ?? vscode.env?.machineId ?? 'unknown-device';
    // 开发模式默认使用按 Profile 隔离的 globalStorage，避免调试污染真实书签；
    // 需要人工验证跨 Profile 行为时用 MY_BOOKMARK_SHARED_DIR 指向一个共享的测试目录。
    this.directory = options.directory
      ?? environment.MY_BOOKMARK_SHARED_DIR
      ?? (context.extensionMode !== undefined
        && context.extensionMode !== vscode.ExtensionMode.Production
        && context.globalStorageUri
        ? path.join(context.globalStorageUri.fsPath, 'shared-state')
        : resolveSharedStorageDirectory(
          options.appName ?? vscode.env?.appName ?? 'Visual Studio Code',
          options.platform ?? process.platform,
          environment,
          options.homeDirectory ?? os.homedir(),
        ));
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const disk = await this.readStateFile(false);
    if (disk) this.state = disk;
    if (!disk && !this.readOnlyReason) {
      try {
        await this.withLock(async () => {
          const lockedDisk = await this.readStateFile(true);
          if (lockedDisk) {
            this.state = lockedDisk;
          } else if (!this.readOnlyReason) {
            this.state = createEmptySharedState();
            await this.writeStateFile(this.state);
          }
        });
      } catch (error) {
        // 首次创建或修复文件时若其他窗口正在写入，不能阻断扩展激活。
        this.stateError = error instanceof Error ? error.message : '书签数据初始化失败';
      }
    }
    this.lastSerializedState = serializeSharedState(this.state);
    this.initialized = true;
    if (this.options.watch !== false) this.startWatcher();
  }

  dispose(): void {
    if (this.watchTimer) clearTimeout(this.watchTimer);
    this.watcher?.close();
    this.listeners.clear();
  }

  onDidChange(listener: (change: SharedStoreChange) => void): vscode.Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  getLastError(): string | undefined {
    return this.readOnlyReason ?? this.stateError ?? this.watchError;
  }

  isReadOnly(): boolean {
    return this.readOnlyReason !== undefined;
  }

  getSharedState(): SharedStateV1 {
    return structuredClone(this.state);
  }

  getSyncGeneration(): number {
    return this.state.syncGeneration;
  }

  getView(): SharedStateView {
    return {
      bookmarks: materializeBookmarks(this.state),
      folders: materializeFolders(this.state),
      positions: materializePositions(this.state),
      deletedFolderIds: deletedFolderIds(this.state),
    };
  }

  /**
   * 批量写入书签与文件夹。
   *
   * build 在已持锁、已与磁盘合并的视图上执行，返回 undefined 表示放弃本次写入。
   * 之所以不接受现成的变更列表：删文件夹这类操作需要基于最新数据决定子项如何安置，
   * 而调用方持有的快照在等待锁的期间可能已经过期。
   */
  async mutate(build: (view: SharedStateView) => BookmarkMutation | undefined): Promise<void> {
    await this.updateSharedState((state) => {
      const mutation = build({
        bookmarks: materializeBookmarks(state),
        folders: materializeFolders(state),
        positions: materializePositions(state),
        deletedFolderIds: deletedFolderIds(state),
      });
      if (mutation === undefined) return;
      for (const bookmark of mutation.upsertBookmarks ?? []) this.writeRecord(state, state.bookmarks, bookmark.id, bookmark);
      for (const id of mutation.deleteBookmarks ?? []) {
        this.deleteRecord(state, state.bookmarks, id);
        // 位置记录依附于书签，书签没了就没有任何东西会再读它。
        this.deleteRecord(state, state.positions, id);
      }
      for (const folder of mutation.upsertFolders ?? []) this.writeRecord(state, state.folders, folder.id, folder);
      for (const id of mutation.deleteFolders ?? []) this.deleteRecord(state, state.folders, id);
      for (const entry of mutation.setPositions ?? []) this.writeRecord(state, state.positions, entry.id, { line: entry.line });
      for (const id of mutation.deletePositions ?? []) this.deleteRecord(state, state.positions, id);
      collectTombstones(state, Date.now());
    });
  }

  /** 文件保存后批量刷新行号。调用方应先比对内存中的值，无变化时根本不要调用。 */
  async updatePositions(entries: readonly { id: string; line: number }[]): Promise<void> {
    if (entries.length === 0) return;
    await this.updateSharedState((state) => {
      for (const entry of entries) {
        // 位置只对仍然存在的书签有意义，否则会给已删除的书签留下一条孤立记录。
        const record = state.bookmarks[entry.id];
        if (record === undefined || record.deleted) continue;
        this.writeRecord(state, state.positions, entry.id, { line: entry.line });
      }
    });
  }

  getSyncManifest(): SyncManifestV1 | undefined {
    return this.context.globalState.get<SyncManifestV1>(SYNC_MANIFEST_KEY);
  }

  getSyncChunk(snapshotId: string, index: number): string | undefined {
    return this.context.globalState.get<string>(this.syncChunkKey(snapshotId, index));
  }

  async saveSyncSnapshot(manifest: SyncManifestV1, chunks: readonly string[]): Promise<void> {
    const previous = this.getLocalSnapshots();
    const current = { snapshotId: manifest.snapshotId, chunkCount: chunks.length };
    // 保留最近两个快照：其他设备可能还在读上一版的分块。
    const retained = [current, ...previous.filter((item) => item.snapshotId !== current.snapshotId)].slice(0, 2);
    // 先按新旧并集注册，保证随后对旧分块的删除动作本身也能同步出去。
    this.registerSyncKeys(manifest, [...previous, current]);
    for (let index = 0; index < chunks.length; index += 1) {
      await this.context.globalState.update(this.syncChunkKey(manifest.snapshotId, index), chunks[index]);
    }
    // manifest 是可见性开关，必须在所有分块写完之后才写。
    await this.context.globalState.update(SYNC_MANIFEST_KEY, manifest);
    await this.context.globalState.update(PROFILE_SNAPSHOTS_KEY, retained);
    for (const stale of previous.filter((item) => !retained.some((kept) => kept.snapshotId === item.snapshotId))) {
      for (let index = 0; index < stale.chunkCount; index += 1) {
        await this.context.globalState.update(this.syncChunkKey(stale.snapshotId, index), undefined);
      }
    }
    this.registerSyncKeys(manifest, retained);
  }

  /**
   * 登记参与 Settings Sync 的键。必须在读取远端分块之前调用：新设备先收到 manifest，
   * 据此登记分块键之后，下一轮同步才会把分块本身带下来。
   */
  registerSyncKeys(manifest = this.getSyncManifest(), snapshots = this.getLocalSnapshots()): void {
    const references = [...toSnapshotRef(manifest), ...snapshots];
    const unique = references.filter((item, index) => (
      references.findIndex((candidate) => candidate.snapshotId === item.snapshotId) === index
    ));
    this.context.globalState.setKeysForSync([
      SYNC_MANIFEST_KEY,
      ...unique.flatMap((item) => Array.from(
        { length: item.chunkCount },
        (_, index) => this.syncChunkKey(item.snapshotId, index),
      )),
    ]);
  }

  getAppliedResetGeneration(): number {
    return this.context.globalState.get<number>(PROFILE_APPLIED_RESET_KEY, 0);
  }

  async saveAppliedResetGeneration(generation: number): Promise<void> {
    await this.context.globalState.update(PROFILE_APPLIED_RESET_KEY, generation);
  }

  async mergeRemoteState(remote: SharedStateV1): Promise<boolean> {
    let changed = false;
    await this.updateSharedState((state) => {
      const merged = mergeSharedStates(state, remote);
      changed = !compareSharedStates(state, merged);
      if (changed) Object.assign(state, merged);
    }, 'remote');
    return changed;
  }

  async incrementSyncGeneration(): Promise<number> {
    let generation = 0;
    await this.updateSharedState((state) => {
      state.syncGeneration += 1;
      generation = state.syncGeneration;
    });
    return generation;
  }

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) await this.initialize();
  }

  private async updateSharedState(
    mutate: (state: SharedStateV1) => void,
    source: SharedStoreChange['source'] = 'local',
  ): Promise<void> {
    await this.enqueueStateWrite(async () => {
      await this.ensureInitialized();
      if (this.readOnlyReason) throw new Error(this.readOnlyReason);
      const changed = await this.withLock(async () => {
        const disk = await this.readStateFile(true);
        if (disk) this.state = mergeSharedStates(this.state, disk);
        const before = serializeSharedState(this.state);
        // 在副本上修改：mutate 中途抛错时内存状态必须保持与磁盘一致，
        // 否则没有落盘的半成品会继续参与后续合并和界面展示。
        const draft = cloneState(this.state);
        mutate(draft);
        const after = serializeSharedState(draft);
        if (after === before) return false;
        await this.writeStateFile(draft);
        this.state = draft;
        this.lastSerializedState = after;
        return true;
      });
      if (changed) this.emitChange(source);
    });
  }

  private writeRecord<T>(
    state: SharedStateV1,
    records: Record<string, VersionedRecord<T>>,
    key: string,
    value: T,
  ): void {
    const current = records[key];
    if (!current?.deleted && current?.value !== undefined
      && JSON.stringify(current.value) === JSON.stringify(value)) return;
    state.clock += 1;
    records[key] = { revision: state.clock, deviceId: this.deviceId, value };
  }

  private deleteRecord<T>(
    state: SharedStateV1,
    records: Record<string, VersionedRecord<T>>,
    key: string,
  ): void {
    const current = records[key];
    if (!current || current.deleted) return;
    state.clock += 1;
    records[key] = { revision: state.clock, deviceId: this.deviceId, deleted: true, deletedAt: Date.now() };
  }

  // preserveCorrupt 只能在已持有文件锁时为 true：重命名目标文件会与其他窗口的写入竞争。
  private async readStateFile(preserveCorrupt: boolean): Promise<SharedStateV1 | undefined> {
    try {
      const content = await readFile(path.join(this.directory, STATE_FILE), 'utf8');
      const state = parseSharedState(JSON.parse(content));
      this.stateError = undefined;
      return state;
    } catch (error) {
      if (isMissingFile(error)) {
        this.stateError = undefined;
        return undefined;
      }
      if (error instanceof UnsupportedStateVersionError) {
        this.readOnlyReason = error.message;
        this.stateError = error.message;
        return undefined;
      }
      this.stateError = error instanceof Error ? error.message : '书签数据读取失败';
      if (preserveCorrupt) await this.preserveCorruptFile(STATE_FILE);
      return undefined;
    }
  }

  private async writeStateFile(state: SharedStateV1): Promise<void> {
    const recordCount = Object.keys(state.bookmarks).length + Object.keys(state.folders).length;
    if (recordCount > RECORD_COUNT_WARNING_THRESHOLD) {
      this.options.onWarning?.(`书签记录数已达 ${recordCount}，每次写入都会重写整个数据文件，建议清理不再使用的书签`);
    }
    // 不做缩进：书签数量可观时，仅缩进就能让文件体积翻倍，而每次写入都是全量重写。
    await this.atomicWrite(STATE_FILE, `${serializeSharedState(state)}\n`);
  }

  private async atomicWrite(fileName: string, content: string): Promise<void> {
    const target = path.join(this.directory, fileName);
    const temporary = path.join(this.directory, `${fileName}.${process.pid}.${Date.now()}.tmp`);
    await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 });
    try {
      await this.commitTemporaryFile(target, temporary);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  // rename 在 Windows 上也是原子替换；EPERM 来自杀软或其他窗口短暂持有句柄，退避重试即可。
  private async commitTemporaryFile(target: string, temporary: string): Promise<void> {
    for (let attempt = 0; attempt < ATOMIC_WRITE_RETRIES; attempt += 1) {
      try {
        await rename(temporary, target);
        return;
      } catch (error) {
        if (!isTransientFileError(error) || attempt >= ATOMIC_WRITE_RETRIES - 1) throw error;
        await sleep(ATOMIC_WRITE_RETRY_BASE_MS * (2 ** attempt) + Math.random() * 30);
      }
    }
    // 正常不可达；重试次数被配置成 0 时也必须报错，不能让调用方以为写入已完成。
    throw new Error('书签数据写入失败：重试次数已用尽');
  }

  private async preserveCorruptFile(fileName: string): Promise<void> {
    const source = path.join(this.directory, fileName);
    const target = path.join(this.directory, `${fileName}.corrupt-${Date.now()}`);
    await rename(source, target).catch(() => undefined);
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const lockPath = path.join(this.directory, LOCK_FILE);
    const lockWaitMs = this.options.lockWaitMs ?? LOCK_WAIT_MS;
    const started = Date.now();
    for (;;) {
      // 只有获取锁本身的 EEXIST 才重试；operation 抛出的同名错误一旦被当作锁冲突，
      // 会在锁已释放的情况下重复执行业务逻辑。
      let handle: FileHandle;
      try {
        handle = await open(lockPath, 'wx', 0o600);
      } catch (error) {
        if (!isFileExists(error)) throw error;
        if (await this.isLockAbandoned(lockPath)) {
          await rm(lockPath, { force: true });
          continue;
        }
        if (Date.now() - started >= lockWaitMs) throw new SharedStateLockBusyError(error);
        // 退避时间加随机抖动，避免多个窗口在同一时刻反复争抢同一把锁。
        await sleep(30 + Math.random() * 50);
        continue;
      }
      try {
        await handle.writeFile(`${Date.now()} ${process.pid}`, 'utf8');
        return await operation();
      } finally {
        await handle.close();
        await rm(lockPath, { force: true });
      }
    }
  }

  // 窗口崩溃或被强制关闭会残留锁文件。只按 mtime 判断要等满 LOCK_STALE_MS，
  // 这段时间内新窗口的写入全部失败，因此锁文件同时记录持有者进程号，用于立即识别已退出的持有者。
  private async isLockAbandoned(lockPath: string): Promise<boolean> {
    const info = await stat(lockPath).catch(() => undefined);
    if (!info) return false;
    if (Date.now() - info.mtimeMs > LOCK_STALE_MS) return true;
    const owner = Number((await readFile(lockPath, 'utf8').catch(() => '')).trim().split(' ')[1]);
    if (!Number.isInteger(owner) || owner <= 0) return false;
    try {
      process.kill(owner, 0);
      return false;
    } catch (error) {
      // EPERM 表示进程存在但无权访问，只有 ESRCH 才能确认持有者已退出。
      return isNodeError(error) && error.code === 'ESRCH';
    }
  }

  private startWatcher(): void {
    this.watcher = watch(this.directory, (_event, fileName) => {
      // 部分平台在合并事件时不提供文件名，此时按可能变化处理，避免漏掉其他 Profile 的写入。
      if (fileName !== null && fileName !== STATE_FILE) return;
      if (this.watchTimer) clearTimeout(this.watchTimer);
      this.watchTimer = setTimeout(() => void this.reloadExternal(), 100);
    });
    this.watcher.on('error', (error) => {
      this.watchError = `书签数据监听失败：${error.message}`;
    });
  }

  private async reloadExternal(): Promise<void> {
    await this.enqueueStateWrite(async () => {
      const disk = await this.readStateFile(false);
      if (!disk || serializeSharedState(disk) === this.lastSerializedState) return;
      const merged = mergeSharedStates(this.state, disk);
      const changed = !compareSharedStates(this.state, merged);
      this.state = merged;
      this.lastSerializedState = serializeSharedState(merged);
      if (changed) this.emitChange('external');
    });
  }

  private emitChange(source: SharedStoreChange['source']): void {
    const change = { source, revision: this.state.clock } satisfies SharedStoreChange;
    for (const listener of this.listeners) listener(change);
  }

  private getLocalSnapshots(): SyncSnapshotRef[] {
    const value = this.context.globalState.get<unknown>(PROFILE_SNAPSHOTS_KEY);
    if (!Array.isArray(value)) return [];
    return value.flatMap((item) => {
      if (!item || typeof item !== 'object') return [];
      const candidate = item as Partial<SyncSnapshotRef>;
      return typeof candidate.snapshotId === 'string'
        && Number.isInteger(candidate.chunkCount)
        && Number(candidate.chunkCount) >= 0
        && Number(candidate.chunkCount) <= MAX_SYNC_CHUNKS
        ? [{ snapshotId: candidate.snapshotId, chunkCount: Number(candidate.chunkCount) }]
        : [];
    });
  }

  private syncChunkKey(snapshotId: string, index: number): string {
    return `${SYNC_CHUNK_PREFIX}${snapshotId}.${index}`;
  }

  private enqueueStateWrite<T>(operation: () => PromiseLike<T>): Promise<T> {
    const result = this.stateWriteQueue.then(operation);
    this.stateWriteQueue = result.then(() => undefined, () => undefined);
    return result;
  }
}

export function resolveSharedStorageDirectory(
  appName: string,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
  homeDirectory: string,
): string {
  const variant = appName.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/-+/g, '-') || 'vscode';
  if (platform === 'win32') {
    return path.join(environment.APPDATA || path.join(homeDirectory, 'AppData', 'Roaming'), 'My Bookmark', variant);
  }
  if (platform === 'darwin') {
    return path.join(homeDirectory, 'Library', 'Application Support', 'My Bookmark', variant);
  }
  return path.join(environment.XDG_CONFIG_HOME || path.join(homeDirectory, '.config'), 'my-bookmark', variant);
}

/**
 * structuredClone 会把记录表还原成带原型的普通对象，而记录键来自不可信来源。
 * 克隆后必须把三张表重建为无原型对象，否则 `__proto__` 之类的键会被当作原型赋值。
 */
function cloneState(state: SharedStateV1): SharedStateV1 {
  const draft = structuredClone(state);
  draft.bookmarks = Object.assign(emptyRecordMap<Bookmark>(), draft.bookmarks);
  draft.folders = Object.assign(emptyRecordMap<BookmarkFolder>(), draft.folders);
  draft.positions = Object.assign(emptyRecordMap<{ line: number }>(), draft.positions);
  return draft;
}

function toSnapshotRef(manifest: SyncManifestV1 | undefined): SyncSnapshotRef[] {
  return manifest !== undefined
    && typeof manifest.snapshotId === 'string'
    && /^[a-zA-Z0-9-]{1,80}$/.test(manifest.snapshotId)
    && Number.isInteger(manifest.chunkCount)
    && manifest.chunkCount >= 0
    && manifest.chunkCount <= MAX_SYNC_CHUNKS
    ? [{ snapshotId: manifest.snapshotId, chunkCount: manifest.chunkCount }]
    : [];
}

function isMissingFile(error: unknown): boolean {
  return isNodeError(error) && error.code === 'ENOENT';
}

function isFileExists(error: unknown): boolean {
  return isNodeError(error) && error.code === 'EEXIST';
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

// 不含 EACCES：那通常是目录不可写或文件只读等持久性权限问题，重试只会白白拖长持锁时间。
function isTransientFileError(error: unknown): boolean {
  return isNodeError(error) && (error.code === 'EPERM' || error.code === 'EBUSY');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
