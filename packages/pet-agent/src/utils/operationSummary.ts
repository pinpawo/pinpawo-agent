import {
  isKnownOperationBlock,
  isOperationSummary,
  type OperationBlock,
  type OperationSummary,
} from '@pinpawo/agent-contracts';
import type { ToolOperationMetadata } from '../autoReview/policy';
import { readJsonRecord } from './operationMetadata';

/**
 * Display caps. Generous, so a reviewer usually sees the whole patch or
 * command; when they bite, the block is marked truncated. Auto review never
 * relies on a summary: it gets the full input or defers to a human.
 */
export const OPERATION_BLOCK_TEXT_LIMIT = 64_000;
export const OPERATION_SUMMARY_TEXT_LIMIT = 128_000;

function singleLine(value: string | undefined) {
  const line = value?.replace(/\s+/g, ' ').trim();
  return line ? line : undefined;
}

/** Drops absent optional fields (they do not survive JSON) and caps the text. */
function normalizeBlock(block: OperationBlock, limit: number): OperationBlock {
  const present = Object.fromEntries(
    Object.entries(block).filter(([, value]) => value !== undefined),
  ) as OperationBlock;
  return present.text.length > limit
    ? { ...present, text: present.text.slice(0, limit), truncated: true }
    : present;
}

/** Caps each block, then the blocks together; a block left with no room is dropped. */
function capBlocks(blocks: OperationBlock[]): OperationBlock[] {
  const capped: OperationBlock[] = [];
  let remaining = OPERATION_SUMMARY_TEXT_LIMIT;
  for (const block of blocks) {
    if (remaining <= 0) {
      const last = capped.at(-1);
      if (last) capped[capped.length - 1] = { ...last, truncated: true };
      break;
    }
    const next = normalizeBlock(block, Math.min(OPERATION_BLOCK_TEXT_LIMIT, remaining));
    remaining -= next.text.length;
    capped.push(next);
  }
  return capped;
}

/**
 * The one way to run a toolkit's `summarize`: approval, auto review and the
 * Host's timeline events all call this, so they agree. Arguments may arrive
 * as a JSON string; a throwing or malformed summary yields null, because
 * presentation must never break the tool call itself.
 */
export function summarizeToolOperation(
  operation: Pick<ToolOperationMetadata, 'summarize'> | undefined,
  input: unknown,
): OperationSummary | null {
  if (!operation?.summarize || input === undefined) return null;
  let summary: unknown;
  try {
    summary = operation.summarize(typeof input === 'string' ? readJsonRecord(input) ?? input : input);
  } catch {
    return null;
  }
  if (!summary || !isOperationSummary(summary)) return null;
  const target = singleLine(summary.target);
  const line = singleLine(summary.summary);
  // Toolkits author only the closed set of kinds; a kind this version does not know is not theirs to use.
  const blocks = capBlocks(summary.blocks?.filter(isKnownOperationBlock).filter((block) => block.text.length > 0) ?? []);
  if (!target && !line && blocks.length === 0) return null;
  return {
    ...(target ? { target } : {}),
    ...(line ? { summary: line } : {}),
    ...(blocks.length > 0 ? { blocks } : {}),
  };
}
