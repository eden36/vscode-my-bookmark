import { randomUUID } from 'node:crypto';
import * as vscode from 'vscode';
import type { Bookmark, BookmarkColor, BookmarkFolder } from './core/model';
import { between, betweenMany, compareOrder, ORDER_REBALANCE_THRESHOLD } from './core/order';
import { belongsToWorkspace, resolveLocation, toLocation, type WorkspaceFolderInfo } from './core/resolver';
import { applyLineEdits, reanchor, type LineEdit } from './core/tracker';
import {
  buildTree,
  compareNodes,
  isSelfOrDescendant,
  sortTree,
  type TreeDiagnostics,
  type TreeNode,
} from './core/tree';
import { readConfig, type MyBookmarkConfig, type SortMode } from './config';
import type { BookmarkMutation, SharedStateView, StorageService } from './storage';

/**
 * 应用层门面。
 *
 * 它独占三样东西：物化后的数据快照、未保存文档的实时行号、以及唯一的变更事件。
 * 命令、树视图与装饰都只与它交互，不直接触碰存储层——否则乐观更新的内存覆盖层没有归属，
 * 而书签操作是前台手势，等落盘完成再刷新界面会让用户觉得「按了没反应」。
 */
export class BookmarkService implements vscode.Disposable {
  private view: SharedStateView = emptyView();
  private config: MyBookmarkConfig = readConfig();
  /** 文档 URI -> 书签 id -> 缓冲区中的当前行号。仅描述未保存的编辑。 */
  private readonly liveLines = new Map<string, Map<string, number>>();
  /** 已知在磁盘上消失的文件（URI 字符串）。只由删除事件填充，文件重新可读时清除。 */
  private readonly missingUris = new Set<string>();
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private diagnostics: TreeDiagnostics = { resolvableOrphans: [], pendingOrphans: [], cycleBroken: [], depthTruncated: [] };

  readonly onDidChange = this.changeEmitter.event;

  constructor(
    private readonly storage: StorageService,
    private readonly log: (message: string) => void = () => undefined,
  ) {}

  async initialize(): Promise<void> {
    await this.storage.initialize();
    this.refreshFromStorage();
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }

  /** 存储层的数据变了（本窗口写入、其他窗口写入、或远端同步）。 */
  refreshFromStorage(): void {
    this.view = this.storage.getView();
    this.changeEmitter.fire();
  }

  applyConfig(config: MyBookmarkConfig): void {
    this.config = config;
    this.changeEmitter.fire();
  }

  isReadOnly(): boolean {
    return this.storage.isReadOnly();
  }

  getLastError(): string | undefined {
    return this.storage.getLastError();
  }

  getTreeDiagnostics(): TreeDiagnostics {
    return this.diagnostics;
  }

  // ---------------------------------------------------------------- 读取

  getTree(): TreeNode[] {
    const visible = this.config.scope === 'all'
      ? this.view.bookmarks
      : this.view.bookmarks.filter((item) => belongsToWorkspace(item.location, workspaceFolders()));
    const result = buildTree({
      bookmarks: visible,
      // 文件夹是用户建立的组织结构，即使当前范围内没有书签也要显示，否则切换范围时目录会忽隐忽现。
      folders: this.view.folders,
      deletedFolderIds: this.view.deletedFolderIds,
    });
    this.diagnostics = result.diagnostics;
    const comparator = this.comparatorFor(this.config.sortMode);
    return comparator === undefined ? result.roots : sortTree(result.roots, comparator);
  }

  /**
   * 全部书签，不受 `scope` 过滤影响。
   *
   * 树视图默认只列当前工作区，但全局搜索、重新锚定、删除全部这些操作面向的是整份数据，
   * 走 `getTree()` 会让它们在默认配置下悄悄只处理一部分。
   */
  getAllBookmarks(): Bookmark[] {
    return [...this.view.bookmarks];
  }

  getBookmark(id: string): Bookmark | undefined {
    return this.view.bookmarks.find((item) => item.id === id);
  }

  getFolder(id: string): BookmarkFolder | undefined {
    return this.view.folders.find((item) => item.id === id);
  }

  /** 书签当前应显示的行号：未保存的编辑优先，其次是磁盘位置，最后才是创建时的行号。 */
  getLine(bookmark: Bookmark): number {
    const uri = this.resolveUri(bookmark);
    const live = uri === undefined ? undefined : this.liveLines.get(uri.toString())?.get(bookmark.id);
    return live ?? this.view.positions.get(bookmark.id) ?? bookmark.line;
  }

  resolveUri(bookmark: Bookmark): vscode.Uri | undefined {
    const fsPath = resolveLocation(bookmark.location, workspaceFolders(), {
      caseSensitive: process.platform === 'linux',
      pathMappings: this.config.pathMappings,
    });
    return fsPath === undefined ? undefined : vscode.Uri.file(fsPath);
  }

  getBookmarksForDocument(uri: vscode.Uri): Bookmark[] {
    const key = uri.toString();
    return this.view.bookmarks.filter((item) => this.resolveUri(item)?.toString() === key);
  }

  // ---------------------------------------------------------------- 编辑跟踪

  /**
   * 记录未保存的行号变化。刻意不落盘：磁盘内容没变，其他窗口看到的就应该是旧行号。
   *
   * 返回 true 表示这份文档有书签且发生了编辑，调用方应按行号重画装饰——即使没有书签位移，
   * 也要避免旧的装饰区间被编辑撑成跨行。
   */
  trackDocumentEdits(uri: vscode.Uri, edits: readonly LineEdit[]): boolean {
    const bookmarks = this.getBookmarksForDocument(uri);
    if (bookmarks.length === 0 || edits.length === 0) return false;
    const key = uri.toString();
    const tracked = bookmarks.map((item) => ({ id: item.id, line: this.getLine(item) }));
    const moved = applyLineEdits(tracked, edits);
    if (moved.length === 0) return true;

    const lines = this.liveLines.get(key) ?? new Map<string, number>();
    for (const entry of moved) lines.set(entry.id, entry.line);
    this.liveLines.set(key, lines);
    return true;
  }

  /** 文档保存后把实时行号刷入磁盘位置。无实际位移时完全不碰存储层。 */
  async flushDocument(uri: vscode.Uri): Promise<void> {
    const key = uri.toString();
    const lines = this.liveLines.get(key);
    if (lines === undefined || lines.size === 0) return;
    // 绝大多数保存并不移动任何书签。这个比对必须发生在进入写队列之前——存储层的
    // 无变化短路要等抢到锁、读完盘才生效，救不了 autoSave 带来的高频调用。
    const changed = [...lines].filter(([id, line]) => this.view.positions.get(id) !== line);
    this.liveLines.delete(key);
    if (changed.length === 0) return;
    await this.storage.updatePositions(changed.map(([id, line]) => ({ id, line })));
  }

  /** 文档关闭且改动未保存：实时行号随之作废，回到磁盘位置。 */
  discardDocument(uri: vscode.Uri): void {
    if (this.liveLines.delete(uri.toString())) this.changeEmitter.fire();
  }

  /**
   * 标记文件或目录已被删除。
   *
   * 书签本身刻意保留（文件可能只是被 git 临时移走），但树里必须看得出它暂时跳不过去，
   * 否则用户要等到点击报错才知道。判断依据只用事件，不去探测文件系统——扩展跑在 UI 侧，
   * 远程场景下本机根本没有这些文件。
   */
  markMissing(uris: readonly vscode.Uri[]): void {
    const deleted = uris.map((uri) => uri.toString());
    let changed = false;
    for (const bookmark of this.view.bookmarks) {
      const current = this.resolveUri(bookmark)?.toString();
      if (current === undefined || this.missingUris.has(current)) continue;
      // 删除的可能是整个目录，其下所有文件都要跟着失效。
      if (!deleted.some((path) => current === path || current.startsWith(`${path}/`))) continue;
      this.missingUris.add(current);
      changed = true;
    }
    if (changed) this.changeEmitter.fire();
  }

  /** 文件重新可读，撤销失效标记。 */
  markPresent(uri: vscode.Uri): void {
    if (this.missingUris.delete(uri.toString())) this.changeEmitter.fire();
  }

  isMissing(bookmark: Bookmark): boolean {
    const uri = this.resolveUri(bookmark);
    return uri !== undefined && this.missingUris.has(uri.toString());
  }

  /**
   * 文档打开时按锚点文本重新定位。
   *
   * 关闭的文件在 git 切换分支后行号会静默腐烂，而编辑事件只覆盖打开着的文档，
   * 因此重锚定只能推迟到真正打开文件的那一刻。
   */
  async reanchorDocument(document: vscode.TextDocument): Promise<void> {
    // 能打开就说明文件还在，无论后面有没有书签需要重定位。
    this.markPresent(document.uri);
    const bookmarks = this.getBookmarksForDocument(document.uri);
    if (bookmarks.length === 0) return;
    const lines = Array.from({ length: document.lineCount }, (_, index) => document.lineAt(index).text);
    const updates: { id: string; line: number }[] = [];
    for (const item of bookmarks) {
      if (item.anchorText === undefined) continue;
      const current = this.view.positions.get(item.id) ?? item.line;
      const found = reanchor(lines, item.anchorText, current);
      if (found !== undefined && found !== current) updates.push({ id: item.id, line: found });
    }
    if (updates.length === 0) return;
    await this.storage.updatePositions(updates);
  }

  // ---------------------------------------------------------------- 变更

  /**
   * 在若干行上切换书签，支持多光标。
   *
   * 选中的行全都已有书签时整体删除，否则只给还缺书签的行补上——一半增一半删的结果没人能预期。
   * 无论涉及多少行都只走一次 `apply`，避免多光标操作变成连续多次抢锁落盘。
   */
  async toggleLines(
    uri: vscode.Uri,
    lines: readonly { line: number; lineText?: string }[],
    options: { note?: string } = {},
  ): Promise<'added' | 'removed' | 'none'> {
    const targets = [...new Map(lines.map((entry) => [entry.line, entry])).values()]
      .sort((left, right) => left.line - right.line);
    if (targets.length === 0) return 'none';

    const existing = new Map(this.getBookmarksForDocument(uri).map((item) => [this.getLine(item), item]));
    const absent = targets.filter((entry) => !existing.has(entry.line));
    if (absent.length === 0 && options.note === undefined) {
      await this.remove(targets.map((entry) => existing.get(entry.line)!.id));
      return 'removed';
    }

    const location = toLocation(uri.fsPath, workspaceFolders(), { caseSensitive: process.platform === 'linux' });
    const createdAt = Date.now();
    // id 与排序键必须在 build 之外算好：build 会被调用两次，内部生成随机值会让两次结果不一致。
    let order = this.appendOrder(undefined);
    const created = absent.map((entry) => {
      const bookmark: Bookmark = {
        id: randomUUID(),
        location,
        line: entry.line,
        ...(entry.lineText?.trim() ? { anchorText: entry.lineText.trim() } : {}),
        ...(options.note ? { note: options.note } : {}),
        order,
        createdAt,
      };
      order = between(order, undefined);
      return bookmark;
    });
    const renamed = options.note === undefined
      ? []
      : targets
        .map((entry) => existing.get(entry.line))
        .filter((item): item is Bookmark => item !== undefined)
        .map((item) => withNote(item, options.note));

    await this.apply((view) => ({
      upsertBookmarks: [...created, ...renamed],
      setPositions: created
        .filter((item) => view.positions.get(item.id) === undefined)
        .map((item) => ({ id: item.id, line: item.line })),
    }));
    return 'added';
  }

  async setNote(id: string, note: string | undefined): Promise<void> {
    await this.updateBookmark(id, (item) => withNote(item, note));
  }

  async setColor(ids: readonly string[], color: BookmarkColor | undefined): Promise<void> {
    await this.apply((view) => {
      const upsertBookmarks: Bookmark[] = [];
      const upsertFolders: BookmarkFolder[] = [];
      for (const id of ids) {
        const bookmark = view.bookmarks.find((item) => item.id === id);
        if (bookmark !== undefined) {
          upsertBookmarks.push(withColor(bookmark, color));
          continue;
        }
        const folder = view.folders.find((item) => item.id === id);
        if (folder !== undefined) upsertFolders.push(withColor(folder, color));
      }
      return { upsertBookmarks, upsertFolders };
    });
  }

  async createFolder(name: string, parentId: string | undefined): Promise<BookmarkFolder> {
    const created: BookmarkFolder = {
      id: randomUUID(),
      name,
      ...(parentId === undefined ? {} : { parentId }),
      order: this.appendOrder(parentId),
      createdAt: Date.now(),
    };
    await this.apply(() => ({ upsertFolders: [created] }));
    return created;
  }

  async renameFolder(id: string, name: string): Promise<void> {
    await this.apply((view) => {
      const folder = view.folders.find((item) => item.id === id);
      return folder === undefined ? undefined : { upsertFolders: [{ ...folder, name }] };
    });
  }

  /**
   * 删除文件夹。
   *
   * 默认把子项上提一级而不是级联删除：并发场景下另一台设备可能刚往这个文件夹里加了书签，
   * 级联会连带删掉它们，而这一步没有撤销。
   */
  async deleteFolder(id: string, cascade: boolean): Promise<void> {
    await this.apply((view) => {
      const target = view.folders.find((item) => item.id === id);
      if (target === undefined) return undefined;
      const descendants = collectDescendants(view.folders, id);
      const affected = new Set([id, ...descendants]);

      if (cascade) {
        return {
          deleteFolders: [...affected],
          deleteBookmarks: view.bookmarks.filter((item) => item.folderId !== undefined && affected.has(item.folderId))
            .map((item) => item.id),
        };
      }
      return {
        deleteFolders: [id],
        upsertFolders: view.folders
          .filter((item) => item.parentId === id)
          .map((item) => reparentFolder(item, target.parentId)),
        upsertBookmarks: view.bookmarks
          .filter((item) => item.folderId === id)
          .map((item) => reparentBookmark(item, target.parentId)),
      };
    });
  }

  async remove(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.apply(() => ({ deleteBookmarks: [...ids] }));
  }

  /** 清除某个文件上的全部书签，返回删除条数。 */
  async removeForDocument(uri: vscode.Uri): Promise<number> {
    const ids = this.getBookmarksForDocument(uri).map((item) => item.id);
    await this.remove(ids);
    return ids.length;
  }

  async removeAll(): Promise<void> {
    await this.apply((view) => ({
      deleteBookmarks: view.bookmarks.map((item) => item.id),
      deleteFolders: view.folders.map((item) => item.id),
    }));
  }

  /** 拖拽移动到某个文件夹。目标为 undefined 表示移到根级。 */
  async moveToFolder(ids: readonly string[], targetFolderId: string | undefined): Promise<void> {
    await this.apply((view) => {
      const upsertBookmarks: Bookmark[] = [];
      const upsertFolders: BookmarkFolder[] = [];
      let order = this.appendOrder(targetFolderId, view);
      for (const id of ids) {
        if (id === targetFolderId) continue;
        const bookmark = view.bookmarks.find((item) => item.id === id);
        if (bookmark !== undefined) {
          upsertBookmarks.push({ ...reparentBookmark(bookmark, targetFolderId), order });
          order = between(order, undefined);
          continue;
        }
        const folder = view.folders.find((item) => item.id === id);
        // 移到自己的后代下会形成环；这类拖放必须直接拒绝，而不是靠渲染层去兜。
        if (folder === undefined) continue;
        if (targetFolderId !== undefined && isSelfOrDescendant(view.folders, folder.id, targetFolderId)) continue;
        upsertFolders.push({ ...reparentFolder(folder, targetFolderId), order });
        order = between(order, undefined);
      }
      return { upsertBookmarks, upsertFolders };
    });
  }

  /** 同级上移或下移一位。原生树视图没有插入指示线，精确调序只能靠命令完成。 */
  async moveBy(id: string, offset: -1 | 1): Promise<void> {
    await this.apply((view) => {
      const parentId = this.parentOf(id, view);
      const siblings = this.sortedSiblings(parentId, view);
      const index = siblings.findIndex((item) => item.id === id);
      const targetIndex = index + offset;
      if (index < 0 || targetIndex < 0 || targetIndex >= siblings.length) return undefined;

      // 先把自己摘出去再算邻居，这样会复用腾出的空档，而不是在原地反复细分导致排序键变长。
      const without = siblings.filter((item) => item.id !== id);
      const order = between(without[targetIndex - 1]?.order, without[targetIndex]?.order);
      const bookmark = view.bookmarks.find((item) => item.id === id);
      if (bookmark !== undefined) return { upsertBookmarks: [{ ...bookmark, order }] };
      const folder = view.folders.find((item) => item.id === id);
      return folder === undefined ? undefined : { upsertFolders: [{ ...folder, order }] };
    });
  }

  /** 把所属文件夹确已删除的孤儿书签落到根级。只处理有墓碑的，尚未同步到的不动。 */
  async repairTree(): Promise<number> {
    let repaired = 0;
    await this.apply((view) => {
      const orphans = view.bookmarks.filter((item) => (
        item.folderId !== undefined
        && !view.folders.some((folder) => folder.id === item.folderId)
        && view.deletedFolderIds.has(item.folderId)
      ));
      repaired = orphans.length;
      return orphans.length === 0 ? undefined : { upsertBookmarks: orphans.map((item) => reparentBookmark(item, undefined)) };
    });
    return repaired;
  }

  /** 重排同级排序键。反复在同一位置插入会让键越来越长，到阈值后需要压平一次。 */
  async rebalanceOrder(): Promise<number> {
    let rebalanced = 0;
    await this.apply((view) => {
      const parents = new Set<string | undefined>([undefined]);
      for (const folder of view.folders) parents.add(folder.id);

      const upsertBookmarks: Bookmark[] = [];
      const upsertFolders: BookmarkFolder[] = [];
      for (const parentId of parents) {
        const siblings = this.sortedSiblings(parentId, view);
        if (siblings.length < 2) continue;
        if (Math.max(...siblings.map((item) => item.order.length)) <= ORDER_REBALANCE_THRESHOLD) continue;
        const orders = betweenMany(undefined, undefined, siblings.length);
        siblings.forEach((sibling, index) => {
          const order = orders[index]!;
          const bookmark = view.bookmarks.find((item) => item.id === sibling.id);
          if (bookmark !== undefined) upsertBookmarks.push({ ...bookmark, order });
          else {
            const folder = view.folders.find((item) => item.id === sibling.id);
            if (folder !== undefined) upsertFolders.push({ ...folder, order });
          }
        });
        rebalanced += siblings.length;
      }
      return rebalanced === 0 ? undefined : { upsertBookmarks, upsertFolders };
    });
    return rebalanced;
  }

  /** 文件被重命名或移动后让书签跟随。 */
  async relocate(changes: readonly { oldUri: vscode.Uri; newUri: vscode.Uri }[]): Promise<void> {
    await this.apply((view) => {
      const folders = workspaceFolders();
      const options = { caseSensitive: process.platform === 'linux' };
      const upsertBookmarks: Bookmark[] = [];
      for (const bookmark of view.bookmarks) {
        const current = this.resolveUri(bookmark)?.fsPath;
        if (current === undefined) continue;
        for (const change of changes) {
          const moved = movedPath(current, change.oldUri.fsPath, change.newUri.fsPath, options.caseSensitive);
          if (moved === undefined) continue;
          upsertBookmarks.push({ ...bookmark, location: toLocation(moved, folders, options) });
          break;
        }
      }
      return upsertBookmarks.length === 0 ? undefined : { upsertBookmarks };
    });
  }

  // ---------------------------------------------------------------- 内部

  /**
   * 乐观更新：先改内存快照并立刻刷新界面，再异步落盘；失败则回退到存储层的真实状态。
   *
   * build 会被调用两次——一次在内存快照上、一次在持锁后的最新数据上——所以它必须是幂等的，
   * 不能在内部生成随机值。需要新 id 时由调用方先生成好再闭包捕获。
   */
  private async apply(build: (view: SharedStateView) => BookmarkMutation | undefined): Promise<void> {
    const mutation = build(this.view);
    if (mutation === undefined) return;
    const rollback = this.view;
    this.view = applyMutationLocally(this.view, mutation);
    this.changeEmitter.fire();
    try {
      await this.storage.mutate(build);
    } catch (error) {
      this.view = this.storage.isReadOnly() ? rollback : this.storage.getView();
      this.changeEmitter.fire();
      throw error;
    }
  }

  private async updateBookmark(id: string, update: (bookmark: Bookmark) => Bookmark): Promise<void> {
    await this.apply((view) => {
      const bookmark = view.bookmarks.find((item) => item.id === id);
      return bookmark === undefined ? undefined : { upsertBookmarks: [update(bookmark)] };
    });
  }

  private appendOrder(parentId: string | undefined, view: SharedStateView = this.view): string {
    const siblings = this.sortedSiblings(parentId, view);
    return between(siblings[siblings.length - 1]?.order, undefined);
  }

  private sortedSiblings(parentId: string | undefined, view: SharedStateView = this.view): { id: string; order: string }[] {
    const siblings = [
      ...view.folders.filter((item) => item.parentId === parentId),
      ...view.bookmarks.filter((item) => item.folderId === parentId),
    ].map((item) => ({ id: item.id, order: item.order }));
    return siblings.sort((left, right) => {
      const byOrder = compareOrder(left.order, right.order);
      return byOrder !== 0 ? byOrder : left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    });
  }

  private parentOf(id: string, view: SharedStateView): string | undefined {
    return view.bookmarks.find((item) => item.id === id)?.folderId
      ?? view.folders.find((item) => item.id === id)?.parentId;
  }

  private comparatorFor(mode: SortMode): ((left: TreeNode, right: TreeNode) => number) | undefined {
    if (mode === 'manual') return undefined;
    // 非手动模式下仍以 compareNodes 兜底，保证同一排序值的项在各设备上顺序一致。
    const keyOf = (node: TreeNode): string => {
      if (node.kind === 'folder') return node.folder.name;
      if (mode === 'note') return node.bookmark.note ?? '';
      if (mode === 'created') return String(node.bookmark.createdAt).padStart(16, '0');
      return `${locationKey(node.bookmark)}:${String(this.getLine(node.bookmark)).padStart(8, '0')}`;
    };
    return (left, right) => {
      // 文件夹始终排在书签之前：非手动模式下交错排列没有意义，只会让层级难以辨认。
      if (left.kind !== right.kind) return left.kind === 'folder' ? -1 : 1;
      const compared = keyOf(left).localeCompare(keyOf(right), 'zh-Hans');
      return compared !== 0 ? compared : compareNodes(left, right);
    };
  }
}

function emptyView(): SharedStateView {
  return { bookmarks: [], folders: [], positions: new Map(), deletedFolderIds: new Set() };
}

function workspaceFolders(): WorkspaceFolderInfo[] {
  return (vscode.workspace.workspaceFolders ?? []).map((folder) => ({ name: folder.name, fsPath: folder.uri.fsPath }));
}

function locationKey(bookmark: Bookmark): string {
  return bookmark.location.kind === 'workspace'
    ? `${bookmark.location.folderName}/${bookmark.location.relativePath}`
    : bookmark.location.fsPath;
}

function withNote(bookmark: Bookmark, note: string | undefined): Bookmark {
  const next = { ...bookmark };
  if (note === undefined || note.length === 0) delete next.note;
  else next.note = note;
  return next;
}

function withColor<T extends { color?: BookmarkColor }>(item: T, color: BookmarkColor | undefined): T {
  const next = { ...item };
  if (color === undefined) delete next.color;
  else next.color = color;
  return next;
}

function reparentBookmark(bookmark: Bookmark, folderId: string | undefined): Bookmark {
  const next = { ...bookmark };
  if (folderId === undefined) delete next.folderId;
  else next.folderId = folderId;
  return next;
}

function reparentFolder(folder: BookmarkFolder, parentId: string | undefined): BookmarkFolder {
  const next = { ...folder };
  if (parentId === undefined) delete next.parentId;
  else next.parentId = parentId;
  return next;
}

function collectDescendants(folders: readonly BookmarkFolder[], rootId: string): string[] {
  const result: string[] = [];
  const queue = [rootId];
  const visited = new Set<string>([rootId]);
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const folder of folders) {
      // 数据可能因合并而成环，visited 既去重也防死循环。
      if (folder.parentId !== current || visited.has(folder.id)) continue;
      visited.add(folder.id);
      result.push(folder.id);
      queue.push(folder.id);
    }
  }
  return result;
}

function movedPath(current: string, oldPath: string, newPath: string, caseSensitive: boolean): string | undefined {
  const normalize = (value: string): string => value.replace(/\\/g, '/');
  const target = normalize(current);
  const from = normalize(oldPath);
  const compare = (left: string, right: string): boolean => (
    caseSensitive ? left === right : left.toLowerCase() === right.toLowerCase()
  );
  if (compare(target, from)) return normalize(newPath);
  // 目录改名要连带其下所有文件。
  if (target.length > from.length && target[from.length] === '/' && compare(target.slice(0, from.length), from)) {
    return normalize(newPath) + target.slice(from.length);
  }
  return undefined;
}

function applyMutationLocally(view: SharedStateView, mutation: BookmarkMutation): SharedStateView {
  const bookmarks = new Map(view.bookmarks.map((item) => [item.id, item]));
  const folders = new Map(view.folders.map((item) => [item.id, item]));
  const positions = new Map(view.positions);

  for (const bookmark of mutation.upsertBookmarks ?? []) bookmarks.set(bookmark.id, bookmark);
  for (const id of mutation.deleteBookmarks ?? []) {
    bookmarks.delete(id);
    positions.delete(id);
  }
  for (const folder of mutation.upsertFolders ?? []) folders.set(folder.id, folder);
  const deletedFolderIds = new Set(view.deletedFolderIds);
  for (const id of mutation.deleteFolders ?? []) {
    folders.delete(id);
    deletedFolderIds.add(id);
  }
  for (const entry of mutation.setPositions ?? []) positions.set(entry.id, entry.line);
  for (const id of mutation.deletePositions ?? []) positions.delete(id);

  return { bookmarks: [...bookmarks.values()], folders: [...folders.values()], positions, deletedFolderIds };
}
