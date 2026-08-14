import type { Bookmark, BookmarkFolder } from '../src/core/model';

let counter = 0;

export function resetFixtureCounter(): void {
  counter = 0;
}

export function bookmark(overrides: Partial<Bookmark> = {}): Bookmark {
  counter += 1;
  return {
    id: `bookmark-${counter}`,
    location: { kind: 'workspace', folderName: 'demo', relativePath: `src/file-${counter}.ts` },
    line: 0,
    order: 'a0',
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

export function folder(overrides: Partial<BookmarkFolder> = {}): BookmarkFolder {
  counter += 1;
  return {
    id: `folder-${counter}`,
    name: `分组 ${counter}`,
    order: 'a0',
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}
