import {
  readdirSync,
  realpathSync,
  statSync,
  type Dirent,
} from 'node:fs';
import path from 'node:path';

export type FileMentionItem = {
  path: string;
  type: 'directory' | 'file';
};

export type FileMentionState =
  | { phase: 'closed' }
  | {
      phase: 'open';
      query: string;
      replacementStart: number;
      replacementEnd: number;
      selectedIndex: number;
      items: FileMentionItem[];
    };

export type FileMentionAction =
  | 'previous'
  | 'next'
  | 'complete'
  | 'dismiss'
  | null;

export type FileMentionInput = {
  text: string;
  cursorOffset: number;
};

const DEFAULT_LIMIT = 6;
const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.next',
  'build',
  'dist',
  'node_modules',
]);

export function createFileMentionState(): FileMentionState {
  return { phase: 'closed' };
}

export function syncFileMention(
  state: FileMentionState,
  input: FileMentionInput,
  rootDir: string,
  enabled: boolean,
): FileMentionState {
  if (!enabled) return createFileMentionState();
  const mention = resolveActiveFileMention(input);
  if (!mention) return createFileMentionState();
  const selectedIndex = state.phase === 'open'
    && state.query === mention.query
    && state.replacementStart === mention.start
    && state.replacementEnd === mention.end
    ? state.selectedIndex
    : 0;
  const items = listFileMentionItems(rootDir, mention.query);
  return {
    phase: 'open',
    query: mention.query,
    replacementStart: mention.start,
    replacementEnd: mention.end,
    selectedIndex: clampIndex(selectedIndex, items.length),
    items,
  };
}

export function moveFileMentionSelection(
  state: FileMentionState,
  delta: -1 | 1,
): FileMentionState {
  if (state.phase !== 'open' || state.items.length === 0) return state;
  return {
    ...state,
    selectedIndex: clampIndex(
      state.selectedIndex + delta,
      state.items.length,
    ),
  };
}

export function completeFileMention(
  input: FileMentionInput,
  state: FileMentionState,
): FileMentionInput | null {
  if (state.phase !== 'open') return null;
  const item = state.items[state.selectedIndex];
  if (!item) return null;
  const replacement = `@${item.path}${item.type === 'file' ? ' ' : ''}`;
  return {
    text: [
      input.text.slice(0, state.replacementStart),
      replacement,
      input.text.slice(state.replacementEnd),
    ].join(''),
    cursorOffset: state.replacementStart + replacement.length,
  };
}

export function resolveFileMentionKey(
  state: FileMentionState,
  key: {
    name?: string;
    ctrl?: boolean;
    shift?: boolean;
    meta?: boolean;
    option?: boolean;
    super?: boolean;
  },
): FileMentionAction {
  if (
    state.phase !== 'open'
    || key.ctrl
    || key.shift
    || key.meta
    || key.option
    || key.super
  ) {
    return null;
  }
  if (key.name === 'up') return 'previous';
  if (key.name === 'down') return 'next';
  if (key.name === 'tab' || key.name === 'return') return 'complete';
  if (key.name === 'escape') return 'dismiss';
  return null;
}

export function listFileMentionItems(
  rootDir: string,
  query: string,
  limit = DEFAULT_LIMIT,
): FileMentionItem[] {
  const normalizedQuery = query
    .replace(/\\/g, '/')
    .replace(/^\.?\//, '');
  const segments = normalizedQuery.split('/');
  if (segments.some((segment) => segment === '..')) return [];

  const slashIndex = normalizedQuery.lastIndexOf('/');
  const dirPrefix = slashIndex >= 0
    ? normalizedQuery.slice(0, slashIndex + 1)
    : '';
  const basenamePrefix = slashIndex >= 0
    ? normalizedQuery.slice(slashIndex + 1)
    : normalizedQuery;
  if (
    dirPrefix
      .split('/')
      .some((segment) => IGNORED_DIRECTORIES.has(segment))
  ) {
    return [];
  }

  let root: string;
  let searchDir: string;
  try {
    root = realpathSync(path.resolve(rootDir));
    searchDir = realpathSync(path.resolve(root, dirPrefix || '.'));
  } catch {
    return [];
  }
  if (!isInsideRoot(searchDir, root)) return [];

  let entries: Dirent[];
  try {
    entries = readdirSync(searchDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const showHidden = basenamePrefix.startsWith('.');
  return entries
    .filter((entry) => showHidden || !entry.name.startsWith('.'))
    .filter((entry) => entry.name.startsWith(basenamePrefix))
    .map((entry): FileMentionItem | null => {
      const candidate = path.join(searchDir, entry.name);
      try {
        let type: FileMentionItem['type'];
        if (entry.isDirectory()) {
          type = 'directory';
        } else if (entry.isFile()) {
          type = 'file';
        } else if (entry.isSymbolicLink()) {
          const resolvedCandidate = realpathSync(candidate);
          if (!isInsideRoot(resolvedCandidate, root)) return null;
          const stat = statSync(resolvedCandidate);
          if (!stat.isDirectory() && !stat.isFile()) return null;
          type = stat.isDirectory() ? 'directory' : 'file';
        } else {
          return null;
        }
        if (
          type === 'directory'
          && IGNORED_DIRECTORIES.has(entry.name)
        ) {
          return null;
        }
        return {
          type,
          path: `${dirPrefix}${entry.name}${type === 'directory' ? '/' : ''}`,
        };
      } catch {
        return null;
      }
    })
    .filter((item): item is FileMentionItem => item !== null)
    .sort(compareFileMentionItems)
    .slice(0, Math.max(0, limit));
}

function resolveActiveFileMention(input: FileMentionInput) {
  if (
    input.cursorOffset < 0
    || input.cursorOffset > input.text.length
  ) {
    return null;
  }
  const beforeCursor = input.text.slice(0, input.cursorOffset);
  const tokenStart = Math.max(
    beforeCursor.lastIndexOf(' '),
    beforeCursor.lastIndexOf('\n'),
    beforeCursor.lastIndexOf('\t'),
  ) + 1;
  const suffix = input.text.slice(input.cursorOffset);
  const whitespaceOffset = suffix.search(/\s/);
  const tokenEnd = whitespaceOffset < 0
    ? input.text.length
    : input.cursorOffset + whitespaceOffset;
  const token = input.text.slice(tokenStart, tokenEnd);
  if (!/^@[^\s@]*$/.test(token)) return null;
  return {
    query: beforeCursor.slice(tokenStart + 1),
    start: tokenStart,
    end: tokenEnd,
  };
}

function compareFileMentionItems(a: FileMentionItem, b: FileMentionItem) {
  if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
  return a.path.localeCompare(b.path);
}

function clampIndex(index: number, itemCount: number) {
  if (itemCount <= 0) return 0;
  return Math.max(0, Math.min(itemCount - 1, index));
}

function isInsideRoot(candidate: string, root: string) {
  const relative = path.relative(root, candidate);
  return relative === ''
    || (!relative.startsWith('..') && !path.isAbsolute(relative));
}
