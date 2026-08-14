import type { BookmarkLocation } from './model';

/**
 * 书签位置与文件系统路径之间的转换。
 *
 * 全局书签会跨机器流动，路径解析必须以「工作区名 + 相对路径」为主、绝对路径为辅，
 * 否则换一台机器（甚至换一个盘符）书签就全部失效。
 */

export interface WorkspaceFolderInfo {
  name: string;
  fsPath: string;
}

export interface ResolveOptions {
  /** 路径大小写是否敏感。Windows 与 macOS 默认不敏感，Linux 需显式传 true。 */
  caseSensitive?: boolean;
  /** 跨设备路径前缀映射，仅用于工作区之外的文件。 */
  pathMappings?: Readonly<Record<string, string>>;
}

/** 把绝对路径归入某个工作区文件夹；不属于任何工作区时退回绝对路径。 */
export function toLocation(
  fsPath: string,
  folders: readonly WorkspaceFolderInfo[],
  options: ResolveOptions = {},
): BookmarkLocation {
  const target = normalizePath(fsPath);
  // 多个工作区文件夹可能互相嵌套，取最长匹配才能落到最具体的那一个。
  let best: { folder: WorkspaceFolderInfo; root: string } | undefined;
  for (const folder of folders) {
    const root = normalizePath(folder.fsPath);
    if (!isUnder(target, root, options.caseSensitive)) continue;
    if (best === undefined || root.length > best.root.length) best = { folder, root };
  }
  if (best === undefined) return { kind: 'external', fsPath: target };
  return {
    kind: 'workspace',
    folderName: best.folder.name,
    relativePath: target.slice(best.root.length + 1),
  };
}

/** 解析回绝对路径；无法解析（工作区未打开等）时返回 undefined。 */
export function resolveLocation(
  location: BookmarkLocation,
  folders: readonly WorkspaceFolderInfo[],
  options: ResolveOptions = {},
): string | undefined {
  if (location.kind === 'workspace') {
    const folder = folders.find((candidate) => candidate.name === location.folderName);
    // 解析不出来通常只是该工作区当前没打开，调用方应把书签标记为暂不可用而不是删除。
    if (folder === undefined) return undefined;
    return `${normalizePath(folder.fsPath)}/${location.relativePath}`;
  }
  return applyPathMappings(location.fsPath, options);
}

/** 判断书签是否属于给定的工作区文件夹集合，用于树视图按当前工作区过滤。 */
export function belongsToWorkspace(
  location: BookmarkLocation,
  folders: readonly WorkspaceFolderInfo[],
): boolean {
  return location.kind === 'workspace' && folders.some((folder) => folder.name === location.folderName);
}

/** 目录被重命名后批量改写路径；返回 undefined 表示该位置不在被改名的目录下。 */
export function rewritePrefix(
  location: BookmarkLocation,
  oldPrefix: string,
  newPrefix: string,
  options: ResolveOptions = {},
): BookmarkLocation | undefined {
  if (location.kind !== 'external') return undefined;
  const from = normalizePath(oldPrefix);
  const target = normalizePath(location.fsPath);
  if (!equalsPath(target, from, options.caseSensitive) && !isUnder(target, from, options.caseSensitive)) {
    return undefined;
  }
  return { kind: 'external', fsPath: normalizePath(newPrefix) + target.slice(from.length) };
}

/** 统一成正斜杠、去掉重复与末尾分隔符，使同一路径在不同来源下有唯一表示。 */
export function normalizePath(fsPath: string): string {
  const unified = fsPath.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  return unified.length > 1 && unified.endsWith('/') ? unified.slice(0, -1) : unified;
}

function applyPathMappings(fsPath: string, options: ResolveOptions): string {
  const target = normalizePath(fsPath);
  const mappings = options.pathMappings;
  if (mappings === undefined) return target;
  for (const [from, to] of Object.entries(mappings)) {
    const prefix = normalizePath(from);
    if (isUnder(target, prefix, options.caseSensitive)) return normalizePath(to) + target.slice(prefix.length);
  }
  return target;
}

function isUnder(target: string, root: string, caseSensitive = false): boolean {
  if (target.length <= root.length) return false;
  if (target[root.length] !== '/') return false;
  return equalsPath(target.slice(0, root.length), root, caseSensitive);
}

function equalsPath(left: string, right: string, caseSensitive = false): boolean {
  return caseSensitive ? left === right : left.toLowerCase() === right.toLowerCase();
}
