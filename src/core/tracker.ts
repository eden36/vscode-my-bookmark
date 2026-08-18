/**
 * 行号跟踪：把一次文档编辑折算成书签行号的位移。
 *
 * 书签只钉在单行行号上，不跟踪代码块区间。编辑落在某行上时该行书签不动；
 * 只有严格在该行之后的书签才整体平移。刻意不引用 vscode 的类型，调用方负责
 * 把 TextDocumentContentChangeEvent 转换成 LineEdit。
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

/**
 * 应用一组编辑，返回行号发生变化的书签。未受影响的不会出现在结果里。
 *
 * 多个编辑必须从文档末尾向前处理：VS Code 给出的各个变更坐标都是相对**同一份**编辑前
 * 文档的，先处理靠前的变更会让后面变更的坐标失效。
 */
export function applyLineEdits(lines: readonly TrackedLine[], edits: readonly LineEdit[]): TrackedLine[] {
  if (lines.length === 0 || edits.length === 0) return [];

  const current = new Map(lines.map((entry) => [entry.id, entry.line]));
  const ordered = [...edits].sort((left, right) => right.startLine - left.startLine);

  for (const edit of ordered) {
    const delta = edit.insertedLineCount - (edit.endLineExclusive - edit.startLine);
    if (delta === 0) continue;
    for (const [id, line] of current) {
      if (line >= edit.endLineExclusive) current.set(id, Math.max(0, line + delta));
    }
  }

  const moved: TrackedLine[] = [];
  for (const entry of lines) {
    const line = current.get(entry.id);
    if (line !== undefined && line !== entry.line) moved.push({ id: entry.id, line });
  }
  return moved;
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
