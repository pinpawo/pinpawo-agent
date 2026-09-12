import type { GlobalReviewPolicyBatchItem } from '../review/globalReviewPolicy';
import type { StructuredOutputMethod } from '../../../utils/structuredOutput';
import { reviewViewToText } from '../review/reviewSpec';
import { promptBlock, xmlTextBlock } from './shared';
import {
  AUTO_REVIEW_INPUT_PROMPT,
  AUTO_REVIEW_SYSTEM_PROMPT,
} from './templates/autoReview.prompt';

const MAX_PROMPT_CHARS = 8_000;
const MAX_ACTIONS_CHARS = 6_000;
const MAX_REVIEW_ACTIONS = 32;
const MAX_TASK_CHARS = 500;

function clipText(value: string, limit: number) {
  return value.length <= limit
    ? value
    : `${value.slice(0, limit)}\n[truncated ${value.length - limit} chars]`;
}

function readOperationSummary(item: GlobalReviewPolicyBatchItem) {
  try {
    return item.operation?.summarizeInput?.(item.input) ?? null;
  } catch {
    return null;
  }
}

/** Preserve executable inputs in full; never authorize a clipped command or hidden payload. */
function formatAutoReviewItems(items: GlobalReviewPolicyBatchItem[]) {
  if (items.length > MAX_REVIEW_ACTIONS) return { text: '', complete: false };
  const actions: string[] = [];
  for (const [index, item] of items.entries()) {
    let input: string | undefined;
    try {
      input = JSON.stringify(item.input, null, 2);
    } catch {
      return { text: '', complete: false };
    }
    if (input === undefined) return { text: '', complete: false };
    const summary = readOperationSummary(item);
    actions.push([
      `Action ${index + 1}: ${item.toolkitName}.${item.toolName}`,
      item.operation?.title ? `Title: ${item.operation.title}` : null,
      summary?.target ? `Target: ${summary.target}` : null,
      // Summaries aid interpretation but cannot replace or hide the actual input.
      summary?.summary ? `Summary: ${clipText(summary.summary, 300)}` : null,
      !summary ? `Review: ${clipText(reviewViewToText(item.review.view), 300)}` : null,
      `Input facts: ${input}`,
    ].filter((line): line is string => Boolean(line)).join('\n'));
    if (actions.join('\n\n').length > MAX_ACTIONS_CHARS) return { text: '', complete: false };
  }
  return { text: actions.join('\n\n') || '(no actions)', complete: true };
}

function formatToolkitAutoReviewPolicies(items: GlobalReviewPolicyBatchItem[]) {
  const policies = new Map<string, NonNullable<GlobalReviewPolicyBatchItem['autoReviewContext']>>();

  for (const item of items) {
    if (item.autoReviewContext && !policies.has(item.toolkitName)) {
      policies.set(item.toolkitName, item.autoReviewContext);
    }
  }

  if (policies.size === 0) return '';

  return [
    '',
    'Registered toolkit auto-review policies:',
    ...[...policies.entries()].flatMap(([toolkitName, policy]) => [
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

export function buildAutoReviewSystemPrompt(
  reviews: GlobalReviewPolicyBatchItem[] = [],
  method?: StructuredOutputMethod,
) {
  return AUTO_REVIEW_SYSTEM_PROMPT.render({
    toolkitPolicyBlock: formatToolkitAutoReviewPolicies(reviews),
    outputInstruction: buildAutoReviewOutputInstruction(method),
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
