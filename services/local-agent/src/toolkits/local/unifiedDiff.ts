import type { PatchChunk, PatchOperation } from './applyPatch';

const DEV_NULL = '/dev/null';
const HUNK_HEADER = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@(?:.*)$/;

export class UnifiedDiffParseError extends Error {
  constructor(message: string, readonly line: number | null = null) {
    super(message);
    this.name = 'UnifiedDiffParseError';
  }
}

function fail(lineIndex: number, message: string): never {
  throw new UnifiedDiffParseError(`patch line ${lineIndex + 1}: ${message}`, lineIndex + 1);
}

function isFileHeader(lines: string[], index: number) {
  return lines[index]?.startsWith('--- ') && lines[index + 1]?.startsWith('+++ ');
}

function decodeQuotedPath(value: string, lineIndex: number) {
  if (!value.startsWith('"')) return value;
  try {
    const decoded = JSON.parse(value) as unknown;
    if (typeof decoded !== 'string') fail(lineIndex, 'quoted file path must decode to a string');
    return decoded;
  } catch {
    fail(lineIndex, `invalid quoted file path: ${value}`);
  }
}

function parseHeaderPath(line: string, expectedPrefix: '--- ' | '+++ ', lineIndex: number) {
  const raw = line.slice(expectedPrefix.length).split('\t', 1)[0]?.trim() ?? '';
  if (!raw) fail(lineIndex, 'file path must not be empty');
  const decoded = decodeQuotedPath(raw, lineIndex);
  if (decoded === DEV_NULL) return decoded;
  if (decoded.startsWith('a/') || decoded.startsWith('b/')) return decoded.slice(2);
  return decoded;
}

function isMetadataLine(line: string) {
  return line.startsWith('diff --git ')
    || line.startsWith('index ')
    || line.startsWith('new file mode ')
    || line.startsWith('deleted file mode ')
    || line.startsWith('old mode ')
    || line.startsWith('new mode ');
}

function buildAddedContent(chunks: PatchChunk[], endsWithNewline: boolean) {
  const content = chunks.flatMap((chunk) => chunk.newLines).join('\n');
  return endsWithNewline && content ? `${content}\n` : content;
}

export function parseUnifiedDiff(patchText: string): PatchOperation[] {
  const lines = patchText.replace(/\r\n?/g, '\n').split('\n');
  const operations: PatchOperation[] = [];
  const seenPaths = new Set<string>();
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (!line.trim() || isMetadataLine(line)) {
      index += 1;
      continue;
    }
    if (!isFileHeader(lines, index)) {
      fail(index, `expected unified diff file headers, got: ${line.slice(0, 60)}`);
    }

    const oldPath = parseHeaderPath(lines[index] ?? '', '--- ', index);
    const newPath = parseHeaderPath(lines[index + 1] ?? '', '+++ ', index + 1);
    index += 2;

    if (oldPath === DEV_NULL && newPath === DEV_NULL) {
      fail(index - 1, 'both file paths cannot be /dev/null');
    }
    if (oldPath !== DEV_NULL && newPath !== DEV_NULL && oldPath !== newPath) {
      fail(index - 1, 'renames are not supported by Unified Diff; use V4A Move to');
    }

    const path = newPath === DEV_NULL ? oldPath : newPath;
    if (seenPaths.has(path)) fail(index - 1, `duplicate operation for ${path}`);
    seenPaths.add(path);

    const chunks: PatchChunk[] = [];
    let addedContentEndsWithNewline = true;

    while (index < lines.length) {
      const bodyLine = lines[index] ?? '';
      if (bodyLine.startsWith('diff --git ') || isFileHeader(lines, index)) break;
      if (!bodyLine.trim() && index === lines.length - 1) {
        index += 1;
        break;
      }
      if (!bodyLine.startsWith('@@')) {
        fail(index, `expected hunk header, got: ${bodyLine.slice(0, 60)}`);
      }

      const header = HUNK_HEADER.exec(bodyLine);
      if (!header) fail(index, `invalid hunk header: ${bodyLine.slice(0, 80)}`);
      index += 1;

      const oldLines: string[] = [];
      const newLines: string[] = [];
      const chunkLines: PatchChunk['lines'] = [];
      let sawDiffLine = false;
      let sawChangeLine = false;
      let lastLineKind: 'context' | 'removed' | 'added' | null = null;

      while (index < lines.length) {
        const hunkLine = lines[index] ?? '';
        if (hunkLine.startsWith('@@') || hunkLine.startsWith('diff --git ')) {
          break;
        }
        if (hunkLine === '\\ No newline at end of file') {
          if (lastLineKind === 'added') addedContentEndsWithNewline = false;
          index += 1;
          continue;
        }
        if (!hunkLine && index === lines.length - 1) {
          index += 1;
          break;
        }
        const prefix = hunkLine[0];
        const text = hunkLine.slice(1);
        if (prefix === ' ') {
          oldLines.push(text);
          newLines.push(text);
          chunkLines.push({ kind: 'context', text });
          lastLineKind = 'context';
        } else if (prefix === '-') {
          oldLines.push(text);
          chunkLines.push({ kind: 'removed', text });
          sawChangeLine = true;
          lastLineKind = 'removed';
        } else if (prefix === '+') {
          newLines.push(text);
          chunkLines.push({ kind: 'added', text });
          sawChangeLine = true;
          lastLineKind = 'added';
        } else {
          fail(index, `hunk lines must start with " ", "+", or "-", got: ${hunkLine.slice(0, 40)}`);
        }
        sawDiffLine = true;
        index += 1;
      }

      if (!sawDiffLine) fail(index - 1, 'hunk contains no diff lines');
      if (!sawChangeLine) fail(index - 1, 'hunk contains no changes');
      chunks.push({
        anchor: null,
        oldLines,
        newLines,
        lines: chunkLines,
        isEndOfFile: false,
      });
    }

    if (chunks.length === 0) fail(index - 1, `file ${path} contains no hunks`);
    if (oldPath === DEV_NULL) {
      operations.push({ type: 'add', path, content: buildAddedContent(chunks, addedContentEndsWithNewline) });
    } else if (newPath === DEV_NULL) {
      operations.push({ type: 'delete', path });
    } else {
      operations.push({ type: 'update', path, moveTo: null, chunks });
    }
  }

  if (operations.length === 0) {
    throw new UnifiedDiffParseError('patch contains no file operations');
  }
  return operations;
}
