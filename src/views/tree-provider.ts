import * as vscode from 'vscode';
import type { BookmarkService } from '../bookmark-service';
import type { Bookmark, BookmarkColor, BookmarkFolder } from '../core/model';
import type { TreeNode } from '../core/tree';

export const BOOKMARK_TREE_VIEW_ID = 'myBookmark.tree';

export class BookmarkTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly changeEmitter = new vscode.EventEmitter<TreeNode | undefined>();
  private roots: TreeNode[] = [];
  private readonly parents = new Map<string, TreeNode>();
  private readonly nodes = new Map<string, TreeNode>();

  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(private readonly service: BookmarkService) {}

  refresh(): void {
    this.changeEmitter.fire(undefined);
  }

  /** 按 id 找回当前树中的节点，供命令与 reveal 使用。 */
  findNode(id: string): TreeNode | undefined {
    return this.nodes.get(id);
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    return element.kind === 'folder' ? this.folderItem(element.folder) : this.bookmarkItem(element.bookmark);
  }

  getChildren(element?: TreeNode): TreeNode[] {
    if (element === undefined) {
      this.roots = this.service.getTree();
      this.parents.clear();
      this.nodes.clear();
      this.index(this.roots, undefined);
      return this.roots;
    }
    return element.kind === 'folder' ? element.children : [];
  }

  getParent(element: TreeNode): TreeNode | undefined {
    return this.parents.get(nodeId(element));
  }

  private index(nodes: readonly TreeNode[], parent: TreeNode | undefined): void {
    for (const node of nodes) {
      const id = nodeId(node);
      this.nodes.set(id, node);
      if (parent !== undefined) this.parents.set(id, parent);
      if (node.kind === 'folder') this.index(node.children, node);
    }
  }

  private folderItem(folder: BookmarkFolder): vscode.TreeItem {
    const item = new vscode.TreeItem(folder.name, vscode.TreeItemCollapsibleState.Collapsed);
    // 树节点每次刷新都是新对象，稳定的 id 是 VS Code 记住展开状态的唯一依据。
    item.id = folder.id;
    item.contextValue = 'folder';
    item.iconPath = new vscode.ThemeIcon('folder', themeColor(folder.color));
    return item;
  }

  private bookmarkItem(bookmark: Bookmark): vscode.TreeItem {
    const line = this.service.getLine(bookmark);
    const uri = this.service.resolveUri(bookmark);
    const fileName = uri === undefined ? locationLabel(bookmark) : basename(uri.path);
    // 工作区没打开、或文件已被删除，两种情况都跳不过去，图标上必须看得出来。
    const missing = uri === undefined || this.service.isMissing(bookmark);

    // 优先显示备注；没有备注时退回创建时记录的行内容，比只显示文件名有用得多。
    const label = bookmark.note?.trim() || bookmark.anchorText?.trim() || fileName;
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    item.id = bookmark.id;
    item.contextValue = 'bookmark';
    item.description = `${fileName}:${line + 1}`;
    // ThemeIcon 在选中行会被列表前景色盖掉；实心 SVG 当图片显示，颜色才能保住。
    item.iconPath = missing
      ? new vscode.ThemeIcon('warning', themeColor(bookmark.color))
      : bookmarkIcon(bookmark.color);
    item.tooltip = this.tooltip(bookmark, line, uri, missing);
    if (uri !== undefined) {
      item.command = { command: 'myBookmark.open', title: '打开书签', arguments: [bookmark.id] };
    }
    return item;
  }

  private tooltip(
    bookmark: Bookmark,
    line: number,
    uri: vscode.Uri | undefined,
    missing: boolean,
  ): vscode.MarkdownString {
    const tooltip = new vscode.MarkdownString();
    if (bookmark.note) tooltip.appendMarkdown(`**${escapeMarkdown(bookmark.note)}**\n\n`);
    tooltip.appendMarkdown(`${escapeMarkdown(locationLabel(bookmark))}:${line + 1}\n\n`);
    if (bookmark.anchorText) tooltip.appendCodeblock(bookmark.anchorText.trim());
    // 跳不过去时说明原因，而不是让书签看起来像坏了。
    if (uri === undefined) tooltip.appendMarkdown('\n\n所属工作区当前未打开，暂时无法跳转。');
    else if (missing) tooltip.appendMarkdown('\n\n文件已被删除，书签保留待恢复。');
    return tooltip;
  }
}

export function nodeId(node: TreeNode): string {
  return node.kind === 'folder' ? node.folder.id : node.bookmark.id;
}

function themeColor(color: BookmarkColor | undefined): vscode.ThemeColor {
  return new vscode.ThemeColor(`myBookmark.color.${color ?? 'default'}`);
}

const BOOKMARK_SHAPE = 'M4.8 21V4.5A2.1 2.1 0 0 1 6.9 2.4h10.2A2.1 2.1 0 0 1 19.2 4.5V21L12 17.2z';

// 填充色对齐 VS Code charts.* 默认值。ThemeIcon 选中时会被列表前景色盖掉，所以改用图片。
const BOOKMARK_ICONS: Record<BookmarkColor | 'default', { light: vscode.Uri; dark: vscode.Uri }> = {
  default: { light: svgIcon('#616161'), dark: svgIcon('#CCCCCC') },
  red: { light: svgIcon('#E51400'), dark: svgIcon('#F14C4C') },
  orange: { light: svgIcon('#D18616'), dark: svgIcon('#D18616') },
  yellow: { light: svgIcon('#B89500'), dark: svgIcon('#B89500') },
  green: { light: svgIcon('#388A34'), dark: svgIcon('#89D185') },
  blue: { light: svgIcon('#1A85FF'), dark: svgIcon('#3794FF') },
  purple: { light: svgIcon('#652D90'), dark: svgIcon('#B180D7') },
  gray: { light: svgIcon('#616161'), dark: svgIcon('#CCCCCC') },
};

export function bookmarkIcon(color: BookmarkColor | undefined): { light: vscode.Uri; dark: vscode.Uri } {
  return BOOKMARK_ICONS[color ?? 'default'];
}

function svgIcon(fill: string): vscode.Uri {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="${fill}" d="${BOOKMARK_SHAPE}"/></svg>`;
  return vscode.Uri.parse(`data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`);
}

function locationLabel(bookmark: Bookmark): string {
  return bookmark.location.kind === 'workspace'
    ? `${bookmark.location.folderName}/${bookmark.location.relativePath}`
    : bookmark.location.fsPath;
}

function basename(pathLike: string): string {
  const index = pathLike.lastIndexOf('/');
  return index < 0 ? pathLike : pathLike.slice(index + 1);
}

function escapeMarkdown(text: string): string {
  return text.replace(/([\\`*_{}[\]()#+\-.!|])/g, '\\$1');
}
