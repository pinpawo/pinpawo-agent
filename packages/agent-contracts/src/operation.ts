import { hasOnlyKeys, isJsonObject, isJsonValue, type JsonObject } from './json';

/**
 * What a tool call is about to do, as its toolkit projects the call's
 * arguments. Clients render it without knowing the tool: `summary` is the
 * heading line, `target` what it acts on, and `blocks` the content.
 */
export type OperationSummary = {
  /** One line: the path, working directory, URL or repository acted on. */
  target?: string;
  /** One line shown as the heading; for shell tools, the command itself. */
  summary?: string;
  blocks?: OperationBlock[];
};

/** A summary as a receiver holds it: it may carry kinds newer than this version. */
export type ReceivedOperationSummary = Omit<OperationSummary, 'blocks'> & {
  blocks?: ReceivedOperationBlock[];
};

/**
 * Generic display primitives, not tool semantics, and the closed set a
 * toolkit may author. Every kind carries `text`, its plain-text form, so a
 * peer that does not know a newer kind can still show it. Adding a kind
 * follows docs/design/host/operation-summary.md §3.
 */
export type OperationBlock =
  | { kind: 'code'; text: string; language?: string; truncated?: true }
  /** The patch as written, in the declared format; never converted. */
  | { kind: 'diff'; format: OperationDiffFormat; text: string; path?: string; truncated?: true }
  | { kind: 'text'; text: string; label?: string; truncated?: true };

export type OperationDiffFormat = 'unified' | 'v4a';

/**
 * A kind added after this version, as a newer peer may send it. Only kinds
 * added once both sides speak blocks are covered; peers without blocks are not.
 */
export type UnknownOperationBlock = JsonObject & { kind: string; text: string; truncated?: true };

/** What a receiver may hold: an authored block or a newer kind. */
export type ReceivedOperationBlock = OperationBlock | UnknownOperationBlock;

export const OPERATION_BLOCK_KINDS = ['code', 'diff', 'text'] as const satisfies readonly OperationBlock['kind'][];

const OPERATION_BLOCK_KEYS: Record<OperationBlock['kind'], readonly string[]> = {
  code: ['kind', 'text', 'language', 'truncated'],
  diff: ['kind', 'format', 'text', 'path', 'truncated'],
  text: ['kind', 'text', 'label', 'truncated'],
};

function isOptionalString(value: unknown) {
  return value === undefined || typeof value === 'string';
}

const OPERATION_DIFF_FORMATS: readonly OperationDiffFormat[] = ['unified', 'v4a'];

function isKnownBlockKind(kind: string): kind is OperationBlock['kind'] {
  return (OPERATION_BLOCK_KINDS as readonly string[]).includes(kind);
}

/** Splits a received block into a kind this version renders or a newer one. */
export function isKnownOperationBlock(block: ReceivedOperationBlock): block is OperationBlock {
  return isKnownBlockKind(block.kind);
}

export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${JSON.stringify(value)}`);
}

/**
 * Known kinds are checked field by field. A kind this version does not know
 * passes when it has string `kind` and `text` and JSON fields, so a newer
 * Host's blocks still reach the default text rendering instead of failing
 * the whole review.
 */
export function isOperationBlock(value: unknown): value is ReceivedOperationBlock {
  if (!isJsonObject(value) || typeof value.kind !== 'string' || typeof value.text !== 'string') {
    return false;
  }
  if (value.truncated !== undefined && value.truncated !== true) return false;
  if (!isKnownBlockKind(value.kind)) return isJsonValue(value);
  if (!hasOnlyKeys(value, OPERATION_BLOCK_KEYS[value.kind])) return false;
  switch (value.kind) {
    case 'code':
      return isOptionalString(value.language);
    case 'diff':
      return OPERATION_DIFF_FORMATS.includes(value.format as OperationDiffFormat) && isOptionalString(value.path);
    case 'text':
      return isOptionalString(value.label);
  }
}

/** The receiver guard; authors are held to the closed {@link OperationBlock} set by type. */
export function isOperationSummary(value: unknown): value is ReceivedOperationSummary {
  return isJsonObject(value)
    && hasOnlyKeys(value, ['target', 'summary', 'blocks'])
    && isOptionalString(value.target)
    && isOptionalString(value.summary)
    && (value.blocks === undefined || (Array.isArray(value.blocks) && value.blocks.every(isOperationBlock)));
}

const TRUNCATED_MARKER = '…（内容已截断）';

/**
 * The default rendering of one block, shared by every terminal: model prompts
 * use it directly, and clients fall back to it for kinds they do not render.
 * Newer kinds show their `text`; the switch over known kinds is exhaustive, so
 * adding a kind without its text form fails typecheck.
 */
export function operationBlockToText(block: ReceivedOperationBlock): string {
  const marker = block.truncated ? `\n${TRUNCATED_MARKER}` : '';
  if (!isKnownOperationBlock(block)) return `${block.text}${marker}`;
  switch (block.kind) {
    case 'code':
      return `\`\`\`${block.language ?? ''}\n${block.text}\n\`\`\`${marker}`;
    case 'diff':
      return `\`\`\`diff\n${block.text}\n\`\`\`${marker}`;
    case 'text':
      return `${block.label ? `${block.label}:\n` : ''}${block.text}${marker}`;
    default:
      return assertNever(block);
  }
}

/** The default rendering of a whole summary; see {@link operationBlockToText}. */
export function operationSummaryToText(summary: ReceivedOperationSummary): string {
  return [
    summary.summary ? `Summary: ${summary.summary}` : null,
    summary.target ? `Target: ${summary.target}` : null,
    ...(summary.blocks ?? []).map(operationBlockToText),
  ].filter((part): part is string => Boolean(part)).join('\n\n');
}
