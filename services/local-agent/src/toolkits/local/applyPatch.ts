/**
 * V4A patch parser and applier.
 *
 * Envelope grammar:
 *
 *   *** Begin Patch
 *   *** Update File: <path>
 *   @@ <optional context anchor>
 *    <context line>
 *   -<removed line>
 *   +<added line>
 *   [*** End of File]
 *   *** End Patch
 *
 * Each update chunk starts with an explicit `@@` header and locates itself by
 * context, never by line numbers. V4A chunks are matched independently after
 * the complete document passes syntax validation.
 */

export const PATCH_BEGIN = '*** Begin Patch';
export const PATCH_END = '*** End Patch';
const UPDATE_FILE_PREFIX = '*** Update File: ';
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

export interface PatchUpdate {
  path: string;
  chunks: PatchChunk[];
}

export interface AppliedChunk {
  hunk: number;
  startLine: number;
  removed: string[];
  added: string[];
  fuzz: 'exact' | 'ignore-trailing-whitespace' | 'ignore-whitespace';
}

export interface FailedChunk {
  hunk: number;
  code: string;
  message: string;
  anchor?: string;
  expected?: string[];
  closest?: string[];
  matches?: number[];
}

export interface PatchErrorDetails {
  code: string;
  phase: 'parse' | 'match' | 'write';
  line?: number;
  path?: string;
  hunk?: number;
  expected?: string[];
  closest?: string[];
  matches?: number[];
  anchor?: string;
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

function parseContractError(lineIndex: number, code: string, message: string): never {
  throw new PatchParseError(`patch line ${lineIndex + 1}: ${message}`, {
    code,
    phase: 'parse',
    line: lineIndex + 1,
  });
}

export function parseV4APatch(patchText: string): PatchUpdate {
  const lines = patchText.replace(/\r\n/g, '\n').split('\n');

  let index = lines.findIndex((line) => line.trim().length > 0);
  if (index === -1 || lines[index]?.trim() !== PATCH_BEGIN) {
    throw new PatchParseError(`patch must start with "${PATCH_BEGIN}"`);
  }
  index += 1;

  let update: PatchUpdate | null = null;

  const readPath = (path: string, lineIndex: number) => {
    if (!path.trim()) {
      parseError(lineIndex, 'file path must not be empty');
    }
    return path.trim();
  };

  while (index < lines.length) {
    const line = lines[index] ?? '';
    const trimmed = line.trim();

    if (trimmed === PATCH_END) {
      if (!update) {
        parseError(index, 'patch contains no file update');
      }
      const trailingLineIndex = lines.findIndex(
        (trailingLine, trailingIndex) => trailingIndex > index && trailingLine.trim().length > 0,
      );
      if (trailingLineIndex >= 0) {
        parseError(trailingLineIndex, 'unexpected content after *** End Patch');
      }
      return update;
    }

    if (trimmed === '') {
      index += 1;
      continue;
    }

    if (line.startsWith(UPDATE_FILE_PREFIX)) {
      if (update) {
        parseContractError(index, 'multiple_file_patches', 'apply_patch accepts exactly one file update');
      }
      const path = readPath(line.slice(UPDATE_FILE_PREFIX.length), index);
      index += 1;

      if (lines[index]?.startsWith('*** Move to: ')) {
        parseContractError(index, 'unsupported_file_operation', 'apply_patch only updates an existing file; use move_path to move it');
      }

      const chunks: PatchChunk[] = [];
      let anchor: string | null = null;
      let oldLines: string[] = [];
      let newLines: string[] = [];
      let chunkLines: PatchChunkLine[] = [];
      let sawChunkHeader = false;
      let sawChunkLines = false;
      let sawChangeLine = false;
      let isEndOfFile = false;

      const flushChunk = (lineIndex: number) => {
        if (!sawChunkHeader) return;
        if (!sawChunkLines) {
          parseError(lineIndex, `@@${anchor ? ` ${anchor}` : ''} has no diff lines`);
        }
        if (!sawChangeLine) {
          parseError(lineIndex, `@@${anchor ? ` ${anchor}` : ''} contains no changes`);
        }
        chunks.push({ anchor, oldLines, newLines, lines: chunkLines, isEndOfFile });
        anchor = null;
        oldLines = [];
        newLines = [];
        chunkLines = [];
        sawChunkHeader = false;
        sawChunkLines = false;
        sawChangeLine = false;
        isEndOfFile = false;
      };

      while (index < lines.length) {
        const bodyLine = lines[index] ?? '';
        const bodyTrimmed = bodyLine.trim();

        if (bodyTrimmed === END_OF_FILE_MARKER) {
          if (!sawChunkHeader) {
            parseError(index, '*** End of File must belong to an @@ hunk');
          }
          isEndOfFile = true;
          index += 1;
          continue;
        }
        if (bodyLine.startsWith('***')) {
          break;
        }
        if (bodyLine.startsWith('@@')) {
          flushChunk(index);
          sawChunkHeader = true;
          anchor = bodyLine.slice(2).trim() || null;
          index += 1;
          continue;
        }
        if (!sawChunkHeader) {
          if (bodyTrimmed === '') {
            index += 1;
            continue;
          }
          parseError(index, 'V4A diff lines must follow an @@ hunk header');
        }
        if (bodyLine.startsWith('+')) {
          const text = bodyLine.slice(1);
          newLines.push(text);
          chunkLines.push({ kind: 'added', text });
          sawChunkLines = true;
          sawChangeLine = true;
        } else if (bodyLine.startsWith('-')) {
          const text = bodyLine.slice(1);
          oldLines.push(text);
          chunkLines.push({ kind: 'removed', text });
          sawChunkLines = true;
          sawChangeLine = true;
        } else if (bodyLine.startsWith(' ')) {
          const context = bodyLine.slice(1);
          oldLines.push(context);
          newLines.push(context);
          chunkLines.push({ kind: 'context', text: context });
          sawChunkLines = true;
        } else {
          parseError(index, `Update File lines must start with " ", "+", "-" or "@@", got: ${bodyLine.slice(0, 40)}`);
        }
        index += 1;
      }

      flushChunk(index);
      if (chunks.length === 0) {
        parseError(index, `Update File ${path} contains no chunks`);
      }
      update = { path, chunks };
      continue;
    }

    if (line.startsWith('*** Add File: ') || line.startsWith('*** Delete File: ')) {
      parseContractError(index, 'unsupported_file_operation', 'apply_patch only updates an existing file');
    }

    parseError(index, `unrecognized patch directive: ${trimmed.slice(0, 60)}`);
  }

  throw new PatchParseError(`patch must end with "${PATCH_END}"`);
}

export function parsePatchDocument(patchText: string): PatchUpdate {
  const normalized = patchText.replace(/\r\n?/g, '\n');
  return parseV4APatch(normalized);
}

export function parsePatch(patchText: string): PatchUpdate {
  return parsePatchDocument(patchText);
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
  options: { strictLeadingWhitespace?: boolean } = {},
): { index: number; fuzz: AppliedChunk['fuzz']; matches: number[] } | null {
  const fuzzLevels: AppliedChunk['fuzz'][] = options.strictLeadingWhitespace
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

function findAnchor(
  fileLines: string[],
  anchor: string,
  fromIndex: number,
  options: ApplyChunksOptions,
) {
  return findSequence(fileLines, [anchor], fromIndex, options);
}

function commonPrefixLength(a: string, b: string) {
  const max = Math.min(a.length, b.length);
  let length = 0;
  while (length < max && a[length] === b[length]) {
    length += 1;
  }
  return length;
}

function closestSnippet(fileLines: string[], needle: string[]) {
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
  return fileLines.slice(start, end).map((text, offset) => `${start + offset + 1}: ${text}`);
}

export interface PartialUpdateResult {
  content: string;
  chunks: AppliedChunk[];
  failures: FailedChunk[];
}

export interface ApplyChunksOptions {
  strictLeadingWhitespace?: boolean;
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

export function applyChunksToContentPartially(
  path: string,
  original: string,
  chunks: PatchChunk[],
  options: ApplyChunksOptions = {},
): PartialUpdateResult {
  return applyChunks(path, original, chunks, options);
}

function failedChunk(
  error: PatchApplyError,
  chunk: PatchChunk,
  hunk: number,
): FailedChunk {
  return {
    hunk,
    code: error.details.code,
    message: error.message,
    ...(chunk.anchor ? { anchor: chunk.anchor } : {}),
    ...(error.details.expected ? { expected: error.details.expected } : {}),
    ...(error.details.closest ? { closest: error.details.closest } : {}),
    ...(error.details.matches ? { matches: error.details.matches } : {}),
  };
}

function applyChunks(
  path: string,
  original: string,
  chunks: PatchChunk[],
  options: ApplyChunksOptions,
): PartialUpdateResult {
  const lineEnding = original.includes('\r\n') ? '\r\n' : '\n';
  const fileLines = original.replace(/\r\n/g, '\n').split('\n');
  let cursor = 0;
  const applied: AppliedChunk[] = [];
  const failures: FailedChunk[] = [];

  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
    const chunk = chunks[chunkIndex];
    if (!chunk) continue;

    try {
      const result = applyChunk(
        path,
        fileLines,
        chunk,
        chunkIndex,
        cursor,
        options,
      );
      applied.push(result.applied);
      cursor = result.cursor;
    } catch (error) {
      if (!(error instanceof PatchApplyError)) throw error;
      failures.push(failedChunk(error, chunk, chunkIndex + 1));
    }
  }

  return { content: fileLines.join(lineEnding), chunks: applied, failures };
}

function applyChunk(
  path: string,
  fileLines: string[],
  chunk: PatchChunk,
  chunkIndex: number,
  cursor: number,
  options: ApplyChunksOptions,
): { applied: AppliedChunk; cursor: number } {
  const hunk = chunkIndex + 1;

  let searchFrom = cursor;
  if (chunk.anchor) {
    const anchorMatch = findAnchor(fileLines, chunk.anchor, cursor, options);
    if (!anchorMatch) {
      const closest = closestSnippet(fileLines, [chunk.anchor]);
      throw new PatchApplyError(
        `chunk ${hunk}: @@ anchor not found in ${path}: ${chunk.anchor}`,
        {
          code: 'anchor_not_found',
          phase: 'match',
          path,
          hunk,
          anchor: chunk.anchor,
          expected: [chunk.anchor],
          ...(closest ? { closest } : {}),
        },
      );
    }
    if (options.requireUniqueContext && anchorMatch.matches.length > 1) {
      throw new PatchApplyError(
        `chunk ${hunk}: @@ anchor is ambiguous in ${path}`,
        {
          code: 'ambiguous_anchor',
          phase: 'match',
          path,
          hunk,
          anchor: chunk.anchor,
          expected: [chunk.anchor],
          matches: anchorMatch.matches.map((lineIndex) => lineIndex + 1),
        },
      );
    }
    searchFrom = anchorMatch.index + 1;
  }

  if (chunk.oldLines.length === 0) {
    let insertAt: number;
    if (chunk.isEndOfFile) {
      insertAt = fileLines.length;
    } else if (chunk.anchor) {
      insertAt = searchFrom;
    } else {
      throw new PatchApplyError(
        `chunk ${hunk}: pure insertion needs an @@ anchor, context lines, or *** End of File marker`,
        {
          code: 'insertion_location_required',
          phase: 'match',
          path,
          hunk,
        },
      );
    }
    fileLines.splice(insertAt, 0, ...chunk.newLines);
    return {
      applied: {
        hunk,
        startLine: insertAt + 1,
        removed: [],
        added: chunk.newLines,
        fuzz: 'exact',
      },
      cursor: insertAt + chunk.newLines.length,
    };
  }

  const match = findSequence(fileLines, chunk.oldLines, searchFrom, options)
    ?? (searchFrom > 0 ? findSequence(fileLines, chunk.oldLines, 0, options) : null);
  if (!match) {
    const closest = closestSnippet(fileLines, chunk.oldLines);
    throw new PatchApplyError(
      `chunk ${hunk}: context not found in ${path}.\n`
      + `Expected to find:\n${chunk.oldLines.join('\n')}`
      + (closest ? `\nClosest match in file:\n${closest.join('\n')}` : ''),
      {
        code: 'context_not_found',
        phase: 'match',
        path,
        hunk,
        expected: chunk.oldLines,
        ...(closest ? { closest } : {}),
      },
    );
  }

  if (options.requireUniqueContext && match.matches.length > 1) {
    throw new PatchApplyError(
      `chunk ${hunk}: context is ambiguous in ${path}`,
      {
        code: 'ambiguous_context',
        phase: 'match',
        path,
        hunk,
        expected: chunk.oldLines,
        matches: match.matches.map((lineIndex) => lineIndex + 1),
      },
    );
  }

  if (chunk.isEndOfFile && match.index + chunk.oldLines.length !== fileLines.length) {
    throw new PatchApplyError(
      `chunk ${hunk}: marked *** End of File but matched context is not at end of ${path}`,
      {
        code: 'end_of_file_mismatch',
        phase: 'match',
        path,
        hunk,
        expected: chunk.oldLines,
        matches: [match.index + 1],
      },
    );
  }

  const matchedLines = fileLines.slice(match.index, match.index + chunk.oldLines.length);
  const replacementLines = buildReplacementLines(chunk, matchedLines);
  fileLines.splice(match.index, chunk.oldLines.length, ...replacementLines);
  return {
    applied: {
      hunk,
      startLine: match.index + 1,
      removed: matchedLines,
      added: replacementLines,
      fuzz: match.fuzz,
    },
    cursor: match.index + replacementLines.length,
  };
}
