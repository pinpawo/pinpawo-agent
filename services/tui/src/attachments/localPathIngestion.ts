import {
  constants,
  accessSync,
  statSync,
} from 'node:fs';
import {
  basename,
  isAbsolute,
  normalize,
  win32,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentLocalAttachment } from '@pinpawo/agent-session';

export type LocalPathPasteResult =
  | {
      kind: 'text';
      pathLike: false;
    }
  | {
      kind: 'text';
      pathLike: true;
      issue: string;
    }
  | {
      kind: 'attachments';
      attachments: AgentLocalAttachment[];
      duplicateCount: number;
    };

export type LocalPathIngestionOptions = {
  existingPaths?: ReadonlySet<string>;
  idFactory?: () => string;
};

export function ingestLocalPathPaste(
  input: string,
  options: LocalPathIngestionOptions = {},
): LocalPathPasteResult {
  const candidates = parseLocalPathCandidates(input);
  if (!candidates) {
    return { kind: 'text', pathLike: false };
  }

  const attachments: AgentLocalAttachment[] = [];
  const seen = new Set(options.existingPaths ?? []);
  let duplicateCount = 0;
  for (const candidate of candidates) {
    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(candidate);
      accessSync(candidate, constants.R_OK);
    } catch {
      return {
        kind: 'text',
        pathLike: true,
        issue: `path is unavailable or unreadable: ${candidate}`,
      };
    }
    const kind = stat.isFile()
      ? 'file'
      : stat.isDirectory()
        ? 'directory'
        : null;
    if (!kind) {
      return {
        kind: 'text',
        pathLike: true,
        issue: `unsupported local path type: ${candidate}`,
      };
    }
    if (seen.has(candidate)) {
      duplicateCount += 1;
      continue;
    }
    seen.add(candidate);
    attachments.push({
      id: options.idFactory?.() ?? crypto.randomUUID(),
      source: 'local-path',
      kind,
      path: candidate,
      name: basename(candidate) || candidate,
    });
  }
  return { kind: 'attachments', attachments, duplicateCount };
}

export function parseLocalPathCandidates(input: string): string[] | null {
  const trimmed = input.trim();
  if (!trimmed || trimmed.includes('\0')) return null;

  const words = tokenizeShellWords(trimmed);
  const parsedWords = words?.map(normalizeLocalPathToken) ?? null;
  if (
    parsedWords
    && parsedWords.length > 0
    && parsedWords.length <= 20
    && parsedWords.every((path): path is string => Boolean(path))
  ) {
    return dedupePaths(parsedWords);
  }

  const wholePath = normalizeLocalPathToken(trimmed);
  return wholePath ? [wholePath] : null;
}

function normalizeLocalPathToken(token: string): string | null {
  let path = token;
  if (path.startsWith('file://')) {
    try {
      path = fileURLToPath(path);
    } catch {
      return null;
    }
  }
  if (!isAbsolute(path) && !win32.isAbsolute(path) && !path.startsWith('\\\\')) {
    return null;
  }
  return normalize(path);
}

function tokenizeShellWords(input: string): string[] | null {
  const words: string[] = [];
  let current = '';
  let quote: "'" | '"' | null = null;
  let escaping = false;

  for (const character of input) {
    if (escaping) {
      current += character;
      escaping = false;
      continue;
    }
    if (quote === "'") {
      if (character === "'") {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }
    if (quote === '"') {
      if (character === '"') {
        quote = null;
      } else if (character === '\\') {
        escaping = true;
      } else {
        current += character;
      }
      continue;
    }
    if (character === '\\') {
      escaping = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current) {
        words.push(current);
        current = '';
      }
      continue;
    }
    current += character;
  }

  if (escaping || quote) return null;
  if (current) words.push(current);
  return words.length ? words : null;
}

function dedupePaths(paths: string[]) {
  return [...new Set(paths)];
}
