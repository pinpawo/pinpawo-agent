import { parseUnifiedDiff, UnifiedDiffParseError } from './unifiedDiff';

/**
 * Patch parser and applier shared by the V4A and Unified Diff protocols.
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
  lines: PatchChunkLine[];
  isEndOfFile: boolean;
}

export type PatchChunkLine =
  | { kind: 'context'; text: string }
  | { kind: 'removed'; text: string }
  | { kind: 'added'; text: string };

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

export type PatchFormat = 'v4a' | 'unified';

export interface ParsedPatch {
  format: PatchFormat;
  operations: PatchOperation[];
}

export interface PatchErrorDetails {
  code: string;
  phase: 'detect' | 'parse' | 'match' | 'write';
  format?: PatchFormat;
  declaredFormat?: PatchFormat;
  detectedFormat?: PatchFormat;
  line?: number;
  path?: string;
  hunk?: number;
  expected?: string[];
  closest?: string[];
  matches?: number[];
}

export class PatchParseError extends Error {
  constructor(message: string, readonly details: PatchErrorDetails = {
    code: 'invalid_patch_syntax',
    phase: 'parse',
  }) {
    super(message);
    this.name = 'PatchParseError';
  }
}

export class PatchApplyError extends Error {
  constructor(message: string, readonly details: PatchErrorDetails) {
    super(message);
    this.name = 'PatchApplyError';
  }
}

function parseError(lineIndex: number, message: string): never {
  throw new PatchParseError(`patch line ${lineIndex + 1}: ${message}`, {
    code: 'invalid_patch_syntax',
    phase: 'parse',
    line: lineIndex + 1,
  });
}

export function parseV4APatch(patchText: string): PatchOperation[] {
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
      let chunkLines: PatchChunkLine[] = [];
      let sawDiffLines = false;
      let isEndOfFile = false;

      const flushChunk = (lineIndex: number) => {
        if (!sawDiffLines) {
          if (anchor !== null) {
            parseError(lineIndex, `@@ anchor "${anchor}" has no diff lines`);
          }
          return;
        }
        chunks.push({ anchor, oldLines, newLines, lines: chunkLines, isEndOfFile });
        anchor = null;
        oldLines = [];
        newLines = [];
        chunkLines = [];
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
          const text = bodyLine.slice(1);
          newLines.push(text);
          chunkLines.push({ kind: 'added', text });
          sawDiffLines = true;
        } else if (bodyLine.startsWith('-')) {
          const text = bodyLine.slice(1);
          oldLines.push(text);
          chunkLines.push({ kind: 'removed', text });
          sawDiffLines = true;
        } else if (bodyLine.startsWith(' ') || bodyTrimmed === '') {
          const context = bodyLine.startsWith(' ') ? bodyLine.slice(1) : '';
          oldLines.push(context);
          newLines.push(context);
          chunkLines.push({ kind: 'context', text: context });
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

function detectPatchFormat(lines: string[]): PatchFormat | null {
  const v4aEnvelopeIndex = lines.findIndex((line) => line.trim() === PATCH_BEGIN);
  const unifiedEnvelopeIndex = lines.findIndex((line, index) =>
    line.startsWith('diff --git ')
      || (line.startsWith('--- ') && lines[index + 1]?.startsWith('+++ ')));
  if (v4aEnvelopeIndex < 0) return unifiedEnvelopeIndex < 0 ? null : 'unified';
  if (unifiedEnvelopeIndex < 0) return 'v4a';
  return v4aEnvelopeIndex < unifiedEnvelopeIndex ? 'v4a' : 'unified';
}

export function parsePatchDocument(
  patchText: string,
  declaredFormat?: PatchFormat,
): ParsedPatch {
  const normalized = patchText.replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const detectedFormat = detectPatchFormat(lines);
  if (declaredFormat && detectedFormat && declaredFormat !== detectedFormat) {
    throw new PatchParseError(
      `declared patch format "${declaredFormat}" does not match detected format "${detectedFormat}"`,
      {
        code: 'patch_format_mismatch',
        phase: 'detect',
        format: detectedFormat,
        declaredFormat,
        detectedFormat,
      },
    );
  }
  const format = declaredFormat ?? detectedFormat;

  if (format === 'v4a') {
    try {
      return { format: 'v4a', operations: parseV4APatch(normalized) };
    } catch (error) {
      if (error instanceof PatchParseError) {
        throw new PatchParseError(error.message, { ...error.details, format: 'v4a' });
      }
      throw error;
    }
  }

  if (format === 'unified') {
    try {
      return { format: 'unified', operations: parseUnifiedDiff(normalized) };
    } catch (error) {
      if (error instanceof UnifiedDiffParseError) {
        throw new PatchParseError(error.message, {
          code: 'invalid_patch_syntax',
          phase: 'parse',
          format: 'unified',
          ...(error.line === null ? {} : { line: error.line }),
        });
      }
      throw error;
    }
  }

  throw new PatchParseError('unsupported patch format; use V4A or Unified Diff', {
    code: 'unsupported_patch_format',
    phase: 'detect',
  });
}

export function parsePatch(patchText: string): PatchOperation[] {
  return parsePatchDocument(patchText).operations;
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
  options: { preserveLeadingWhitespace?: boolean } = {},
): { index: number; fuzz: AppliedChunk['fuzz']; matches: number[] } | null {
  const fuzzLevels: AppliedChunk['fuzz'][] = options.preserveLeadingWhitespace
    ? ['exact', 'ignore-trailing-whitespace']
    : ['exact', 'ignore-trailing-whitespace', 'ignore-whitespace'];
  for (const fuzz of fuzzLevels) {
    const matches: number[] = [];
    for (let start = fromIndex; start <= fileLines.length - needle.length; start += 1) {
      let matched = true;
      for (let offset = 0; offset < needle.length; offset += 1) {
        if (!linesEqual(fileLines[start + offset] ?? '', needle[offset] ?? '', fuzz)) {
          matched = false;
          break;
        }
      }
      if (matched) {
        matches.push(start);
      }
    }
    if (matches.length > 0) return { index: matches[0] ?? fromIndex, fuzz, matches };
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

export interface ApplyChunksOptions {
  preserveLeadingWhitespace?: boolean;
  requireUniqueContext?: boolean;
}

function buildReplacementLines(chunk: PatchChunk, matchedLines: string[]) {
  let oldOffset = 0;
  const replacement: string[] = [];

  for (const line of chunk.lines) {
    if (line.kind === 'added') {
      replacement.push(line.text);
      continue;
    }
    if (line.kind === 'removed') {
      oldOffset += 1;
      continue;
    }

    replacement.push(matchedLines[oldOffset] ?? line.text);
    oldOffset += 1;
  }

  return replacement;
}

export function applyChunksToContent(
  path: string,
  original: string,
  chunks: PatchChunk[],
  options: ApplyChunksOptions = {},
): UpdateResult {
  const lineEnding = original.includes('\r\n') ? '\r\n' : '\n';
  const fileLines = original.replace(/\r\n/g, '\n').split('\n');
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
          {
            code: 'anchor_not_found',
            phase: 'match',
            path,
            hunk: chunkIndex + 1,
            expected: [chunk.anchor],
          },
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
          {
            code: 'insertion_location_required',
            phase: 'match',
            path,
            hunk: chunkIndex + 1,
          },
        );
      }
      fileLines.splice(insertAt, 0, ...chunk.newLines);
      applied.push({ startLine: insertAt + 1, removed: [], added: chunk.newLines, fuzz: 'exact' });
      cursor = insertAt + chunk.newLines.length;
      continue;
    }

    const match = findSequence(fileLines, chunk.oldLines, searchFrom, options)
      ?? (searchFrom > 0 ? findSequence(fileLines, chunk.oldLines, 0, options) : null);
    if (!match) {
      const hint = closestSnippet(fileLines, chunk.oldLines);
      throw new PatchApplyError(
        `chunk ${chunkIndex + 1}: context not found in ${path}.\n`
        + `Expected to find:\n${chunk.oldLines.join('\n')}`
        + (hint ? `\nClosest match in file:\n${hint}` : ''),
        {
          code: 'context_not_found',
          phase: 'match',
          path,
          hunk: chunkIndex + 1,
          expected: chunk.oldLines,
          ...(hint ? { closest: hint.split('\n') } : {}),
        },
      );
    }

    if (options.requireUniqueContext && match.matches.length > 1) {
      throw new PatchApplyError(
        `chunk ${chunkIndex + 1}: context is ambiguous in ${path}`,
        {
          code: 'ambiguous_context',
          phase: 'match',
          path,
          hunk: chunkIndex + 1,
          expected: chunk.oldLines,
          matches: match.matches.map((lineIndex) => lineIndex + 1),
        },
      );
    }

    if (chunk.isEndOfFile && match.index + chunk.oldLines.length !== fileLines.length) {
      throw new PatchApplyError(
        `chunk ${chunkIndex + 1}: marked *** End of File but matched context is not at end of ${path}`,
        {
          code: 'end_of_file_mismatch',
          phase: 'match',
          path,
          hunk: chunkIndex + 1,
          expected: chunk.oldLines,
        },
      );
    }

    const matchedLines = fileLines.slice(match.index, match.index + chunk.oldLines.length);
    const replacementLines = buildReplacementLines(chunk, matchedLines);
    fileLines.splice(match.index, chunk.oldLines.length, ...replacementLines);
    applied.push({
      startLine: match.index + 1,
      removed: matchedLines,
      added: replacementLines,
      fuzz: match.fuzz,
    });
    cursor = match.index + replacementLines.length;
  }

  return { content: fileLines.join(lineEnding), chunks: applied };
}
