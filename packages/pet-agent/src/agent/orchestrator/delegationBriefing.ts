import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import { randomUUID } from 'node:crypto';
import { getPinpetMeta, setPinpetMeta, stampMessageCreatedAtUtc } from './messageLanes';
import type { MessageLane } from './types';

/**
 * Delegation briefing — the downward counterpart of the (upward) subagent
 * handoff. When a delegation materializes, capabilityDecision renders the
 * structured current task into a compact delegation-lane AIMessage, so the
 * executing subagent reads its task boundary from message history instead of a
 * dynamic system prompt. Main receives only a concise plan message.
 *
 * Naming contract: "briefing" is orchestrator → subagent (task dispatch);
 * "handoff" is subagent → main (deliverable return). See issue #362.
 *
 * The briefing is a deterministic projection of state — no model call, no
 * free-text drift against the routed task. Metadata is observability-only and
 * never participates in routing, dedupe, or correctness decisions.
 */

export const DELEGATION_BRIEFING_SOURCE = 'delegation_briefing';
export const DELEGATION_PLAN_SOURCE = 'delegation_plan';

/**
 * Stable subagent protocol for reading briefings. Goes into the subagent
 * system prompt; the per-delegation task itself lives only in the briefing.
 */
export const DELEGATION_BRIEFING_PROTOCOL = [
  '## 委派简报协议',
  '当前 delegation lane 中最新的【委派简报】描述当前委派任务。',
  '只执行简报中标记为当前的任务。',
  '完成当前任务后将结果交还 orchestrator，不要自行推进后续计划。',
  '若简报为继续模式，结合已有执行记录继续，不要重新开始。',
].join('\n');

function stampBriefingMeta(
  message: AIMessage,
  params: { lane: MessageLane; runId: string; delegationId: string },
) {
  message.id ??= randomUUID();
  stampMessageCreatedAtUtc(message);
  setPinpetMeta(message, {
    source: DELEGATION_BRIEFING_SOURCE,
    synthetic: true,
    lane: params.lane,
    runId: params.runId,
    delegationId: params.delegationId,
  });
  return message;
}

export function isDelegationBriefingMessage(message: BaseMessage): boolean {
  return getPinpetMeta(message).source === DELEGATION_BRIEFING_SOURCE;
}

export function buildDelegationPlanMessage(params: {
  runId: string;
  delegationId: string;
  task: string;
}): AIMessage {
  const message = new AIMessage(`接下来我会先处理这项任务：${params.task}`);
  message.id ??= randomUUID();
  stampMessageCreatedAtUtc(message);
  setPinpetMeta(message, {
    source: DELEGATION_PLAN_SOURCE,
    synthetic: true,
    runId: params.runId,
    delegationId: params.delegationId,
  });
  return message;
}

/**
 * Render the compact start-of-delegation briefing. Stable execution rules live
 * in the subagent governing prompt and sibling progress stays in main handoffs.
 */
export function buildDelegationBriefingMessage(params: {
  lane: MessageLane;
  runId: string;
  delegationId: string;
  task: string;
  contextSummary: string | null;
}): AIMessage {
  const lines = [
    '【委派简报】',
    `- 当前任务：${params.task}`,
    params.contextSummary ? `- 必要上下文：${params.contextSummary}` : null,
  ].filter((line): line is string => line !== null);

  return stampBriefingMeta(new AIMessage(lines.join('\n')), params);
}

/**
 * Render the continuation briefing for a `continue` outcome: same task, same
 * delegation transcript, plus the reviewer's gap note (why the previous
 * announce did not pass). gapNote may be absent for limit_reached runs, where
 * "keep going" is self-evident from the transcript.
 */
export function buildContinuationBriefingMessage(params: {
  lane: MessageLane;
  runId: string;
  delegationId: string;
  task: string;
  gapNote: string | null;
}): AIMessage {
  const lines = [
    '【委派简报·继续】',
    `- 任务仍然是：${params.task}`,
    params.gapNote ? `- 上轮缺口：${params.gapNote}` : null,
  ].filter((line): line is string => line !== null);

  return stampBriefingMeta(new AIMessage(lines.join('\n')), params);
}
