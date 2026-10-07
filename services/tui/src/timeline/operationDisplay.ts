import stringWidth from 'string-width';
import type { AgentOperationEntry } from '@pinpawo/agent-session';
import { truncateTerminalLine } from '../text/terminalText';

export type OperationDisplayTone = 'default' | 'muted' | 'added' | 'removed';

export type OperationDisplayLine = {
  text: string;
  tone?: OperationDisplayTone;
};

export const OPERATION_OUTPUT_MAX_LINES = 6;
const OPERATION_PATCH_MAX_LINES = 24;
const OPERATION_PAYLOAD_DETAIL_KEYS = new Set([
  'after',
  'afterPreview',
  'before',
  'files',
  'patch',
]);

function asRecord(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseJson(value: unknown) {
  if (typeof value !== 'string') return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

export function buildOperationDisplayLines(
  entry: AgentOperationEntry,
  now: number,
  width = Number.POSITIVE_INFINITY,
  headerWidth = width,
): OperationDisplayLine[] {
  const authorizationLines = buildAuthorizationDisplayLines(entry, now, width, headerWidth);
  if (authorizationLines) return authorizationLines;
  return [{
    text: buildOperationHeader(entry, now, headerWidth),
  }, ...buildOperationPayloadLines(entry, width), ...buildOperationOutputLines(entry, width)];
}

/** Tools whose summary is the command itself, shown in full rather than as a path. */
const SHELL_TOOL_LABELS = ['run_shell', 'inspect_shell', 'start_process', 'git_shell', 'gh_shell'];

function buildOperationHeader(
  entry: AgentOperationEntry,
  now: number,
  width: number,
) {
  // Keep tool activity readable even in very wide terminals.
  const limit = Math.min(width, 104);
  let body = operationActivityText(entry);
  const suffix = `（${operationStatus(entry, now)}）`;
  const target = entry.target?.trim();
  if (stringWidth(body + suffix) > limit && target?.includes('/')
    && !target.includes(' ') && !target.includes('://')
    && !SHELL_TOOL_LABELS.includes(operationToolLabel(entry))) {
    body = `${operationToolLabel(entry)} · …/${target.split('/').at(-1)}`;
  }
  return buildOperationHeaderText(body, entry, now, limit);
}

/** Compact, factual activity label; full arguments remain in the pager. */
export function operationActivityText(entry: AgentOperationEntry) {
  const label = operationToolLabel(entry);
  const shell = SHELL_TOOL_LABELS.includes(label);
  let argument = shell ? entry.summary?.trim() || entry.target?.trim() : entry.target?.trim() || entry.summary?.trim();
  if (argument && shell) {
    // Shorten only a leading working-directory setup; do not interpret shell
    // semantics or claim that a compound command is a single action.
    argument = argument.replace(/^cd\s+(?:'[^']*'|"[^"]*"|[^\s;&|]+)\s*&&\s*/, '');
  } else if (argument?.startsWith('/') && !argument.includes(' ')) {
    const segments = argument.split('/').filter(Boolean);
    if (segments.length > 3) argument = `…/${segments.slice(-3).join('/')}`;
  }
  return argument && argument !== label ? `${label} · ${argument.replace(/\s+/g, ' ')}` : label;
}

/** Full canonical operation detail, used only in the scrollable transcript. */
export function buildOperationDetailText(entry: AgentOperationEntry) {
  const sections = [buildOperationHeaderText(operationBody(entry), entry, 0, Infinity)];
  for (const [label, value] of [
    ['输入', entry.raw?.input],
    ['详情', entry.details],
    ['输出', entry.raw?.output],
    ['错误', entry.raw?.error],
  ] as const) {
    const text = stringifyOutput(value);
    if (text) sections.push(`${label}\n${normalizeMultilineTerminalText(text)}`);
  }
  return sections.join('\n\n');
}

function buildOperationHeaderText(
  body: string,
  entry: AgentOperationEntry,
  now: number,
  width: number,
) {
  const suffix = `（${operationStatus(entry, now)}）`;
  const line = `${body}${suffix}`;
  if (stringWidth(line) <= width) return sanitizeLine(line, width);

  const suffixWidth = stringWidth(suffix);
  if (suffixWidth >= width) return sanitizeLine(suffix, width);
  return `${sanitizeLine(body, width - suffixWidth)}${suffix}`;
}

function buildAuthorizationDisplayLines(
  entry: AgentOperationEntry,
  now: number,
  width: number,
  headerWidth: number,
): OperationDisplayLine[] | null {
  if (entry.kind !== 'runtime.authorization') return null;
  if (entry.phase === 'completed') {
    return [{ text: buildOperationHeaderText(entry.title, entry, now, headerWidth), tone: 'muted' }];
  }
  const toolLabels = readDetailStrings(entry.details?.toolLabels);
  const reason = readDetailText(entry.details?.reason);
  return [{
    text: buildOperationHeaderText(entry.title, entry, now, headerWidth),
  }, ...(toolLabels.length > 0 ? [{
    text: sanitizeLine(`  涉及工具：${toolLabels.join(' · ')}`, width),
    tone: 'muted' as const,
  }] : []), ...(reason ? [{
    text: sanitizeLine(`  原因：${reason}`, width),
    tone: 'muted' as const,
  }] : [])];
}

function readDetailStrings(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const text = readDetailText(item);
    return text ? [text] : [];
  });
}

function readDetailText(value: unknown) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : null;
}

function operationStatus(entry: AgentOperationEntry, now: number) {
  switch (entry.phase) {
    // `started` and `updated` are both "still running": tool events rarely
    // carry an intermediate update, so a long operation would otherwise sit at
    // a static label with no sign that it is still making progress.
    case 'started':
    case 'updated':
      // No elapsed time: a tool call is short, and inside a delegation a dozen
      // of them each ticking their own clock is noise rather than progress.
      return '进行中';
    case 'completed':
      return '完成';
    case 'failed':
      return '失败';
    case 'interrupted':
      return '已中断';
  }
}

function operationBody(entry: AgentOperationEntry) {
  const label = operationToolLabel(entry);
  const argument = operationArgument(entry);
  return argument ? `${label}(${argument})` : label;
}

function operationToolLabel(entry: AgentOperationEntry) {
  return entry.operationSource?.toolName?.trim()
    || entry.operationSource?.name?.trim()
    || entry.title?.trim()
    || entry.kind;
}

function operationArgument(entry: AgentOperationEntry) {
  const label = operationToolLabel(entry);
  const detailText = formatDetails(entry.details);
  return joinUniqueParts([
    entry.target,
    entry.summary,
    detailText,
  ].filter((part) => part?.trim() !== label));
}

function formatDetails(details: Record<string, unknown> | undefined) {
  if (!details) return '';
  return Object.entries(details)
    .flatMap(([key, value]) => {
      if (OPERATION_PAYLOAD_DETAIL_KEYS.has(key)) return [];
      if (value === undefined || value === null || value === '') return [];
      return [`${key}=${String(value)}`];
    })
    .join(' · ');
}

function buildOperationPayloadLines(
  entry: AgentOperationEntry,
  width: number,
): OperationDisplayLine[] {
  if (!isApplyPatchOperation(entry)) return [];
  const patch = readApplyPatchPayload(entry);
  return patch ? buildPatchLines(patch, entry.target, width) : [];
}

function buildOperationOutputLines(
  entry: AgentOperationEntry,
  width: number,
): OperationDisplayLine[] {
  // Successful operations are one-line receipts. PageUp retains their full
  // output; patches keep their existing bounded diff above this section.
  const isError = entry.phase === 'failed' || hasReturnedError(entry);
  if (entry.phase === 'completed' && !isError) return [];
  const raw = isError
    ? entry.raw?.error ?? entry.raw?.output
    : entry.raw?.output;
  const text = stringifyOutput(raw);
  if (!text) return [];

  const lines = normalizeMultilineTerminalText(text).split('\n');
  // A successful tool is evidence that the step happened, not something the
  // reader works through line by line — and inside a delegation there are many
  // of them, so a full dump buries the task. Failures keep their room: that
  // output is the reason the run stopped.
  const budget = OPERATION_OUTPUT_MAX_LINES;
  const visible = lines.slice(0, budget);
  const hidden = lines.length - visible.length;
  const tone: OperationDisplayTone = isError ? 'removed' : 'muted';
  const output = visible.map((line, index) => ({
    text: sanitizeLine(`${index === 0 ? '  ⎿ ' : '    '}${line}`, width),
    tone,
  }));
  if (hidden > 0) {
    output.push({
      text: sanitizeLine(`    … +${hidden} lines`, width),
      tone: 'muted',
    });
  }
  return output;
}

function hasReturnedError(entry: AgentOperationEntry) {
  // Some tools return an error payload through a completed tool invocation.
  // Keep those visible without changing the canonical lifecycle phase.
  if (entry.raw?.error != null) return true;
  const output = entry.raw?.output;
  if (typeof output === 'string' && /^Error:/i.test(output.trimStart())) return true;
  const record = asRecord(output) ?? asRecord(parseJson(output));
  return record?.ok === false || record?.success === false
    || record?.status === 'error' || record?.status === 'timeout'
    || record?.status === 'spawn_failed';
}

function buildPatchLines(
  patch: string,
  target: string | undefined,
  width: number,
) {
  const label = target ? `patch ${target}` : 'patch';
  const lines: OperationDisplayLine[] = [{
    text: sanitizeLine(`  ${label}`, width),
    tone: 'muted',
  }, ...normalizeMultilineTerminalText(patch)
    .split('\n')
    .flatMap((line): OperationDisplayLine[] => {
      const trimmed = line.trimEnd();
      if (
        !trimmed
        || trimmed === '*** Begin Patch'
        || trimmed === '*** End Patch'
      ) {
        return [];
      }
      return [{
        text: sanitizeLine(`  ${trimmed}`, width),
        tone: patchLineTone(trimmed),
      }];
    })];

  if (lines.length <= OPERATION_PATCH_MAX_LINES) return lines;
  const visible = lines.slice(0, OPERATION_PATCH_MAX_LINES - 1);
  visible.push({
    text: sanitizeLine(
      `  … ${lines.length - visible.length} patch lines hidden`,
      width,
    ),
    tone: 'muted',
  });
  return visible;
}

function patchLineTone(line: string): OperationDisplayTone {
  if (line.startsWith('+')) return 'added';
  if (line.startsWith('-')) return 'removed';
  return 'muted';
}

function isApplyPatchOperation(entry: AgentOperationEntry) {
  return entry.operationSource?.toolName === 'apply_patch'
    || entry.operationSource?.name === 'apply_patch'
    || entry.kind.endsWith('.apply_patch')
    || entry.kind === 'apply_patch';
}

function readApplyPatchPayload(entry: AgentOperationEntry) {
  const input = entry.raw?.input;
  if (input && typeof input === 'object' && 'patch' in input) {
    const patch = (input as { patch?: unknown }).patch;
    if (typeof patch === 'string') return patch;
  }
  if (typeof input === 'string') {
    try {
      const parsed = JSON.parse(input) as unknown;
      if (parsed && typeof parsed === 'object' && 'patch' in parsed) {
        const patch = (parsed as { patch?: unknown }).patch;
        if (typeof patch === 'string') return patch;
      }
    } catch {
      if (input.includes('*** Begin Patch')) return input;
    }
  }
  const detailPatch = entry.details?.patch;
  return typeof detailPatch === 'string' ? detailPatch : undefined;
}

function stringifyOutput(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  try {
    return JSON.stringify(value, null, 2).trim();
  } catch {
    return '';
  }
}

function normalizeMultilineTerminalText(value: string) {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, '  ')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '�');
}

function sanitizeLine(line: string, width: number) {
  return truncateTerminalLine(line, width);
}


function joinUniqueParts(parts: Array<string | undefined>) {
  const seen = new Set<string>();
  return parts.flatMap((part) => {
    const text = part?.trim();
    if (!text || seen.has(text)) return [];
    seen.add(text);
    return [text];
  }).join(' · ');
}
