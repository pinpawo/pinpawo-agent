import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

export type FileMentionItem = {
  path: string;
  type: 'directory' | 'file';
};

export type FileMentionModel =
  | {
      open: true;
      query: string;
      replacementStart: number;
      replacementEnd: number;
      selectedIndex: number;
      items: FileMentionItem[];
    }
  | {
      open: false;
      query: '';
      replacementStart: 0;
      replacementEnd: 0;
      selectedIndex: 0;
      items: [];
    };

export type FileMentionInput = {
  text: string;
  cursorOffset: number;
};

const CLOSED_FILE_MENTION: FileMentionModel = {
  open: false,
  query: '',
  replacementStart: 0,
  replacementEnd: 0,
  selectedIndex: 0,
  items: [],
};

const DEFAULT_LIMIT = 8;
const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next']);

export function buildFileMentionModel(
  input: FileMentionInput,
  rootDir: string,
  selectedIndex = 0,
): FileMentionModel {
  const mention = resolveActiveFileMention(input);
  if (!mention) return CLOSED_FILE_MENTION;

  const items = listFileMentionItems(rootDir, mention.query);
  return {
    open: true,
    query: mention.query,
    replacementStart: mention.start,
    replacementEnd: input.cursorOffset,
    selectedIndex: clampSelectedIndex(selectedIndex, items.length),
    items,
  };
}

export function moveFileMentionSelection(
  model: FileMentionModel,
  delta: -1 | 1,
): number {
  if (!model.open || model.items.length === 0) return 0;
  return clampSelectedIndex(model.selectedIndex + delta, model.items.length);
}

export function completeFileMentionInput(
  input: FileMentionInput,
  model: FileMentionModel,
): FileMentionInput | null {
  if (!model.open) return null;
  const item = model.items[model.selectedIndex];
  if (!item) return null;

  const replacement = `@${item.path}${item.type === 'file' ? ' ' : ''}`;
  const text = [
    input.text.slice(0, model.replacementStart),
    replacement,
    input.text.slice(model.replacementEnd),
  ].join('');
  const cursorOffset = model.replacementStart + replacement.length;
  return { text, cursorOffset };
}

export function listFileMentionItems(
  rootDir: string,
  query: string,
  limit = DEFAULT_LIMIT,
): FileMentionItem[] {
  const root = path.resolve(rootDir);
  const normalizedQuery = query.replace(/\\/g, '/').replace(/^\.?\//, '');
  if (normalizedQuery.includes('..')) return [];

  const slashIndex = normalizedQuery.lastIndexOf('/');
  const dirPrefix = slashIndex >= 0 ? normalizedQuery.slice(0, slashIndex + 1) : '';
  const basenamePrefix = slashIndex >= 0 ? normalizedQuery.slice(slashIndex + 1) : normalizedQuery;
  if (dirPrefix.split('/').some((segment) => IGNORED_DIRS.has(segment))) return [];
  const searchDir = path.resolve(root, dirPrefix || '.');
  if (!isInsideRoot(searchDir, root)) return [];

  let entries: string[];
  try {
    entries = readdirSync(searchDir);
  } catch {
    return [];
  }

  const showHidden = basenamePrefix.startsWith('.');
  return entries
    .filter((entry) => showHidden || !entry.startsWith('.'))
    .filter((entry) => entry.startsWith(basenamePrefix))
    .map((entry): FileMentionItem | null => {
      const absolutePath = path.join(searchDir, entry);
      let stat;
      try {
        stat = statSync(absolutePath);
      } catch {
        return null;
      }
      if (!stat.isDirectory() && !stat.isFile()) return null;
      if (stat.isDirectory() && IGNORED_DIRS.has(entry)) return null;
      const type = stat.isDirectory() ? 'directory' : 'file';
      return {
        type,
        path: `${dirPrefix}${entry}${type === 'directory' ? '/' : ''}`,
      };
    })
    .filter((item): item is FileMentionItem => Boolean(item))
    .sort(compareFileMentionItems)
    .slice(0, Math.max(0, limit));
}

function resolveActiveFileMention(input: FileMentionInput): { query: string; start: number } | null {
  if (input.cursorOffset < 0 || input.cursorOffset > input.text.length) return null;
  const beforeCursor = input.text.slice(0, input.cursorOffset);
  const tokenStart = Math.max(
    beforeCursor.lastIndexOf(' '),
    beforeCursor.lastIndexOf('\n'),
    beforeCursor.lastIndexOf('\t'),
  ) + 1;
  const token = beforeCursor.slice(tokenStart);
  if (!token.startsWith('@')) return null;
  const query = token.slice(1);
  if (!/^[^\s@]*$/.test(query)) return null;
  return { query, start: tokenStart };
}

function compareFileMentionItems(a: FileMentionItem, b: FileMentionItem) {
  if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
  return a.path.localeCompare(b.path);
}

function clampSelectedIndex(index: number, itemCount: number) {
  if (itemCount <= 0) return 0;
  return Math.max(0, Math.min(itemCount - 1, index));
}

function isInsideRoot(candidate: string, root: string) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
