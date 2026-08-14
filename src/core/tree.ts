import type { Bookmark, BookmarkFolder } from './model';
import { compareOrder } from './order';

/**
 * 由扁平的书签与文件夹记录构建树。
 *
 * 存储层按记录合并，不保证引用完整性：一台机器删掉文件夹的同时另一台正往里加书签，
 * 合并后必然出现悬空引用甚至环。这里的原则是**读取时兜底、绝不改写数据**——悬空引用
 * 很可能只是同步尚未到齐的中间态，自动清理会把暂时的不一致变成永久的数据丢失。
 */

export type TreeNode =
  | { kind: 'folder'; folder: BookmarkFolder; children: TreeNode[] }
  | { kind: 'bookmark'; bookmark: Bookmark };

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
  roots: TreeNode[];
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
  const buildChildren = (parentId: string | undefined, depth: number): TreeNode[] => {
    const nodes: TreeNode[] = [];
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

export type NodeComparator = (left: TreeNode, right: TreeNode) => number;

/** 按给定比较器递归重排整棵树，用于「按路径 / 创建时间 / 备注」等非手动排序模式。 */
export function sortTree(nodes: readonly TreeNode[], comparator: NodeComparator): TreeNode[] {
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
export function compareNodes(left: TreeNode, right: TreeNode): number {
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
