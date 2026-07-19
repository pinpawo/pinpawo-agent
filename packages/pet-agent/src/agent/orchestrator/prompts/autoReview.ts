import type { GlobalReviewPolicyBatchItem } from '../review/globalReviewPolicy';
import { reviewViewToText } from '../review/reviewSpec';
import { promptBlock, xmlTextBlock } from './shared';
import {
  AUTO_REVIEW_INPUT_PROMPT,
  AUTO_REVIEW_SYSTEM_PROMPT,
} from './templates/autoReview.prompt';

const MAX_PROMPT_CHARS = 8_000;
const MAX_ACTIONS_CHARS = 3_000;
const MAX_REVIEW_ACTIONS = 6;
const MAX_USER_REQUESTS = 2;
const MAX_USER_REQUEST_CHARS = 700;
const LARGE_VALUE_KEY = /(?:content|body|text|data|patch|before|after|preview|output|html|markdown)$/i;

function clipText(value: string, limit: number) {
  return value.length <= limit
    ? value
    : `${value.slice(0, limit)}\n[truncated ${value.length - limit} chars]`;
}

function formatUserRequests(userRequests: string[]) {
  const requests = userRequests
    .map((request) => request.trim())
    .filter(Boolean)
    .slice(-MAX_USER_REQUESTS);
  if (requests.length === 0) return { text: null, complete: false };
  if (requests.some((request) => request.length > MAX_USER_REQUEST_CHARS)) {
    return { text: null, complete: false };
  }
  return {
    text: [
      '<user_requests authority="user">',
      ...requests.map((request, index) => xmlTextBlock(
        'request',
        request,
        ` index="${index + 1}"`,
      )),
      '</user_requests>',
    ].join('\n'),
    complete: true,
  };
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
  const commonLines = [
    identity,
    item.operation?.title ? `Title: ${clipText(item.operation.title, 120)}` : null,
    summary?.target ? `Target: ${clipText(summary.target, 500)}` : null,
    summary?.summary ? `Summary: ${clipText(summary.summary, 400)}` : null,
  ].filter((line): line is string => Boolean(line));

  if (summary) {
    const used = commonLines.join('\n').length;
    const detailsBudget = Math.max(0, limit - used - 10);
    const details = summary.details && detailsBudget >= 80
      ? `Facts: ${safeJson(summary.details, detailsBudget)}`
      : null;
    return clipText([...commonLines, details].filter(Boolean).join('\n'), limit);
  }

  const reviewBody = clipText(reviewViewToText(item.review.view), 400);
  const inputBudget = Math.max(120, limit - commonLines.join('\n').length - reviewBody.length - 30);
  return clipText([
    ...commonLines,
    `Review: ${reviewBody}`,
    `Input facts: ${safeJson(item.input, inputBudget)}`,
  ].join('\n'), limit);
}

function formatAutoReviewItems(items: GlobalReviewPolicyBatchItem[]) {
  if (items.length === 0) {
    return { text: '(no actions)', complete: true };
  }
  if (items.length > MAX_REVIEW_ACTIONS) {
    return { text: '', complete: false };
  }
  const perItemLimit = Math.floor(MAX_ACTIONS_CHARS / items.length);
  return {
    text: items.map((item, index) => formatAutoReviewItem(item, index, perItemLimit)).join('\n\n'),
    complete: true,
  };
}

export function buildAutoReviewSystemPrompt() {
  return AUTO_REVIEW_SYSTEM_PROMPT.render({});
}

export function buildAutoReviewPrompt(params: {
  userRequests: string[];
  task?: string | null;
  workdir?: string | null;
  reviews: GlobalReviewPolicyBatchItem[];
}) {
  const actions = formatAutoReviewItems(params.reviews);
  const userRequests = formatUserRequests(params.userRequests);
  if (!actions.complete || !userRequests.complete) {
    return { text: '', complete: false };
  }
  const text = AUTO_REVIEW_INPUT_PROMPT.render({
    workdirBlock: promptBlock(params.workdir?.trim()
      ? xmlTextBlock('workdir', clipText(params.workdir.trim(), 400), ' authority="runtime"')
      : null, 2),
    userRequestsBlock: promptBlock(userRequests.text, 2),
    derivedTaskBlock: promptBlock(params.task?.trim()
      ? xmlTextBlock('derived_task', clipText(params.task.trim(), 600), ' authority="none"')
      : null, 2),
    batchSize: params.reviews.length.toString(),
    actionsBlock: promptBlock(xmlTextBlock('actions', actions.text, ' role="data"'), 2),
  });
  return text.length <= MAX_PROMPT_CHARS
    ? { text, complete: true }
    : { text: '', complete: false };
}
