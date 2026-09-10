import type { Bookmark, BookmarkFolder } from './model';
import { compareOrder } from './order';

/**
 * 由扁平的书签与文件夹记录构建树。
 *
 * 存储层按记录合并，不保证引用完整性：一台机器删掉文件夹的同时另一台正往里加书签，
 * 合并后必然出现悬空引用甚至环。这里的原则是**读取时兜底、绝不改写数据**——悬空引用
 * 很可能只是同步尚未到齐的中间态，自动清理会把暂时的不一致变成永久的数据丢失。
 */

/** `buildTree` 产出的节点：书签与文件夹，文件夹的子节点同样只会是这两种。 */
export type ContentNode =
  | { kind: 'folder'; folder: BookmarkFolder; children: ContentNode[] }
  | { kind: 'bookmark'; bookmark: Bookmark };

/** 工作区分组节点，不对应任何存盘记录，只在渲染时套在真实树的外层，本身不会再嵌套分组。 */
export interface WorkspaceGroupNode {
  kind: 'workspace';
  workspace: string | undefined;
  children: ContentNode[];
}

export type TreeNode = WorkspaceGroupNode | ContentNode;

export interface BuildTreeInput {
  bookmarks: readonly Bookmark[];
  folders: readonly BookmarkFolder[];
  /**
   * 已确认删除（存在墓碑）的文件夹 id。
   *
   * 指向这些 id 的书签是可以安全持久化修复的；而指向一个**完全不存在**的 id 时，只能
   * 当作「记录还没同步到」临时提到根级，不可写盘。
   */
  deletedFolderIds?: ReadonlySet<string>;
  /** 破环时的裁决依据，取值最小的节点被提升到根级。必须在所有设备上给出一致的结果。 */
  rank?: (folderId: string) => string;
}

export interface TreeDiagnostics {
  /** 所属文件夹确已删除，可由修复命令持久化清理。 */
  resolvableOrphans: string[];
  /** 所属文件夹记录尚未出现，可能只是同步未到齐，不可写盘。 */
  pendingOrphans: string[];
  /** 因成环被提升到根级的文件夹 id。 */
  cycleBroken: string[];
  /** 因超过深度上限而未展开的文件夹 id。 */
  depthTruncated: string[];
}

export interface BuildTreeResult {
  roots: ContentNode[];
  diagnostics: TreeDiagnostics;
}

/** 树的最大层级。防止异常数据把递归打爆，同时也是合理使用的上限。 */
export const MAX_TREE_DEPTH = 32;

export function buildTree(input: BuildTreeInput): BuildTreeResult {
  const rank = input.rank ?? ((folderId: string) => folderId);
  const deleted = input.deletedFolderIds ?? new Set<string>();
  const folderById = new Map(input.folders.map((folder) => [folder.id, folder]));

  const parentOf = new Map<string, string | undefined>();
  for (const folder of input.folders) {
    // 自引用与指向不存在文件夹的引用一律视作根级；后者同样可能只是同步未到齐。
    const parentId = folder.parentId !== undefined && folder.parentId !== folder.id && folderById.has(folder.parentId)
      ? folder.parentId
      : undefined;
    parentOf.set(folder.id, parentId);
  }
  const cycleBroken = breakCycles(parentOf, rank);

  const childFolders = new Map<string | undefined, BookmarkFolder[]>();
  for (const folder of input.folders) {
    push(childFolders, parentOf.get(folder.id), folder);
  }

  const childBookmarks = new Map<string | undefined, Bookmark[]>();
  const resolvableOrphans: string[] = [];
  const pendingOrphans: string[] = [];
  for (const bookmark of input.bookmarks) {
    let folderId = bookmark.folderId;
    if (folderId !== undefined && !folderById.has(folderId)) {
      (deleted.has(folderId) ? resolvableOrphans : pendingOrphans).push(bookmark.id);
      folderId = undefined;
    }
    push(childBookmarks, folderId, bookmark);
  }

  const depthTruncated: string[] = [];
  const buildChildren = (parentId: string | undefined, depth: number): ContentNode[] => {
    const nodes: ContentNode[] = [];
    for (const folder of childFolders.get(parentId) ?? []) {
      if (depth >= MAX_TREE_DEPTH) {
        depthTruncated.push(folder.id);
        nodes.push({ kind: 'folder', folder, children: [] });
        continue;
      }
      nodes.push({ kind: 'folder', folder, children: buildChildren(folder.id, depth + 1) });
    }
    for (const bookmark of childBookmarks.get(parentId) ?? []) {
      nodes.push({ kind: 'bookmark', bookmark });
    }
    // 文件夹与书签共用一个 order 空间，允许交错排列。
    return nodes.sort((left, right) => compareNodes(left, right));
  };

  return {
    roots: buildChildren(undefined, 0),
    diagnostics: { resolvableOrphans, pendingOrphans, cycleBroken, depthTruncated },
  };
}

export interface GroupByWorkspaceInput {
  bookmarks: readonly Bookmark[];
  folders: readonly BookmarkFolder[];
  deletedFolderIds?: ReadonlySet<string>;
  rank?: (folderId: string) => string;
  /** 已在本窗口打开的工作区名，按顺序排列，决定分组靠前的顺序；未列出的工作区按名称排在其后。 */
  openWorkspaceOrder: readonly string[];
}

export interface GroupByWorkspaceResult {
  groups: WorkspaceGroupNode[];
  diagnostics: TreeDiagnostics;
}

/**
 * 按工作区把扁平的书签与文件夹分组，各自独立建树。
 *
 * 文件夹总是属于某个工作区（`BookmarkFolder.workspace`），书签按 `location` 归属：
 * `workspace` 位置对应同名分组，`external` 书签没有工作区，单独归入 undefined 分组
 * （渲染层展示为「工作区外」），且不参与任何文件夹。
 */
export function groupByWorkspace(input: GroupByWorkspaceInput): GroupByWorkspaceResult {
  const byWorkspace = new Map<string, { bookmarks: Bookmark[]; folders: BookmarkFolder[] }>();
  const external: Bookmark[] = [];
  const groupOf = (workspace: string): { bookmarks: Bookmark[]; folders: BookmarkFolder[] } => {
    const existing = byWorkspace.get(workspace);
    if (existing !== undefined) return existing;
    const created = { bookmarks: [], folders: [] };
    byWorkspace.set(workspace, created);
    return created;
  };

  for (const folder of input.folders) groupOf(folder.workspace).folders.push(folder);
  for (const bookmark of input.bookmarks) {
    if (bookmark.location.kind === 'external') external.push(bookmark);
    else groupOf(bookmark.location.folderName).bookmarks.push(bookmark);
  }

  const openIndex = new Map(input.openWorkspaceOrder.map((name, index) => [name, index]));
  const names = [...byWorkspace.keys()].sort((left, right) => {
    const leftOpen = openIndex.get(left);
    const rightOpen = openIndex.get(right);
    // 已打开的工作区按窗口中的顺序排在前面；其余按名称排序，保证多设备顺序一致。
    if (leftOpen !== undefined || rightOpen !== undefined) return (leftOpen ?? Infinity) - (rightOpen ?? Infinity);
    return left.localeCompare(right, 'zh-Hans');
  });

  const diagnostics: TreeDiagnostics = { resolvableOrphans: [], pendingOrphans: [], cycleBroken: [], depthTruncated: [] };
  const groups: WorkspaceGroupNode[] = [];
  const addGroup = (workspace: string | undefined, bookmarks: readonly Bookmark[], folders: readonly BookmarkFolder[]): void => {
    const result = buildTree({ bookmarks, folders, deletedFolderIds: input.deletedFolderIds, rank: input.rank });
    diagnostics.resolvableOrphans.push(...result.diagnostics.resolvableOrphans);
    diagnostics.pendingOrphans.push(...result.diagnostics.pendingOrphans);
    diagnostics.cycleBroken.push(...result.diagnostics.cycleBroken);
    diagnostics.depthTruncated.push(...result.diagnostics.depthTruncated);
    groups.push({ kind: 'workspace', workspace, children: result.roots });
  };

  for (const name of names) {
    const group = byWorkspace.get(name)!;
    addGroup(name, group.bookmarks, group.folders);
  }
  if (external.length > 0) addGroup(undefined, external, []);

  return { groups, diagnostics };
}

export type NodeComparator = (left: ContentNode, right: ContentNode) => number;

/** 按给定比较器递归重排整棵树，用于「按路径 / 创建时间 / 备注」等非手动排序模式。 */
export function sortTree(nodes: readonly ContentNode[], comparator: NodeComparator): ContentNode[] {
  return [...nodes]
    .map((node) => (node.kind === 'folder'
      ? { ...node, children: sortTree(node.children, comparator) }
      : node))
    .sort(comparator);
}

/**
 * 两台设备同时插到同一位置会算出完全相同的 order，此时必须有稳定的次级键，
 * 否则同一份数据在不同设备上的显示顺序会不一致。
 */
export function compareNodes(left: ContentNode, right: ContentNode): number {
  const leftKey = left.kind === 'folder' ? left.folder : left.bookmark;
  const rightKey = right.kind === 'folder' ? right.folder : right.bookmark;
  const byOrder = compareOrder(leftKey.order, rightKey.order);
  return byOrder !== 0 ? byOrder : leftKey.id < rightKey.id ? -1 : leftKey.id > rightKey.id ? 1 : 0;
}

/** 判断 candidate 是否是 folderId 自身或其后代，用于阻止会形成环的移动。 */
export function isSelfOrDescendant(
  folders: readonly BookmarkFolder[],
  folderId: string,
  candidate: string,
): boolean {
  if (folderId === candidate) return true;
  const parentById = new Map(folders.map((folder) => [folder.id, folder.parentId]));
  const visited = new Set<string>();
  let current: string | undefined = candidate;
  while (current !== undefined && !visited.has(current)) {
    if (current === folderId) return true;
    visited.add(current);
    current = parentById.get(current);
  }
  return false;
}

function breakCycles(parentOf: Map<string, string | undefined>, rank: (folderId: string) => string): string[] {
  const broken: string[] = [];
  const settled = new Set<string>();

  for (const start of parentOf.keys()) {
    if (settled.has(start)) continue;
    const path: string[] = [];
    const positions = new Map<string, number>();
    let current: string | undefined = start;

    while (current !== undefined && !settled.has(current)) {
      const seenAt = positions.get(current);
      if (seenAt !== undefined) {
        const cycle = path.slice(seenAt);
        const victim = cycle.reduce((min, id) => (rank(id) < rank(min) ? id : min));
        parentOf.set(victim, undefined);
        broken.push(victim);
        break;
      }
      positions.set(current, path.length);
      path.push(current);
      current = parentOf.get(current);
    }

    for (const id of path) settled.add(id);
  }

  return broken;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const existing = map.get(key);
  if (existing === undefined) map.set(key, [value]);
  else existing.push(value);
}
