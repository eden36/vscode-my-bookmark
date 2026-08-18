import * as vscode from 'vscode';
import type { BookmarkService } from './bookmark-service';
import { BOOKMARK_COLORS, type BookmarkColor } from './core/model';

type ColorKey = BookmarkColor | 'default';

const COLOR_KEYS: ColorKey[] = ['default', ...BOOKMARK_COLORS];

/**
 * 编辑器内的书签装饰：装订线图标、概览标尺色块、行尾备注。
 *
 * 装饰类型是有成本的资源，按颜色各建一个复用，绝不按书签创建。
 */
export class BookmarkDecorations implements vscode.Disposable {
  private readonly types = new Map<ColorKey, vscode.TextEditorDecorationType>();

  constructor(private readonly service: BookmarkService, private showNote: boolean) {
    for (const key of COLOR_KEYS) {
      const color = new vscode.ThemeColor(`myBookmark.color.${key}`);
      this.types.set(key, vscode.window.createTextEditorDecorationType({
        gutterIconPath: gutterIcon(),
        gutterIconSize: 'contain',
        overviewRulerColor: color,
        overviewRulerLane: vscode.OverviewRulerLane.Right,
        // 钉在行号上，不跟着文本区间两端生长，避免一次换行把标签撑成跨行代码块。
        rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
        // 装订线图标是单色 SVG，靠 ThemeColor 无法着色，因此用行尾文本承载颜色区分。
        light: { after: { color } },
        dark: { after: { color } },
      }));
    }
  }

  setShowNote(showNote: boolean): void {
    this.showNote = showNote;
  }

  dispose(): void {
    for (const type of this.types.values()) type.dispose();
    this.types.clear();
  }

  refreshAll(): void {
    for (const editor of vscode.window.visibleTextEditors) this.refresh(editor);
  }

  refresh(editor: vscode.TextEditor): void {
    const grouped = new Map<ColorKey, vscode.DecorationOptions[]>();
    for (const key of COLOR_KEYS) grouped.set(key, []);

    for (const bookmark of this.service.getBookmarksForDocument(editor.document.uri)) {
      const line = this.service.getLine(bookmark);
      // 外部改动可能让行号短暂越界，跳过即可，等重锚定把它修正回来。
      if (line >= editor.document.lineCount) continue;
      // 每次按当前行号现算这一行的范围，不沿用可被编辑撑成多行的旧区间。
      const range = editor.document.lineAt(line).range;
      const note = this.showNote ? bookmark.note?.trim() : undefined;
      grouped.get(bookmark.color ?? 'default')!.push({
        range,
        ...(note ? { renderOptions: { after: { contentText: `  ${note}`, fontStyle: 'italic' } } } : {}),
      });
    }

    for (const [key, type] of this.types) editor.setDecorations(type, grouped.get(key) ?? []);
  }
}

/** 内联 SVG，避免依赖打包后的相对路径，也免去为每种颜色准备一份图片。造型与 media/icon.svg 一致。 */
function gutterIcon(): vscode.Uri {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none">'
    + '<path fill="none" stroke="#5b9bd5" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'
    + ' d="M4.8 21V4.5A2.1 2.1 0 0 1 6.9 2.4h10.2A2.1 2.1 0 0 1 19.2 4.5V21L12 17.2z"/>'
    + '<path fill="none" stroke="#5b9bd5" stroke-width="2" stroke-linecap="round" d="M8.1 8h7.8M8.1 11.7h7.8"/>'
    + '</svg>';
  return vscode.Uri.parse(`data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`);
}
