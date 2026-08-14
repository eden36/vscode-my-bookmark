import * as vscode from 'vscode';

export type BookmarkScope = 'currentWorkspace' | 'all';
export type SortMode = 'manual' | 'path' | 'created' | 'note';

export interface MyBookmarkConfig {
  dataDirectory: string;
  syncEnabled: boolean;
  syncIntervalMinutes: number;
  scope: BookmarkScope;
  sortMode: SortMode;
  showNoteInEditor: boolean;
  pathMappings: Record<string, string>;
}

const SECTION = 'myBookmark';

export function readConfig(): MyBookmarkConfig {
  const config = vscode.workspace.getConfiguration(SECTION);
  return {
    dataDirectory: config.get<string>('dataDirectory', '').trim(),
    syncEnabled: config.get<boolean>('sync.enabled', true),
    // 用户可以把间隔写成任意数字，钳制到设置里声明的范围，避免出现 0 或负数的定时器。
    syncIntervalMinutes: clamp(config.get<number>('sync.intervalMinutes', 5), 1, 120),
    scope: config.get<BookmarkScope>('scope', 'currentWorkspace'),
    sortMode: config.get<SortMode>('sortMode', 'manual'),
    showNoteInEditor: config.get<boolean>('showNoteInEditor', true),
    pathMappings: sanitizeMappings(config.get<unknown>('pathMappings')),
  };
}

export async function updateScope(scope: BookmarkScope): Promise<void> {
  await vscode.workspace.getConfiguration(SECTION).update('scope', scope, vscode.ConfigurationTarget.Global);
}

export function onDidChangeConfig(listener: () => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration(SECTION)) listener();
  });
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function sanitizeMappings(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[0].length > 0),
  );
}
