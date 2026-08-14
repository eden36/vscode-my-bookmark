import { createHash, randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { deflateRaw as deflateRawCallback, inflateRaw as inflateRawCallback } from 'node:zlib';
import {
  createEmptySharedState,
  parseSharedState,
  serializeSharedState,
  type SharedStateV1,
} from './shared-state';

/**
 * 跨设备同步的编解码层。
 *
 * 本机的跨窗口、跨 Profile 共享由共享状态文件负责；跨设备则把整份状态压缩后切成分块，
 * 塞进 globalState 并用 setKeysForSync 交给 VS Code 官方的 Settings Sync 搬运。
 */

const deflateRaw = promisify(deflateRawCallback);
const inflateRaw = promisify(inflateRawCallback);

/** 作用在 base64 字符串上的分块大小。 */
export const CHUNK_SIZE = 48 * 1024;
export const MAX_SYNC_CHUNKS = 256;
const MANIFEST_VERSION = 1;
const SNAPSHOT_ID_PATTERN = /^[a-zA-Z0-9-]{1,80}$/;

export interface SyncManifestV1 {
  version: 1;
  generation: number;
  updatedAt: number;
  snapshotId: string;
  chunkCount: number;
  encoding: 'deflate-raw-base64';
  /** 压缩后二进制的 sha256，可在解压之前完成校验。 */
  checksum: string;
  /** 重置广播：接收方清空本地数据而不是合并。 */
  reset?: true;
}

export async function encodeSharedState(
  state: SharedStateV1,
  snapshotId: string = randomUUID(),
): Promise<{ manifest: SyncManifestV1; chunks: string[] }> {
  const compressed = await deflateRaw(Buffer.from(serializeSharedState(state), 'utf8'));
  const payload = compressed.toString('base64');
  const chunks = Array.from(
    { length: Math.ceil(payload.length / CHUNK_SIZE) },
    (_, index) => payload.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE),
  );
  if (chunks.length > MAX_SYNC_CHUNKS) throw new Error('书签数据过大，无法通过设置同步传输');
  return {
    manifest: {
      version: MANIFEST_VERSION,
      generation: state.syncGeneration,
      updatedAt: Date.now(),
      snapshotId,
      chunkCount: chunks.length,
      encoding: 'deflate-raw-base64',
      checksum: createHash('sha256').update(compressed).digest('hex'),
    },
    chunks,
  };
}

export async function decodeSharedState(
  manifest: SyncManifestV1,
  chunks: readonly string[],
): Promise<SharedStateV1> {
  validateManifest(manifest);
  if (manifest.reset) return { ...createEmptySharedState(), syncGeneration: manifest.generation };
  if (chunks.length !== manifest.chunkCount || chunks.some((chunk) => typeof chunk !== 'string')) {
    throw new Error('同步数据分块不完整');
  }
  const compressed = Buffer.from(chunks.join(''), 'base64');
  if (createHash('sha256').update(compressed).digest('hex') !== manifest.checksum) {
    throw new Error('同步数据校验失败');
  }
  return parseSharedState(JSON.parse((await inflateRaw(compressed)).toString('utf8')));
}

/** manifest 来自云端，属于不可信输入，且 snapshotId 会被拼进 globalState 的键。 */
export function validateManifest(manifest: SyncManifestV1): void {
  if (manifest.version !== MANIFEST_VERSION) throw new Error(`不支持的同步数据版本：${manifest.version}`);
  if (manifest.encoding !== 'deflate-raw-base64') throw new Error('不支持的同步数据编码');
  if (!SNAPSHOT_ID_PATTERN.test(manifest.snapshotId)) throw new Error('同步数据标识非法');
  if (!Number.isInteger(manifest.chunkCount) || manifest.chunkCount < 0 || manifest.chunkCount > MAX_SYNC_CHUNKS) {
    throw new Error('同步数据分块数非法');
  }
  if (!Number.isInteger(manifest.generation) || manifest.generation < 0) throw new Error('同步数据代次非法');
  if (typeof manifest.checksum !== 'string' || manifest.checksum.length === 0) throw new Error('同步数据校验值缺失');
}

/** 用 \0 分隔以避免拼接歧义；作为「这份快照是否已应用过」的幂等判据。 */
export function manifestKey(manifest: SyncManifestV1): string {
  return `${manifest.generation}\0${manifest.snapshotId}\0${manifest.checksum}`;
}

/**
 * 发布前净化状态。
 *
 * 剔除整张 positions：两台设备可能停在不同的分支上，同一书签的行号本就不同，同步它
 * 等于用最后写入者胜出把一边的行号强加给另一边，而且会形成永不收敛的来回覆盖——
 * A 打开文件重锚定，同步给 B，B 打开文件又重锚定回来。行号由各设备本地重锚定得出即可。
 *
 * clock 必须跟着重算，否则内容相同的两次发布会因为 clock 不同而被判为「有变化」，
 * 每一轮轮询都会向云端推一份新快照。
 */
export function syncPayloadState(state: SharedStateV1): SharedStateV1 {
  const payload: SharedStateV1 = { ...state, positions: {} };
  const clock = [payload.bookmarks, payload.folders]
    .flatMap((records) => Object.values(records))
    .reduce((max, record) => Math.max(max, record.revision), 0);
  return { ...payload, clock };
}

/**
 * 定时轮询。
 *
 * 只能轮询，不能监听：Settings Sync 把 globalState 同步下来时不会触发任何 VS Code 事件。
 */
export function startSyncPolling(
  run: () => Promise<void>,
  onError: (error: unknown) => void,
  intervalMs: number,
): { dispose(): void } {
  let running = false;
  const timer = setInterval(() => {
    // 上一轮还没跑完就跳过这一拍，避免慢速网络下堆叠出多个并发的同步流程。
    if (running) return;
    running = true;
    void run().catch(onError).finally(() => { running = false; });
  }, intervalMs);
  return { dispose: () => clearInterval(timer) };
}

/** 连续多少轮拿不到新分块才判定为失败。 */
export const INCOMPLETE_CHUNK_ATTEMPTS = 3;
/** 连续失败多少次才把错误显示给用户。 */
export const FAILURE_REPORT_THRESHOLD = 3;
/** 本地变更后合并发布的等待时间。 */
export const PUBLISH_DEBOUNCE_MS = 5_000;

const INCOMPLETE_CHUNK_ERROR = '同步数据尚未接收完整，正在等待';

/** SyncService 依赖的存储能力，单独声明以便脱离 VS Code 单测。 */
export interface SyncStorage {
  getSharedState(): SharedStateV1;
  getSyncGeneration(): number;
  getSyncManifest(): SyncManifestV1 | undefined;
  getSyncChunk(snapshotId: string, index: number): string | undefined;
  saveSyncSnapshot(manifest: SyncManifestV1, chunks: readonly string[]): Promise<void>;
  registerSyncKeys(manifest?: SyncManifestV1): void;
  mergeRemoteState(remote: SharedStateV1): Promise<boolean>;
  getAppliedResetGeneration(): number;
  saveAppliedResetGeneration(generation: number): Promise<void>;
}

export interface SyncStatus {
  lastError: string | undefined;
  lastSyncedAt: number | undefined;
}

export class SyncService {
  private queue: Promise<void> = Promise.resolve();
  private lastPublishedState = '';
  private lastAppliedManifest = '';
  private consecutiveFailures = 0;
  private lastError: string | undefined;
  private lastSyncedAt: number | undefined;
  private pendingManifestKey: string | undefined;
  private pendingChunkAttempts = 0;
  private pendingChunkArrived = 0;
  private publishTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly storage: SyncStorage,
    private readonly log: (message: string) => void = () => undefined,
    /** 合并发布的等待时间，仅供测试缩短；生产使用 PUBLISH_DEBOUNCE_MS。 */
    private readonly publishDebounceMs: number = PUBLISH_DEBOUNCE_MS,
  ) {
    // 必须在构造期就登记同步键，否则首轮轮询之前到达的远端分块不会被拉下来。
    this.storage.registerSyncKeys();
  }

  dispose(): void {
    if (this.publishTimer) clearTimeout(this.publishTimer);
  }

  getStatus(): SyncStatus {
    return { lastError: this.lastError, lastSyncedAt: this.lastSyncedAt };
  }

  async reconcile(): Promise<void> {
    await this.enqueue(() => this.synchronize());
  }

  /**
   * 本地有变更，稍后合并发布。
   *
   * 每次发布都会重写全部分块，而书签是秒级的交互；连着加十个书签若逐次发布，
   * 就是往云端推十份完整快照。
   */
  schedulePublish(): void {
    if (this.publishTimer) clearTimeout(this.publishTimer);
    this.publishTimer = setTimeout(() => {
      this.publishTimer = undefined;
      void this.enqueue(() => this.publishState()).catch(() => undefined);
    }, this.publishDebounceMs);
  }

  private async synchronize(): Promise<void> {
    try {
      await this.applyRemoteState();
      await this.publishState();
      this.consecutiveFailures = 0;
      this.lastError = undefined;
      this.lastSyncedAt = Date.now();
    } catch (error) {
      const message = error instanceof Error ? error.message : '同步失败';
      if (message === INCOMPLETE_CHUNK_ERROR) {
        this.lastError = message;
        return;
      }
      this.consecutiveFailures += 1;
      // Settings Sync 的传播存在延迟，瞬时不一致很常见；连续失败才值得打扰用户。
      if (this.consecutiveFailures >= FAILURE_REPORT_THRESHOLD) this.lastError = message;
      this.log(`同步失败 次数=${this.consecutiveFailures} 类别=${error instanceof Error ? error.name : 'unknown'}`);
    }
  }

  private async applyRemoteState(): Promise<void> {
    const manifest = this.storage.getSyncManifest();
    if (manifest === undefined) return;
    validateManifest(manifest);
    // 登记必须发生在读取分块之前：新设备先收到 manifest，据此登记后下一轮才拿得到分块。
    this.storage.registerSyncKeys(manifest);
    if (manifest.generation < this.storage.getSyncGeneration()) return;

    const key = manifestKey(manifest);
    if (key === this.lastAppliedManifest) return;

    const chunks = Array.from(
      { length: manifest.chunkCount },
      (_, index) => this.storage.getSyncChunk(manifest.snapshotId, index),
    );
    if (chunks.some((chunk) => chunk === undefined)) {
      this.notePendingChunks(key, chunks.filter((chunk) => chunk !== undefined).length);
      return;
    }
    this.clearPendingChunks();

    const remote = await decodeSharedState(manifest, chunks as string[]);
    if (manifest.reset && manifest.generation <= this.storage.getAppliedResetGeneration()) {
      this.lastAppliedManifest = key;
      return;
    }
    await this.storage.mergeRemoteState(remote);
    if (manifest.reset) await this.storage.saveAppliedResetGeneration(manifest.generation);
    this.lastAppliedManifest = key;
    // 刚拉下来的内容就是当前应发布的内容，否则下一步会把它原样再推回去。
    this.lastPublishedState = serializeSharedState(syncPayloadState(remote));
  }

  private async publishState(): Promise<void> {
    const state = syncPayloadState(this.storage.getSharedState());
    const serialized = serializeSharedState(state);
    const current = this.storage.getSyncManifest();
    if (serialized === this.lastPublishedState
      && current?.generation === state.syncGeneration
      && current.reset !== true) return;

    const { manifest, chunks } = await encodeSharedState(state);
    await this.storage.saveSyncSnapshot(manifest, chunks);
    this.lastPublishedState = serialized;
    this.lastAppliedManifest = manifestKey(manifest);
  }

  /** 分块可能分批到达，只有连续多轮毫无进展才算真的失败。 */
  private notePendingChunks(key: string, arrived: number): void {
    if (this.pendingManifestKey !== key) {
      this.pendingManifestKey = key;
      this.pendingChunkArrived = arrived;
      this.pendingChunkAttempts = 1;
      throw new Error(INCOMPLETE_CHUNK_ERROR);
    }
    if (arrived > this.pendingChunkArrived) {
      this.pendingChunkArrived = arrived;
      this.pendingChunkAttempts = 0;
      throw new Error(INCOMPLETE_CHUNK_ERROR);
    }
    this.pendingChunkAttempts += 1;
    if (this.pendingChunkAttempts >= INCOMPLETE_CHUNK_ATTEMPTS) throw new Error('同步数据分块始终不完整，请检查设置同步是否正常');
    throw new Error(INCOMPLETE_CHUNK_ERROR);
  }

  private clearPendingChunks(): void {
    this.pendingManifestKey = undefined;
    this.pendingChunkAttempts = 0;
    this.pendingChunkArrived = 0;
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.queue.then(operation);
    // 队列自身吞掉错误，避免一次失败毒化后续所有操作；调用方仍会拿到 reject。
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}
