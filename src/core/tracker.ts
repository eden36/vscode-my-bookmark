/**
 * 行号跟踪：把一次文档编辑折算成书签行号的位移。
 *
 * 刻意不引用 vscode 的类型，调用方负责把 TextDocumentContentChangeEvent 转换成 LineEdit。
 */

export interface LineEdit {
  /** 被替换区间的起始行（0 起，含）。 */
  startLine: number;
  /** 被替换区间的结束行（0 起，不含）。等于 startLine 表示纯插入。 */
  endLineExclusive: number;
  /** 替换文本引入的换行数，即新内容比原内容多出的行数基准。 */
  insertedLineCount: number;
}

export interface TrackedLine {
  id: string;
  line: number;
}

export interface TrackResult {
  /** 位置发生变化的书签及其新行号；未受影响的不会出现在这里。 */
  moved: TrackedLine[];
  /** 所在行被整体删除的书签 id。 */
  removed: string[];
}

/**
 * 应用一组编辑，返回受影响的书签。
 *
 * 多个编辑必须从文档末尾向前处理：VS Code 给出的各个变更坐标都是相对**同一份**编辑前
 * 文档的，先处理靠前的变更会让后面变更的坐标失效。
 */
export function applyLineEdits(lines: readonly TrackedLine[], edits: readonly LineEdit[]): TrackResult {
  if (lines.length === 0 || edits.length === 0) return { moved: [], removed: [] };

  const current = new Map(lines.map((entry) => [entry.id, entry.line]));
  const removed = new Set<string>();
  const ordered = [...edits].sort((left, right) => right.startLine - left.startLine);

  for (const edit of ordered) {
    const deletedLineCount = edit.endLineExclusive - edit.startLine;
    const delta = edit.insertedLineCount - deletedLineCount;
    for (const [id, line] of current) {
      if (removed.has(id)) continue;
      // 被删除区间内部的书签失去了依附的行；区间起始行本身保留，编辑通常只是改写该行。
      if (deletedLineCount > 0 && line > edit.startLine && line < edit.endLineExclusive) {
        removed.add(id);
        continue;
      }
      if (line >= edit.endLineExclusive) current.set(id, line + delta);
    }
  }

  const moved: TrackedLine[] = [];
  for (const entry of lines) {
    if (removed.has(entry.id)) continue;
    const line = current.get(entry.id);
    if (line !== undefined && line !== entry.line) moved.push({ id: entry.id, line: Math.max(0, line) });
  }
  return { moved, removed: [...removed] };
}

/**
 * 用锚点文本在给定行号附近重新定位。
 *
 * 返回 undefined 表示放弃重定位（保留原行号）。宁可不动也不能猜错：锚点文本很可能是
 * `}` 这类在窗口内反复出现的内容，一旦选错行，书签会指到毫不相干的地方。
 */
export function reanchor(
  documentLines: readonly string[],
  anchorText: string,
  expectedLine: number,
  windowSize = 50,
): number | undefined {
  const anchor = anchorText.trim();
  if (anchor.length === 0) return undefined;
  if (documentLines[expectedLine]?.trim() === anchor) return expectedLine;

  const from = Math.max(0, expectedLine - windowSize);
  const to = Math.min(documentLines.length - 1, expectedLine + windowSize);
  let match: number | undefined;
  for (let line = from; line <= to; line += 1) {
    if (documentLines[line]?.trim() !== anchor) continue;
    // 窗口内出现第二处匹配就说明锚点没有区分度，此时任何选择都是猜测。
    if (match !== undefined) return undefined;
    match = line;
  }
  return match;
}
