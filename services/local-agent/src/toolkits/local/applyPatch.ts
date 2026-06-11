/**
 * V4A patch format (Codex-style apply_patch) parser and applier.
 *
 * Envelope grammar:
 *
 *   *** Begin Patch
 *   *** Add File: <path>
 *   +<content line>
 *   *** Update File: <path>
 *   [*** Move to: <new path>]
 *   @@ <optional context anchor>
 *    <context line>
 *   -<removed line>
 *   +<added line>
 *   [*** End of File]
 *   *** Delete File: <path>
 *   *** End Patch
 *
 * Update chunks locate themselves by context lines, never by line numbers.
 * Matching falls back through a whitespace-tolerance cascade:
 * exact -> ignore trailing whitespace -> ignore surrounding whitespace.
 */

export const PATCH_BEGIN = '*** Begin Patch';
export const PATCH_END = '*** End Patch';
const ADD_FILE_PREFIX = '*** Add File: ';
const UPDATE_FILE_PREFIX = '*** Update File: ';
const DELETE_FILE_PREFIX = '*** Delete File: ';
const MOVE_TO_PREFIX = '*** Move to: ';
const END_OF_FILE_MARKER = '*** End of File';

export interface PatchChunk {
  anchor: string | null;
  oldLines: string[];
  newLines: string[];
  isEndOfFile: boolean;
}

export type PatchOperation =
  | { type: 'add'; path: string; content: string }
  | { type: 'delete'; path: string }
  | { type: 'update'; path: string; moveTo: string | null; chunks: PatchChunk[] };

export interface AppliedChunk {
  startLine: number;
  removed: string[];
  added: string[];
  fuzz: 'exact' | 'ignore-trailing-whitespace' | 'ignore-whitespace';
}

export class PatchParseError extends Error {}
export class PatchApplyError extends Error {}

function parseError(lineIndex: number, message: string): never {
  throw new PatchParseError(`patch line ${lineIndex + 1}: ${message}`);
}

export function parsePatch(patchText: string): PatchOperation[] {
  const lines = patchText.replace(/\r\n/g, '\n').split('\n');

  let index = lines.findIndex((line) => line.trim() === PATCH_BEGIN);
  if (index === -1) {
    throw new PatchParseError(`patch must start with "${PATCH_BEGIN}"`);
  }
  index += 1;

  const operations: PatchOperation[] = [];
  const seenPaths = new Set<string>();

  const claimPath = (path: string, lineIndex: number) => {
    if (!path.trim()) {
      parseError(lineIndex, 'file path must not be empty');
    }
    const normalized = path.trim();
    if (seenPaths.has(normalized)) {
      parseError(lineIndex, `duplicate operation for ${normalized}`);
    }
    seenPaths.add(normalized);
    return normalized;
  };

  while (index < lines.length) {
    const line = lines[index] ?? '';
    const trimmed = line.trim();

    if (trimmed === PATCH_END) {
      if (operations.length === 0) {
        parseError(index, 'patch contains no file operations');
      }
      return operations;
    }

    if (trimmed === '') {
      index += 1;
      continue;
    }

    if (line.startsWith(ADD_FILE_PREFIX)) {
      const path = claimPath(line.slice(ADD_FILE_PREFIX.length), index);
      index += 1;
      const contentLines: string[] = [];
      while (index < lines.length) {
        const contentLine = lines[index] ?? '';
        if (contentLine.startsWith('***')) break;
        if (!contentLine.startsWith('+')) {
          parseError(index, `Add File lines must start with "+", got: ${contentLine.slice(0, 40)}`);
        }
        contentLines.push(contentLine.slice(1));
        index += 1;
      }
      operations.push({ type: 'add', path, content: contentLines.join('\n') });
      continue;
    }

    if (line.startsWith(DELETE_FILE_PREFIX)) {
      operations.push({ type: 'delete', path: claimPath(line.slice(DELETE_FILE_PREFIX.length), index) });
      index += 1;
      continue;
    }

    if (line.startsWith(UPDATE_FILE_PREFIX)) {
      const path = claimPath(line.slice(UPDATE_FILE_PREFIX.length), index);
      index += 1;

      let moveTo: string | null = null;
      if (lines[index]?.startsWith(MOVE_TO_PREFIX)) {
        moveTo = (lines[index] ?? '').slice(MOVE_TO_PREFIX.length).trim();
        if (!moveTo) {
          parseError(index, 'Move to path must not be empty');
        }
        index += 1;
      }

      const chunks: PatchChunk[] = [];
      let anchor: string | null = null;
      let oldLines: string[] = [];
      let newLines: string[] = [];
      let sawDiffLines = false;
      let isEndOfFile = false;

      const flushChunk = (lineIndex: number) => {
        if (!sawDiffLines) {
          if (anchor !== null) {
            parseError(lineIndex, `@@ anchor "${anchor}" has no diff lines`);
          }
          return;
        }
        chunks.push({ anchor, oldLines, newLines, isEndOfFile });
        anchor = null;
        oldLines = [];
        newLines = [];
        sawDiffLines = false;
        isEndOfFile = false;
      };

      while (index < lines.length) {
        const bodyLine = lines[index] ?? '';
        const bodyTrimmed = bodyLine.trim();

        if (bodyTrimmed === END_OF_FILE_MARKER) {
          isEndOfFile = true;
          index += 1;
          continue;
        }
        if (bodyLine.startsWith('***')) {
          break;
        }
        if (bodyLine.startsWith('@@')) {
          flushChunk(index);
          anchor = bodyLine.slice(2).trim() || null;
          index += 1;
          continue;
        }
        if (bodyLine.startsWith('+')) {
          newLines.push(bodyLine.slice(1));
          sawDiffLines = true;
        } else if (bodyLine.startsWith('-')) {
          oldLines.push(bodyLine.slice(1));
          sawDiffLines = true;
        } else if (bodyLine.startsWith(' ') || bodyTrimmed === '') {
          const context = bodyLine.startsWith(' ') ? bodyLine.slice(1) : '';
          oldLines.push(context);
          newLines.push(context);
          sawDiffLines = true;
        } else {
          parseError(index, `Update File lines must start with " ", "+", "-" or "@@", got: ${bodyLine.slice(0, 40)}`);
        }
        index += 1;
      }

      flushChunk(index);
      if (chunks.length === 0) {
        parseError(index, `Update File ${path} contains no chunks`);
      }
      operations.push({ type: 'update', path, moveTo, chunks });
      continue;
    }

    parseError(index, `unrecognized patch directive: ${trimmed.slice(0, 60)}`);
  }

  throw new PatchParseError(`patch must end with "${PATCH_END}"`);
}

function linesEqual(a: string, b: string, fuzz: AppliedChunk['fuzz']) {
  if (fuzz === 'exact') return a === b;
  if (fuzz === 'ignore-trailing-whitespace') return a.trimEnd() === b.trimEnd();
  return a.trim() === b.trim();
}

function findSequence(
  fileLines: string[],
  needle: string[],
  fromIndex: number,
): { index: number; fuzz: AppliedChunk['fuzz'] } | null {
  const fuzzLevels: AppliedChunk['fuzz'][] = ['exact', 'ignore-trailing-whitespace', 'ignore-whitespace'];
  for (const fuzz of fuzzLevels) {
    for (let start = fromIndex; start <= fileLines.length - needle.length; start += 1) {
      let matched = true;
      for (let offset = 0; offset < needle.length; offset += 1) {
        if (!linesEqual(fileLines[start + offset] ?? '', needle[offset] ?? '', fuzz)) {
          matched = false;
          break;
        }
      }
      if (matched) {
        return { index: start, fuzz };
      }
    }
  }
  return null;
}

function findAnchor(fileLines: string[], anchor: string, fromIndex: number): number | null {
  const result = findSequence(fileLines, [anchor], fromIndex);
  return result ? result.index : null;
}

function commonPrefixLength(a: string, b: string) {
  const max = Math.min(a.length, b.length);
  let length = 0;
  while (length < max && a[length] === b[length]) {
    length += 1;
  }
  return length;
}

function closestSnippet(fileLines: string[], needle: string[]): string | null {
  const probe = needle.find((line) => line.trim().length > 0);
  if (!probe) return null;
  const target = probe.trim();

  let bestIndex = -1;
  let bestScore = 3;
  for (let i = 0; i < fileLines.length; i += 1) {
    const line = (fileLines[i] ?? '').trim();
    if (!line) continue;
    const score = line.includes(target) || target.includes(line)
      ? Math.min(line.length, target.length)
      : commonPrefixLength(line, target);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }

  if (bestIndex === -1) return null;
  const start = Math.max(0, bestIndex - 1);
  const end = Math.min(fileLines.length, bestIndex + 2);
  return fileLines.slice(start, end).map((text, offset) => `${start + offset + 1}: ${text}`).join('\n');
}

export interface UpdateResult {
  content: string;
  chunks: AppliedChunk[];
}

export function applyChunksToContent(path: string, original: string, chunks: PatchChunk[]): UpdateResult {
  const fileLines = original.split('\n');
  let cursor = 0;
  const applied: AppliedChunk[] = [];

  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
    const chunk = chunks[chunkIndex];
    if (!chunk) continue;

    let searchFrom = cursor;
    if (chunk.anchor) {
      const anchorIndex = findAnchor(fileLines, chunk.anchor, cursor);
      if (anchorIndex === null) {
        throw new PatchApplyError(
          `chunk ${chunkIndex + 1}: @@ anchor not found in ${path}: ${chunk.anchor}`,
        );
      }
      searchFrom = anchorIndex + 1;
    }

    if (chunk.oldLines.length === 0) {
      let insertAt: number;
      if (chunk.isEndOfFile) {
        insertAt = fileLines.length;
      } else if (chunk.anchor) {
        insertAt = searchFrom;
      } else {
        throw new PatchApplyError(
          `chunk ${chunkIndex + 1}: pure insertion needs an @@ anchor, context lines, or *** End of File marker`,
        );
      }
      fileLines.splice(insertAt, 0, ...chunk.newLines);
      applied.push({ startLine: insertAt + 1, removed: [], added: chunk.newLines, fuzz: 'exact' });
      cursor = insertAt + chunk.newLines.length;
      continue;
    }

    const match = findSequence(fileLines, chunk.oldLines, searchFrom)
      ?? (searchFrom > 0 ? findSequence(fileLines, chunk.oldLines, 0) : null);
    if (!match) {
      const hint = closestSnippet(fileLines, chunk.oldLines);
      throw new PatchApplyError(
        `chunk ${chunkIndex + 1}: context not found in ${path}.\n`
        + `Expected to find:\n${chunk.oldLines.join('\n')}`
        + (hint ? `\nClosest match in file:\n${hint}` : ''),
      );
    }

    if (chunk.isEndOfFile && match.index + chunk.oldLines.length !== fileLines.length) {
      throw new PatchApplyError(
        `chunk ${chunkIndex + 1}: marked *** End of File but matched context is not at end of ${path}`,
      );
    }

    fileLines.splice(match.index, chunk.oldLines.length, ...chunk.newLines);
    applied.push({
      startLine: match.index + 1,
      removed: chunk.oldLines,
      added: chunk.newLines,
      fuzz: match.fuzz,
    });
    cursor = match.index + chunk.newLines.length;
  }

  return { content: fileLines.join('\n'), chunks: applied };
}
