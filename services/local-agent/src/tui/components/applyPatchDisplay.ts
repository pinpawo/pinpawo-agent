import {
  parsePatch,
  type PatchChunk,
  type PatchChunkLine,
  type PatchOperation,
} from '../../toolkits/local/applyPatch';
import { truncateLine } from '../render/terminalText';

export type PatchDisplayLine = {
  text: string;
  tone?: 'default' | 'muted' | 'added' | 'removed';
};

const DEFAULT_MAX_PATCH_LINES = 24;

export function buildApplyPatchDisplayLines(params: {
  patch: string;
  width: number;
  target?: string;
  label?: string;
  maxLines?: number;
}): PatchDisplayLine[] {
  const label = params.target
    ? `patch ${params.target}`
    : params.label ?? 'patch';
  const parsed = buildParsedPatchLines(params.patch, params.width);
  const lines = parsed
    ? [
        diffMetaLine(label, params.width),
        ...parsed,
      ]
    : [
        diffMetaLine(`${label} (raw; parse failed)`, params.width),
        ...buildRawPatchLines(params.patch, params.width),
      ];
  return limitPatchLines(lines, params.width, params.maxLines ?? DEFAULT_MAX_PATCH_LINES);
}

function buildParsedPatchLines(patch: string, width: number): PatchDisplayLine[] | null {
  try {
    return parsePatch(patch).flatMap((operation) => patchOperationLines(operation, width));
  } catch {
    return null;
  }
}

function patchOperationLines(operation: PatchOperation, width: number): PatchDisplayLine[] {
  switch (operation.type) {
    case 'add':
      return [
        diffMetaLine(`*** Add File: ${operation.path}`, width),
        ...splitPatchContentLines(operation.content).map((line) => diffLine('+', line, 'added', width)),
      ];
    case 'delete':
      return [diffMetaLine(`*** Delete File: ${operation.path}`, width)];
    case 'update':
      return [
        diffMetaLine(`*** Update File: ${operation.path}`, width),
        ...(operation.moveTo ? [diffMetaLine(`*** Move to: ${operation.moveTo}`, width)] : []),
        ...operation.chunks.flatMap((chunk) => patchChunkLines(chunk, width)),
      ];
  }
}

function patchChunkLines(chunk: PatchChunk, width: number): PatchDisplayLine[] {
  return [
    diffMetaLine(chunk.anchor ? `@@ ${chunk.anchor}` : '@@', width),
    ...chunk.lines.map((line) => patchChunkLine(line, width)),
    ...(chunk.isEndOfFile ? [diffMetaLine('*** End of File', width)] : []),
  ];
}

function buildRawPatchLines(patch: string, width: number): PatchDisplayLine[] {
  return patch
    .replace(/\r\n/g, '\n')
    .split('\n')
    .flatMap((line) => rawPatchLine(line, width));
}

function rawPatchLine(line: string, width: number): PatchDisplayLine[] {
  const trimmed = line.trimEnd();
  if (!trimmed || trimmed === '*** Begin Patch' || trimmed === '*** End Patch') {
    return [];
  }
  return [{
    text: truncateLine(`  ${trimmed}`, width),
    tone: patchLineTone(trimmed),
  }];
}

function patchLineTone(line: string): PatchDisplayLine['tone'] {
  if (line.startsWith('+')) return 'added';
  if (line.startsWith('-')) return 'removed';
  return 'muted';
}

function splitPatchContentLines(content: string) {
  if (!content) return [''];
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function patchChunkLine(line: PatchChunkLine, width: number): PatchDisplayLine {
  switch (line.kind) {
    case 'added':
      return diffLine('+', line.text, 'added', width);
    case 'removed':
      return diffLine('-', line.text, 'removed', width);
    case 'context':
      return {
        text: truncateLine(`   ${line.text}`, width),
        tone: 'muted',
      };
  }
}

function diffMetaLine(text: string, width: number): PatchDisplayLine {
  return {
    text: truncateLine(`  ${text}`, width),
    tone: 'muted',
  };
}

function diffLine(
  prefix: '+' | '-',
  line: string,
  tone: 'added' | 'removed',
  width: number,
): PatchDisplayLine {
  return {
    text: truncateLine(`  ${prefix}${line}`, width),
    tone,
  };
}

function limitPatchLines(lines: PatchDisplayLine[], width: number, maxLines: number): PatchDisplayLine[] {
  if (lines.length <= maxLines) return lines;
  const visibleLines = lines.slice(0, maxLines - 1);
  visibleLines.push({
    text: truncateLine(`  ... ${(
      lines.length - visibleLines.length
    ).toString()} patch lines hidden`, width),
    tone: 'muted',
  });
  return visibleLines;
}
