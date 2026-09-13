import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { deflateRaw as deflateRawCallback, inflateRaw as inflateRawCallback } from 'node:zlib';
import {
  createEmptySharedState,
  emptyRecordMap,
  parseSharedState,
  serializeSharedState,
  type SharedStateV1,
  type VersionedRecord,
} from './shared-state';

/**
 * 跨设备同步的编解码层。
 *
 * 每条记录按「类型 + id」稳定分到固定桶，桶单独压缩与写入。这样改动一条书签通常只会
 * 重写一个同步键；Settings Sync 仍会决定其底层资源如何上传，因此不承诺网络字节增量。
 */

const deflateRaw = promisify(deflateRawCallback);
const inflateRaw = promisify(inflateRawCallback);

/** 每个桶的 base64 载荷上限。 */
export const CHUNK_SIZE = 48 * 1024;
/** 固定桶数，构造期一次性登记，避免动态同步键的两阶段传播。 */
export const SYNC_BUCKET_COUNT = 256;
/** V1 遗留快照的分块总数上限。 */
export const MAX_SYNC_CHUNKS = 256;
const MANIFEST_VERSION = 3;
const SNAPSHOT_ID_PATTERN = /^[a-zA-Z0-9-]{1,80}$/;

export interface SyncManifestV1 {
  version: 1;
  generation: number;
  updatedAt: number;
  snapshotId: string;
  chunkCount: number;
  encoding: 'deflate-raw-base64';
  checksum: string;
  reset?: true;
}

export interface SyncManifestV3 {
  version: 3;
  generation: number;
  bucketCount: number;
  updatedAt: number;
}

export interface SyncBucketV3 {
  version: 3;
  generation: number;
  bucket: number;
  payload: string;
  encoding: 'deflate-raw-base64';
  checksum: string;
}

export async function encodeSyncBucket(
  state: SharedStateV1,
  bucket: number,
): Promise<SyncBucketV3> {
  const compressed = await deflateRaw(Buffer.from(serializeSharedState(state), 'utf8'));
  const payload = compressed.toString('base64');
  if (payload.length > CHUNK_SIZE) throw new Error(`同步数据桶 ${bucket} 过大，请缩短备注或拆分书签`);
  return {
    version: MANIFEST_VERSION,
    generation: state.syncGeneration,
    bucket,
    payload,
    encoding: 'deflate-raw-base64',
    checksum: createHash('sha256').update(compressed).digest('hex'),
  };
}

export async function decodeSyncBucket(bucket: SyncBucketV3): Promise<SharedStateV1> {
  validateSyncBucket(bucket);
  const state = await decodeCompressedState(bucket.payload, bucket.checksum);
  if (state.syncGeneration !== bucket.generation) throw new Error('同步数据桶代次不一致');
  // 即使远端伪造 positions，也不能让它跨设备覆盖本机行号。
  return syncPayloadState(state);
}

/** 解码已发布的 V1 分块快照，仅用于首次迁移。 */
export async function decodeLegacySharedState(
  manifest: SyncManifestV1,
  chunks: readonly string[],
): Promise<SharedStateV1> {
  validateLegacyManifest(manifest);
  if (manifest.reset) return { ...createEmptySharedState(), syncGeneration: manifest.generation };
  if (chunks.length !== manifest.chunkCount || chunks.some((chunk) => typeof chunk !== 'string')) {
    throw new Error('同步数据分块不完整');
  }
  return syncPayloadState(await decodeCompressedState(chunks.join(''), manifest.checksum));
}

/** manifest 与桶均来自云端，必须完整校验。 */
export function validateSyncManifest(manifest: SyncManifestV3): void {
  if (manifest.version !== MANIFEST_VERSION) throw new Error(`不支持的同步数据版本：${manifest.version}`);
  if (!Number.isInteger(manifest.generation) || manifest.generation < 0) throw new Error('同步数据代次非法');
  if (manifest.bucketCount !== SYNC_BUCKET_COUNT) throw new Error('同步数据桶数量非法');
  if (!Number.isInteger(manifest.updatedAt) || manifest.updatedAt < 0) throw new Error('同步数据更新时间非法');
}

export function validateSyncBucket(bucket: SyncBucketV3): void {
  if (bucket.version !== MANIFEST_VERSION) throw new Error(`不支持的同步数据版本：${bucket.version}`);
  if (!Number.isInteger(bucket.generation) || bucket.generation < 0) throw new Error('同步数据代次非法');
  if (!Number.isInteger(bucket.bucket) || bucket.bucket < 0 || bucket.bucket >= SYNC_BUCKET_COUNT) {
    throw new Error('同步数据桶编号非法');
  }
  if (bucket.encoding !== 'deflate-raw-base64') throw new Error('不支持的同步数据编码');
  if (typeof bucket.payload !== 'string' || bucket.payload.length === 0) throw new Error('同步数据载荷缺失');
  if (bucket.payload.length > CHUNK_SIZE) throw new Error('同步数据桶过大');
  if (typeof bucket.checksum !== 'string' || bucket.checksum.length === 0) throw new Error('同步数据校验值缺失');
}

export function validateLegacyManifest(manifest: SyncManifestV1): void {
  if (manifest.version !== 1) throw new Error(`不支持的同步数据版本：${manifest.version}`);
  if (manifest.encoding !== 'deflate-raw-base64') throw new Error('不支持的同步数据编码');
  if (!SNAPSHOT_ID_PATTERN.test(manifest.snapshotId)) throw new Error('同步数据标识非法');
  if (!Number.isInteger(manifest.chunkCount) || manifest.chunkCount < 0 || manifest.chunkCount > MAX_SYNC_CHUNKS) {
    throw new Error('同步数据分块数非法');
  }
  if (!Number.isInteger(manifest.generation) || manifest.generation < 0) throw new Error('同步数据代次非法');
  if (typeof manifest.checksum !== 'string' || manifest.checksum.length === 0) throw new Error('同步数据校验值缺失');
}

/** 记录类型必须参与哈希，避免同 id 的文件夹和书签被强制落入同一桶。 */
export function syncBucketIndex(kind: 'bookmark' | 'folder', id: string): number {
  let hash = 0x811c9dc5;
  for (const char of `${kind}\0${id}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % SYNC_BUCKET_COUNT;
}

/** 将不参与跨设备同步的 positions 剔除，并重算逻辑时钟。 */
export function syncPayloadState(state: SharedStateV1): SharedStateV1 {
  const payload: SharedStateV1 = { ...state, positions: emptyRecordMap() };
  const clock = [payload.bookmarks, payload.folders]
    .flatMap((records) => Object.values(records))
    .reduce((max, record) => Math.max(max, record.revision), 0);
  return { ...payload, clock };
}

/** 把完整同步状态拆为固定桶；墓碑和正常记录必须落在同一稳定桶。 */
export function splitSyncState(state: SharedStateV1): SharedStateV1[] {
  const buckets = Array.from({ length: SYNC_BUCKET_COUNT }, () => ({
    ...createEmptySharedState(),
    syncGeneration: state.syncGeneration,
  }));
  for (const [id, record] of Object.entries(state.bookmarks)) {
    buckets[syncBucketIndex('bookmark', id)]!.bookmarks[id] = record;
  }
  for (const [id, record] of Object.entries(state.folders)) {
    buckets[syncBucketIndex('folder', id)]!.folders[id] = record;
  }
  for (const bucket of buckets) {
    bucket.clock = maxRevision(bucket.bookmarks, bucket.folders);
  }
  return buckets;
}

/** 仅轮询，不监听：Settings Sync 下发 globalState 时不会触发扩展事件。 */
export function startSyncPolling(
  run: () => Promise<void>,
  onError: (error: unknown) => void,
  intervalMs: number,
): { dispose(): void } {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    void run().catch(onError).finally(() => { running = false; });
  }, intervalMs);
  return { dispose: () => clearInterval(timer) };
}

export const FAILURE_REPORT_THRESHOLD = 3;
export const PUBLISH_DEBOUNCE_MS = 5_000;
export const INCOMPLETE_CHUNK_ATTEMPTS = 3;

const INCOMPLETE_CHUNK_ERROR = '同步数据尚未接收完整，正在等待';

export interface SyncStorage {
  getSharedState(): SharedStateV1;
  getSyncGeneration(): number;
  getSyncManifest(): SyncManifestV3 | undefined;
  getSyncBucket(index: number): SyncBucketV3 | undefined;
  getLegacySyncManifest(): SyncManifestV1 | undefined;
  getLegacySyncChunk(snapshotId: string, index: number): string | undefined;
  saveSyncBuckets(buckets: readonly SyncBucketV3[]): Promise<void>;
  saveSyncManifest(manifest: SyncManifestV3): Promise<void>;
  clearLegacySyncSnapshot(manifest: SyncManifestV1): Promise<void>;
  registerSyncKeys(): void;
  mergeRemoteState(remote: SharedStateV1): Promise<boolean>;
  resetRemoteState(generation: number): Promise<void>;
}

export interface SyncStatus {
  lastError: string | undefined;
  lastSyncedAt: number | undefined;
}

export class SyncService {
  private queue: Promise<void> = Promise.resolve();
  private lastPublishedState = '';
  private readonly lastPublishedBuckets = Array<string>(SYNC_BUCKET_COUNT).fill('');
  private readonly lastAppliedBuckets = Array<string>(SYNC_BUCKET_COUNT).fill('');
  private consecutiveFailures = 0;
  private lastError: string | undefined;
  private lastSyncedAt: number | undefined;
  private pendingLegacyManifestKey: string | undefined;
  private pendingLegacyChunkAttempts = 0;
  private pendingLegacyChunkArrived = 0;
  private pendingLegacyCleanup: SyncManifestV1 | undefined;
  private publishTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly storage: SyncStorage,
    private readonly log: (message: string) => void = () => undefined,
    /** 合并发布的等待时间，仅供测试缩短；生产使用 PUBLISH_DEBOUNCE_MS。 */
    private readonly publishDebounceMs: number = PUBLISH_DEBOUNCE_MS,
  ) {
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
      if (this.consecutiveFailures >= FAILURE_REPORT_THRESHOLD) this.lastError = message;
      this.log(`同步失败 次数=${this.consecutiveFailures} 类别=${error instanceof Error ? error.name : 'unknown'}`);
    }
  }

  private async applyRemoteState(): Promise<void> {
    const manifest = this.storage.getSyncManifest();
    if (manifest === undefined) {
      await this.applyLegacyRemoteState();
      return;
    }
    validateSyncManifest(manifest);
    if (manifest.generation < this.storage.getSyncGeneration()) return;
    if (manifest.generation > this.storage.getSyncGeneration()) await this.storage.resetRemoteState(manifest.generation);

    const buckets = Array.from({ length: SYNC_BUCKET_COUNT }, (_, index) => this.storage.getSyncBucket(index));
    if (buckets.some((bucket) => bucket === undefined)) throw new Error(INCOMPLETE_CHUNK_ERROR);

    const remote = { ...createEmptySharedState(), syncGeneration: manifest.generation };
    let changed = false;
    for (const bucket of buckets as SyncBucketV3[]) {
      validateSyncBucket(bucket);
      if (bucket.generation !== manifest.generation || bucket.bucket < 0 || bucket.bucket >= SYNC_BUCKET_COUNT) {
        throw new Error('同步数据桶与控制信息不一致');
      }
      const key = bucketKey(bucket);
      if (key === this.lastAppliedBuckets[bucket.bucket]) continue;
      const decoded = await decodeSyncBucket(bucket);
      Object.assign(remote.bookmarks, decoded.bookmarks);
      Object.assign(remote.folders, decoded.folders);
      remote.clock = Math.max(remote.clock, decoded.clock);
      this.lastAppliedBuckets[bucket.bucket] = key;
      this.lastPublishedBuckets[bucket.bucket] = serializeSharedState(decoded);
      changed = true;
    }
    if (changed) {
      await this.storage.mergeRemoteState(remote);
      this.lastPublishedState = '';
    }
    await this.clearResurrectedLegacySnapshot();
  }

  private async applyLegacyRemoteState(): Promise<void> {
    const manifest = this.storage.getLegacySyncManifest();
    if (manifest === undefined) return;
    validateLegacyManifest(manifest);
    this.storage.registerSyncKeys();
    if (manifest.generation < this.storage.getSyncGeneration()) return;

    const key = `${manifest.generation}\0${manifest.snapshotId}\0${manifest.checksum}`;
    if (key === this.pendingLegacyManifestKey && this.pendingLegacyCleanup !== undefined) return;
    const chunks = Array.from(
      { length: manifest.chunkCount },
      (_, index) => this.storage.getLegacySyncChunk(manifest.snapshotId, index),
    );
    if (chunks.some((chunk) => chunk === undefined)) {
      this.notePendingLegacyChunks(key, chunks.filter((chunk) => chunk !== undefined).length);
      return;
    }
    this.clearPendingLegacyChunks();
    if (manifest.generation > this.storage.getSyncGeneration()) await this.storage.resetRemoteState(manifest.generation);
    await this.storage.mergeRemoteState(await decodeLegacySharedState(manifest, chunks as string[]));
    this.pendingLegacyCleanup = manifest;
    this.pendingLegacyManifestKey = key;
    this.lastPublishedState = '';
  }

  private async clearResurrectedLegacySnapshot(): Promise<void> {
    const legacy = this.storage.getLegacySyncManifest();
    if (legacy === undefined) return;
    validateLegacyManifest(legacy);
    await this.storage.clearLegacySyncSnapshot(legacy);
  }

  private async publishState(): Promise<void> {
    const state = syncPayloadState(this.storage.getSharedState());
    const serialized = serializeSharedState(state);
    const manifest = this.storage.getSyncManifest();
    const needsInitialPublish = manifest === undefined && this.pendingLegacyCleanup !== undefined;
    const hasRecords = Object.keys(state.bookmarks).length > 0 || Object.keys(state.folders).length > 0;
    if (!needsInitialPublish && !hasRecords && manifest === undefined) return;
    if (serialized === this.lastPublishedState && manifest?.generation === state.syncGeneration) return;

    const forceAll = manifest === undefined || manifest.generation !== state.syncGeneration;
    const buckets = splitSyncState(state);
    const bucketStates = buckets.map((bucket) => serializeSharedState(bucket));
    const changed = await Promise.all(buckets.flatMap((bucket, index) => (
      forceAll || bucketStates[index] !== this.lastPublishedBuckets[index]
        ? [encodeSyncBucket(bucket, index)]
        : []
    )));
    if (changed.length > 0) await this.storage.saveSyncBuckets(changed);
    for (const bucket of changed) {
      this.lastAppliedBuckets[bucket.bucket] = bucketKey(bucket);
      this.lastPublishedBuckets[bucket.bucket] = bucketStates[bucket.bucket]!;
    }
    if (forceAll) {
      await this.storage.saveSyncManifest({
        version: MANIFEST_VERSION,
        generation: state.syncGeneration,
        bucketCount: SYNC_BUCKET_COUNT,
        updatedAt: Date.now(),
      });
    }
    this.lastPublishedState = serialized;
    if (this.pendingLegacyCleanup !== undefined) {
      await this.storage.clearLegacySyncSnapshot(this.pendingLegacyCleanup);
      this.pendingLegacyCleanup = undefined;
    }
  }

  private notePendingLegacyChunks(key: string, arrived: number): void {
    if (this.pendingLegacyManifestKey !== key) {
      this.pendingLegacyManifestKey = key;
      this.pendingLegacyChunkArrived = arrived;
      this.pendingLegacyChunkAttempts = 1;
      throw new Error(INCOMPLETE_CHUNK_ERROR);
    }
    if (arrived > this.pendingLegacyChunkArrived) {
      this.pendingLegacyChunkArrived = arrived;
      this.pendingLegacyChunkAttempts = 0;
      throw new Error(INCOMPLETE_CHUNK_ERROR);
    }
    this.pendingLegacyChunkAttempts += 1;
    if (this.pendingLegacyChunkAttempts >= INCOMPLETE_CHUNK_ATTEMPTS) {
      throw new Error('同步数据分块始终不完整，请检查设置同步是否正常');
    }
    throw new Error(INCOMPLETE_CHUNK_ERROR);
  }

  private clearPendingLegacyChunks(): void {
    this.pendingLegacyChunkAttempts = 0;
    this.pendingLegacyChunkArrived = 0;
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const result = this.queue.then(operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

function maxRevision(
  bookmarks: Record<string, VersionedRecord<unknown>>,
  folders: Record<string, VersionedRecord<unknown>>,
): number {
  return [bookmarks, folders]
    .flatMap((records) => Object.values(records))
    .reduce((max, record) => Math.max(max, record.revision), 0);
}

function bucketKey(bucket: SyncBucketV3): string {
  return `${bucket.generation}\0${bucket.checksum}`;
}

async function decodeCompressedState(payload: string, checksum: string): Promise<SharedStateV1> {
  const compressed = Buffer.from(payload, 'base64');
  if (createHash('sha256').update(compressed).digest('hex') !== checksum) {
    throw new Error('同步数据校验失败');
  }
  return parseSharedState(JSON.parse((await inflateRaw(compressed)).toString('utf8')));
}
