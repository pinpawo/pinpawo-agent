import type { GlobalReviewPolicyBatchItem } from '../review/globalReviewPolicy';
import type { StructuredOutputMethod } from '../../../utils/structuredOutput';
import { reviewViewToText } from '../review/reviewSpec';
import { promptBlock, xmlTextBlock } from './shared';
import {
  AUTO_REVIEW_INPUT_PROMPT,
  AUTO_REVIEW_SYSTEM_PROMPT,
} from './templates/autoReview.prompt';

const MAX_PROMPT_CHARS = 8_000;
const MAX_ACTIONS_CHARS = 3_000;
const MAX_REVIEW_ACTIONS = 6;
const MAX_TASK_CHARS = 500;
const LARGE_VALUE_KEY = /(?:content|body|text|data|patch|before|after|preview|output|html|markdown)$/i;

function clipText(value: string, limit: number) {
  return value.length <= limit
    ? value
    : `${value.slice(0, limit)}\n[truncated ${value.length - limit} chars]`;
}

function summarizeLargeValue(value: unknown) {
  if (typeof value === 'string') return `[omitted payload: ${value.length} chars]`;
  if (Array.isArray(value)) return `[omitted payload: ${value.length} items]`;
  return '[omitted payload]';
}

function compactFacts(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return clipText(value, 400);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 3) return '[nested value omitted]';
  if (Array.isArray(value)) {
    return [
      ...value.slice(0, 12).map((item) => compactFacts(item, depth + 1)),
      ...(value.length > 12 ? [`[${value.length - 12} more items omitted]`] : []),
    ];
  }
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
    key,
    LARGE_VALUE_KEY.test(key) ? summarizeLargeValue(item) : compactFacts(item, depth + 1),
  ]));
}

function safeJson(value: unknown, limit: number) {
  try {
    return clipText(JSON.stringify(compactFacts(value), null, 2), limit);
  } catch {
    return clipText(String(value), limit);
  }
}

function readOperationSummary(item: GlobalReviewPolicyBatchItem) {
  try {
    return item.operation?.summarizeInput?.(item.input) ?? null;
  } catch {
    return null;
  }
}

function formatAutoReviewItem(item: GlobalReviewPolicyBatchItem, index: number, limit: number) {
  const summary = readOperationSummary(item);
  const identity = `Action ${index + 1}: ${clipText(item.toolkitName, 80)}.${clipText(item.toolName, 100)}`;
  const essentialLines = [
    identity,
    item.operation?.title ? `Title: ${clipText(item.operation.title, 120)}` : null,
    summary?.target ? `Target: ${summary.target}` : null,
    summary?.summary ? `Summary: ${summary.summary}` : null,
    !summary ? `Review: ${reviewViewToText(item.review.view)}` : null,
  ].filter((line): line is string => Boolean(line));
  const inputBudget = Math.max(140, Math.floor(limit * (summary ? 0.25 : 0.4)));
  const contextBudget = Math.max(120, limit - inputBudget - 20);
  const essentialContext = essentialLines.join('\n');
  if (essentialContext.length > contextBudget) {
    return { text: '', complete: false };
  }
  const optionalContext = summary?.details
    ? `Facts: ${safeJson(summary.details, Math.max(80, contextBudget - essentialContext.length - 1))}`
    : null;
  return {
    text: clipText([
      [essentialContext, optionalContext].filter(Boolean).join('\n'),
      `Input facts: ${safeJson(item.input, inputBudget)}`,
    ].join('\n'), limit),
    complete: true,
  };
}

function formatAutoReviewItems(items: GlobalReviewPolicyBatchItem[]) {
  if (items.length === 0) {
    return { text: '(no actions)', complete: true };
  }
  if (items.length > MAX_REVIEW_ACTIONS) {
    return { text: '', complete: false };
  }
  const perItemLimit = Math.floor(MAX_ACTIONS_CHARS / items.length);
  const formatted = items.map((item, index) => formatAutoReviewItem(item, index, perItemLimit));
  if (formatted.some((item) => !item.complete)) {
    return { text: '', complete: false };
  }
  return {
    text: formatted.map((item) => item.text).join('\n\n'),
    complete: true,
  };
}

export type AutoReviewToolkitPolicy = {
  readonly toolkitName: string;
  readonly policy: NonNullable<GlobalReviewPolicyBatchItem['autoReviewContext']>;
};

export function selectAutoReviewToolkitPolicies(
  items: readonly GlobalReviewPolicyBatchItem[],
): AutoReviewToolkitPolicy[] {
  const policies = new Map<string, NonNullable<GlobalReviewPolicyBatchItem['autoReviewContext']>>();

  for (const item of items) {
    if (item.autoReviewContext && !policies.has(item.toolkitName)) {
      policies.set(item.toolkitName, item.autoReviewContext);
    }
  }

  return [...policies.entries()].map(([toolkitName, policy]) => ({
    toolkitName,
    policy,
  }));
}

function formatToolkitAutoReviewPolicies(
  policies: readonly AutoReviewToolkitPolicy[],
) {
  if (policies.length === 0) return '';
  return [
    '',
    'Registered toolkit auto-review policies:',
    ...policies.flatMap(({ toolkitName, policy }) => [
      `Toolkit ${toolkitName}:`,
      `- Automatic-authorization eligibility: ${stripGuidanceDirective(policy.allow, 'allow')}`,
      `- Human-authorization conditions: ${stripGuidanceDirective(policy.ask, 'ask')}`,
    ]),
  ].join('\n');
}

function stripGuidanceDirective(value: string, directive: 'allow' | 'ask') {
  const trimmed = value.trim();
  const prefix = directive === 'ask'
    ? '(?:ask|require human authorization)'
    : 'allow';
  return trimmed.replace(new RegExp(`^${prefix}\\b[\\s:]*`, 'i'), '');
}

function buildAutoReviewOutputInstruction(method?: StructuredOutputMethod) {
  if (method !== 'jsonMode') return '';
  return [
    '',
    'Output protocol:',
    'Return only one JSON object with:',
    '- "riskScore": an integer from 0 to 10 using the risk scale above.',
    '- "reason": a concise explanation grounded in the action facts and policy.',
  ].join('\n');
}

export function buildAutoReviewSystemPrompt(params: {
  toolkitPolicies?: readonly AutoReviewToolkitPolicy[];
  method?: StructuredOutputMethod;
}) {
  return AUTO_REVIEW_SYSTEM_PROMPT.render({
    toolkitPolicyBlock: formatToolkitAutoReviewPolicies(params.toolkitPolicies ?? []),
    outputInstruction: buildAutoReviewOutputInstruction(params.method),
  });
}

export function buildAutoReviewPrompt(params: {
  task?: string | null;
  workdir?: string | null;
  reviews: GlobalReviewPolicyBatchItem[];
}) {
  const actions = formatAutoReviewItems(params.reviews);
  if (!actions.complete) {
    return { text: '', complete: false };
  }
  const text = AUTO_REVIEW_INPUT_PROMPT.render({
    taskBlock: promptBlock(params.task?.trim()
      ? xmlTextBlock('current_task', clipText(params.task.trim(), MAX_TASK_CHARS), ' role="context" authority="none"')
      : null, 2),
    workdirBlock: promptBlock(params.workdir?.trim()
      ? xmlTextBlock('workdir', clipText(params.workdir.trim(), 400), ' authority="runtime"')
      : null, 2),
    batchSize: params.reviews.length.toString(),
    actionsBlock: promptBlock(xmlTextBlock('actions', actions.text, ' role="data"'), 2),
  });
  return text.length <= MAX_PROMPT_CHARS
    ? { text, complete: true }
    : { text: '', complete: false };
}
