import { describe, expect, it } from 'vitest';
import {
  belongsToWorkspace,
  normalizePath,
  resolveLocation,
  rewritePrefix,
  toLocation,
  type WorkspaceFolderInfo,
} from '../src/core/resolver';

const folders: WorkspaceFolderInfo[] = [
  { name: 'demo', fsPath: 'D:\\projects\\demo' },
  { name: 'nested', fsPath: 'D:\\projects\\demo\\packages\\nested' },
];

describe('路径归一化', () => {
  it('统一分隔符并去掉冗余斜杠', () => {
    expect(normalizePath('D:\\projects\\demo\\')).toBe('D:/projects/demo');
    expect(normalizePath('/home//user/proj/')).toBe('/home/user/proj');
    expect(normalizePath('/')).toBe('/');
  });
});

describe('绝对路径归入工作区', () => {
  it('落在工作区内时记录工作区名与相对路径', () => {
    expect(toLocation('D:\\projects\\demo\\src\\main.ts', folders)).toEqual({
      kind: 'workspace',
      folderName: 'demo',
      relativePath: 'src/main.ts',
    });
  });

  it('工作区嵌套时取最具体的那一个', () => {
    expect(toLocation('D:\\projects\\demo\\packages\\nested\\index.ts', folders)).toEqual({
      kind: 'workspace',
      folderName: 'nested',
      relativePath: 'index.ts',
    });
  });

  it('Windows 下路径大小写不影响匹配', () => {
    expect(toLocation('d:\\PROJECTS\\Demo\\src\\main.ts', folders)).toMatchObject({
      kind: 'workspace',
      folderName: 'demo',
    });
  });

  it('显式要求大小写敏感时不再匹配', () => {
    expect(toLocation('d:\\PROJECTS\\Demo\\src\\main.ts', folders, { caseSensitive: true })).toEqual({
      kind: 'external',
      fsPath: 'd:/PROJECTS/Demo/src/main.ts',
    });
  });

  it('工作区外的文件退回绝对路径', () => {
    expect(toLocation('C:\\temp\\scratch.ts', folders)).toEqual({
      kind: 'external',
      fsPath: 'C:/temp/scratch.ts',
    });
  });

  it('同名前缀不算落在工作区内', () => {
    expect(toLocation('D:\\projects\\demo-2\\src\\main.ts', folders)).toEqual({
      kind: 'external',
      fsPath: 'D:/projects/demo-2/src/main.ts',
    });
  });
});

describe('解析回绝对路径', () => {
  it('按工作区名拼回路径，与原盘符无关', () => {
    const location = toLocation('D:\\projects\\demo\\src\\main.ts', folders);

    expect(resolveLocation(location, [{ name: 'demo', fsPath: '/home/u/demo' }])).toBe('/home/u/demo/src/main.ts');
  });

  it('工作区未打开时返回 undefined，交由上层标记为暂不可用', () => {
    const location = toLocation('D:\\projects\\demo\\src\\main.ts', folders);

    expect(resolveLocation(location, [])).toBeUndefined();
  });

  it('工作区外的路径可经映射转换到本机', () => {
    const location = { kind: 'external', fsPath: 'D:/scratch/notes.md' } as const;

    expect(resolveLocation(location, [], { pathMappings: { 'D:\\scratch': '/home/u/scratch' } }))
      .toBe('/home/u/scratch/notes.md');
    expect(resolveLocation(location, [])).toBe('D:/scratch/notes.md');
  });
});

describe('工作区归属', () => {
  it('只有工作区内且该工作区已打开才算归属', () => {
    const inside = toLocation('D:\\projects\\demo\\src\\main.ts', folders);
    const outside = toLocation('C:\\temp\\scratch.ts', folders);

    expect(belongsToWorkspace(inside, folders)).toBe(true);
    expect(belongsToWorkspace(inside, [])).toBe(false);
    expect(belongsToWorkspace(outside, folders)).toBe(false);
  });
});

describe('目录改名后的前缀重写', () => {
  it('改写位于被改名目录下的路径', () => {
    const location = { kind: 'external', fsPath: 'D:/old/sub/file.ts' } as const;

    expect(rewritePrefix(location, 'D:\\old', 'D:\\new')).toEqual({
      kind: 'external',
      fsPath: 'D:/new/sub/file.ts',
    });
  });

  it('不在该目录下时返回 undefined', () => {
    const location = { kind: 'external', fsPath: 'D:/other/file.ts' } as const;

    expect(rewritePrefix(location, 'D:\\old', 'D:\\new')).toBeUndefined();
  });

  it('工作区内的书签不受绝对路径改名影响', () => {
    const location = toLocation('D:\\projects\\demo\\src\\main.ts', folders);

    expect(rewritePrefix(location, 'D:\\projects\\demo', 'D:\\projects\\renamed')).toBeUndefined();
  });
});
