import { describe, expect, it } from 'vitest';
import { applyLineEdits, reanchor, type LineEdit } from '../src/core/tracker';

const lines = [
  { id: 'a', line: 5 },
  { id: 'b', line: 10 },
  { id: 'c', line: 20 },
];

describe('行号跟踪', () => {
  it('无书签或无编辑时不做任何事', () => {
    expect(applyLineEdits([], [insert(0, 3)])).toEqual({ moved: [], removed: [] });
    expect(applyLineEdits(lines, [])).toEqual({ moved: [], removed: [] });
  });

  it('在上方插入行时后续书签整体下移', () => {
    const result = applyLineEdits(lines, [insert(2, 3)]);

    expect(result.removed).toEqual([]);
    expect(result.moved).toEqual([
      { id: 'a', line: 8 },
      { id: 'b', line: 13 },
      { id: 'c', line: 23 },
    ]);
  });

  it('在下方编辑不影响上方书签', () => {
    const result = applyLineEdits(lines, [insert(30, 5)]);

    expect(result).toEqual({ moved: [], removed: [] });
  });

  it('删除上方的行时后续书签上移', () => {
    const result = applyLineEdits(lines, [remove(0, 3)]);

    expect(result.moved).toEqual([
      { id: 'a', line: 2 },
      { id: 'b', line: 7 },
      { id: 'c', line: 17 },
    ]);
  });

  it('书签所在行被整体删除时标记移除', () => {
    const result = applyLineEdits(lines, [remove(8, 12)]);

    expect(result.removed).toEqual(['b']);
    expect(result.moved).toEqual([{ id: 'c', line: 16 }]);
  });

  it('只改写书签所在行本身时保留书签', () => {
    const result = applyLineEdits(lines, [{ startLine: 10, endLineExclusive: 11, insertedLineCount: 1 }]);

    expect(result.removed).toEqual([]);
  });

  it('多个编辑按位置从后往前处理，坐标互不污染', () => {
    // 两个变更的坐标都相对同一份编辑前的文档；若从前往后处理，第二个变更会用到已失效的行号。
    const result = applyLineEdits(lines, [insert(0, 2), insert(15, 4)]);

    expect(result.moved).toEqual([
      { id: 'a', line: 7 },
      { id: 'b', line: 12 },
      { id: 'c', line: 26 },
    ]);
  });

  it('行号不会被推成负数', () => {
    const result = applyLineEdits([{ id: 'a', line: 1 }], [remove(0, 10)]);

    expect(result.removed).toEqual(['a']);
  });
});

describe('锚点重定位', () => {
  const document = ['const a = 1;', 'const b = 2;', '', 'function demo() {', '  return 1;', '}'];

  it('原行号仍匹配时保持不动', () => {
    expect(reanchor(document, 'function demo() {', 3)).toBe(3);
  });

  it('内容位移后在窗口内找回', () => {
    expect(reanchor(document, 'function demo() {', 0)).toBe(3);
  });

  it('忽略缩进差异', () => {
    expect(reanchor(document, 'return 1;', 4)).toBe(4);
  });

  it('窗口内存在多处相同锚点时放弃重定位', () => {
    // 锚点没有区分度时任何选择都是猜测，宁可保留原行号也不能指到无关位置。
    expect(reanchor(['}', 'x', '}'], '}', 1)).toBeUndefined();
  });

  it('找不到锚点或锚点为空时返回 undefined', () => {
    expect(reanchor(document, 'never-exists', 0)).toBeUndefined();
    expect(reanchor(document, '   ', 0)).toBeUndefined();
  });

  it('超出窗口范围的匹配不会被采纳', () => {
    const long = Array.from({ length: 200 }, (_, index) => `line ${index}`);

    expect(reanchor(long, 'line 199', 0, 50)).toBeUndefined();
    expect(reanchor(long, 'line 40', 0, 50)).toBe(40);
  });
});

function insert(startLine: number, count: number): LineEdit {
  return { startLine, endLineExclusive: startLine, insertedLineCount: count };
}

function remove(startLine: number, endLineExclusive: number): LineEdit {
  return { startLine, endLineExclusive, insertedLineCount: 0 };
}
