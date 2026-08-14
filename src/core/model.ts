import { isValidOrderKey } from './order';

/**
 * 书签位置。
 *
 * 优先记录「工作区名 + 相对路径」而不是绝对路径：书签是全局的，会随 Settings Sync 到达
 * 另一台机器，而绝对路径在那里毫无意义（`D:\proj` 与 `/home/u/proj`）。只有工作区之外的
 * 文件才退回绝对路径。
 */
export type BookmarkLocation =
  | { kind: 'workspace'; folderName: string; relativePath: string }
  | { kind: 'external'; fsPath: string };

/** 可选的书签颜色。存的是调色板 id 而不是十六进制值——树节点的着色只接受已注册的主题色 id。 */
export const BOOKMARK_COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray'] as const;
export type BookmarkColor = (typeof BOOKMARK_COLORS)[number];

export interface Bookmark {
  id: string;
  location: BookmarkLocation;
  /** 创建时的行号（0 起）。只在创建、手动移动、显式重锚定时写入，不随编辑跟踪变化。 */
  line: number;
  /** 创建时该行的原文，用于文件在别处被改动后重新定位。 */
  anchorText?: string;
  note?: string;
  color?: BookmarkColor;
  tags?: string[];
  /** 所属书签文件夹；undefined 表示根级。 */
  folderId?: string;
  order: string;
  createdAt: number;
}

export interface BookmarkFolder {
  id: string;
  name: string;
  parentId?: string;
  color?: BookmarkColor;
  order: string;
  createdAt: number;
}

/**
 * 书签在磁盘文件中的当前行号。
 *
 * 与 Bookmark 分表存放，因为二者的变更频率与来源完全不同：行号随每次保存自动变化，
 * 备注/分组/顺序则由用户手动修改。合并是按整条记录做最后写入者胜出的，放在同一条记录里
 * 会让「保存文件」这种自动行为覆盖掉另一台设备上「改备注」的人工意图。
 */
export interface BookmarkPosition {
  line: number;
}

export function isBookmarkColor(value: unknown): value is BookmarkColor {
  return typeof value === 'string' && (BOOKMARK_COLORS as readonly string[]).includes(value);
}

export function isBookmarkLocation(value: unknown): value is BookmarkLocation {
  if (!isObject(value)) return false;
  if (value.kind === 'workspace') {
    return typeof value.folderName === 'string' && value.folderName.length > 0
      && typeof value.relativePath === 'string' && value.relativePath.length > 0;
  }
  if (value.kind === 'external') return typeof value.fsPath === 'string' && value.fsPath.length > 0;
  return false;
}

export function isBookmark(value: unknown): value is Bookmark {
  return isObject(value)
    && typeof value.id === 'string' && value.id.length > 0
    && isBookmarkLocation(value.location)
    && isLineNumber(value.line)
    && (value.anchorText === undefined || typeof value.anchorText === 'string')
    && (value.note === undefined || typeof value.note === 'string')
    && (value.color === undefined || isBookmarkColor(value.color))
    && (value.tags === undefined || (Array.isArray(value.tags) && value.tags.every((tag) => typeof tag === 'string')))
    && (value.folderId === undefined || (typeof value.folderId === 'string' && value.folderId.length > 0))
    && isValidOrderKey(value.order)
    && isTimestamp(value.createdAt);
}

export function isBookmarkFolder(value: unknown): value is BookmarkFolder {
  return isObject(value)
    && typeof value.id === 'string' && value.id.length > 0
    && typeof value.name === 'string' && value.name.length > 0
    && (value.parentId === undefined || (typeof value.parentId === 'string' && value.parentId.length > 0))
    && (value.color === undefined || isBookmarkColor(value.color))
    && isValidOrderKey(value.order)
    && isTimestamp(value.createdAt);
}

export function isBookmarkPosition(value: unknown): value is BookmarkPosition {
  return isObject(value) && isLineNumber(value.line);
}

function isLineNumber(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function isTimestamp(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
