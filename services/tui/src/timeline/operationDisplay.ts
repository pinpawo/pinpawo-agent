import stringWidth from 'string-width';
import { operationBlockToText, renderOperationBlock, type AgentOperationEntry } from '@pinpawo/agent-session';
import { truncateTerminalLine } from '../text/terminalText';
import { tuiText } from '../i18n/text';

export type OperationDisplayTone = 'default' | 'muted' | 'added' | 'removed';

export type OperationDisplayLine = {
  text: string;
  tone?: OperationDisplayTone;
};

export const OPERATION_OUTPUT_MAX_LINES = 6;
const OPERATION_PATCH_MAX_LINES = 24;
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

function buildOperationHeader(
  entry: AgentOperationEntry,
  now: number,
  width: number,
) {
  // Keep tool activity readable even in very wide terminals.
  const limit = Math.min(width, 104);
  let body = operationActivityText(entry);
  const suffix = tuiText().statusSuffix(operationStatus(entry, now));
  if (stringWidth(body + suffix) > limit && isPlainPath(entry.target?.trim())) {
    body = operationActivityText(entry, (target) => `…/${target.split('/').at(-1)}`);
  }
  return buildOperationHeaderText(body, entry, now, limit);
}

function isPlainPath(target: string | undefined): target is string {
  return Boolean(target?.includes('/') && !target.includes(' ') && !target.includes('://'));
}

/**
 * Compact, factual activity label: the tool, then the summary sentence, then
 * what it acts on. Full arguments remain in the pager.
 */
export function operationActivityText(
  entry: AgentOperationEntry,
  shortenTarget: (target: string) => string = shortenAbsolutePath,
) {
  const label = operationToolLabel(entry);
  // Shorten only a leading working-directory setup; do not interpret shell
  // semantics or claim that a compound command is a single action.
  const summary = entry.summary?.trim().replace(/^cd\s+(?:'[^']*'|"[^"]*"|[^\s;&|]+)\s*&&\s*/, '');
  const target = entry.target?.trim();
  const parts = [summary, target ? shortenTarget(target) : undefined]
    .map((part) => part?.replace(/\s+/g, ' '))
    .filter((part, index, all): part is string => Boolean(part) && part !== label && all.indexOf(part) === index);
  return [label, ...parts].join(' · ');
}

function shortenAbsolutePath(target: string) {
  if (!target.startsWith('/') || target.includes(' ')) return target;
  const segments = target.split('/').filter(Boolean);
  return segments.length > 3 ? `…/${segments.slice(-3).join('/')}` : target;
}

/** Full canonical operation detail, used only in the scrollable transcript. */
export function buildOperationDetailText(entry: AgentOperationEntry) {
  const sections = [buildOperationHeaderText(operationBody(entry), entry, 0, Infinity)];
  const labels = tuiText().operationSection;
  for (const [label, value] of [
    [labels.input, entry.raw?.input],
    [labels.details, entry.blocks?.map(operationBlockToText).join('\n\n')],
    [labels.output, entry.raw?.output],
    [labels.error, entry.raw?.error],
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
  const suffix = tuiText().statusSuffix(operationStatus(entry, now));
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
  const header = buildOperationHeaderText(entry.title, entry, now, headerWidth);
  if (entry.phase === 'completed') return [{ text: header, tone: 'muted' }];
  // An authorization that did not go through keeps its tools and reason visible.
  return [{ text: header }, ...(entry.summary ? [{
    text: sanitizeLine(`  ${tuiText().toolsInvolved(entry.summary)}`, width),
    tone: 'muted' as const,
  }] : []), ...(entry.blocks ?? []).map((block) => ({
    text: sanitizeLine(`  ${operationBlockToText(block).replace(/\s+/g, ' ')}`, width),
    tone: 'muted' as const,
  }))];
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
      return tuiText().outcome.running;
    case 'completed':
      return tuiText().outcome.completed;
    case 'failed':
      return tuiText().outcome.failed;
    case 'interrupted':
      return tuiText().outcome.interrupted;
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
  return joinUniqueParts([
    entry.target,
    entry.summary,
  ].filter((part) => part?.trim() !== label));
}

function buildOperationPayloadLines(
  entry: AgentOperationEntry,
  width: number,
): OperationDisplayLine[] {
  // Diffs are shown inline: they are what the step changed. Other blocks stay
  // in the transcript detail, keeping the timeline one line per step.
  return (entry.blocks ?? []).flatMap((block) => renderOperationBlock<OperationDisplayLine[]>(block, {
    diff: (diff) => buildPatchLines(diff.text, diff.path ?? entry.target, width, diff.truncated === true),
  }, () => []));
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
  truncated = false,
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

  // The truncation marker sits outside the line budget so hiding lines never hides it.
  const marker: OperationDisplayLine[] = truncated
    ? [{ text: sanitizeLine(`  ${tuiText().truncated}`, width), tone: 'muted' }]
    : [];
  if (lines.length <= OPERATION_PATCH_MAX_LINES) return [...lines, ...marker];
  const visible = lines.slice(0, OPERATION_PATCH_MAX_LINES - 1);
  visible.push({
    text: sanitizeLine(
      `  … ${lines.length - visible.length} patch lines hidden`,
      width,
    ),
    tone: 'muted',
  });
  return [...visible, ...marker];
}

function patchLineTone(line: string): OperationDisplayTone {
  if (line.startsWith('+')) return 'added';
  if (line.startsWith('-')) return 'removed';
  return 'muted';
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
