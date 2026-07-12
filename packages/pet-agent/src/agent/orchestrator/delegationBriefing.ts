import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import { getPinpetMeta, setPinpetMeta, stampMessageCreatedAtUtc } from './messageLanes';
import { formatDelegationStatus } from './utils';
import type { CapabilityPlanTask, MessageLane, RunDelegationSummary } from './types';

/**
 * Delegation briefing — the downward counterpart of the (upward) subagent
 * handoff. When a delegation materializes, the task decision node renders the
 * structured run state (current task, delegation summaries, remaining plan)
 * into a plain main-queue AIMessage, so the executing subagent reads its task
 * boundary from the message history instead of a dynamic system prompt.
 *
 * Naming contract: "briefing" is orchestrator → subagent (task dispatch);
 * "handoff" is subagent → main (deliverable return). See issue #362.
 *
 * The briefing is a deterministic projection of state — no model call, no
 * free-text drift against the routed task. Metadata is observability-only and
 * never participates in routing, dedupe, or correctness decisions.
 */

export const DELEGATION_BRIEFING_SOURCE = 'delegation_briefing';

/**
 * Stable subagent protocol for reading briefings. Goes into the subagent
 * system prompt; the per-delegation task itself lives only in the briefing.
 */
export const DELEGATION_BRIEFING_PROTOCOL = [
  '## 委派简报协议',
  '主会话中最新的【委派简报】描述当前委派任务。',
  '只执行简报中标记为当前的任务；计划中的其他步骤只用于理解整体目标。',
  '完成当前任务后将结果交还 orchestrator，不要自行推进后续计划。',
  '若简报为继续模式，结合已有执行记录继续，不要重新开始。',
].join('\n');

function stampBriefingMeta(
  message: AIMessage,
  params: { runId: string; delegationId: string },
) {
  stampMessageCreatedAtUtc(message);
  setPinpetMeta(message, {
    source: DELEGATION_BRIEFING_SOURCE,
    synthetic: true,
    runId: params.runId,
    delegationId: params.delegationId,
  });
  return message;
}

export function isDelegationBriefingMessage(message: BaseMessage): boolean {
  return getPinpetMeta(message).source === DELEGATION_BRIEFING_SOURCE;
}

/**
 * Render the start-of-delegation briefing. Progress lists sibling delegations
 * by task text and status only — announce copies already carry the result
 * text in main, so resultPreview is intentionally not repeated here.
 */
export function buildDelegationBriefingMessage(params: {
  lane: MessageLane;
  runId: string;
  delegationId: string;
  task: string;
  contextSummary: string | null;
  runDelegationSummaries: RunDelegationSummary[];
  remainingPlan: CapabilityPlanTask[];
}): AIMessage {
  const progressLines = params.runDelegationSummaries
    .filter((item) => item.id !== params.delegationId)
    .map((item) => `- [${formatDelegationStatus(item.status)}] ${item.task}`);
  const remainingPlanLines = params.remainingPlan.map((item, index) =>
    `${index + 1}. ${item.objective}（${item.capabilityIntent}）`);

  const lines = [
    '【委派简报】',
    `- 执行器：${params.lane}`,
    `- 当前任务：${params.task}`,
    params.contextSummary ? `- 必要上下文：${params.contextSummary}` : null,
    ...(progressLines.length > 0 ? ['', '计划进度：', ...progressLines] : []),
    ...(remainingPlanLines.length > 0 ? ['', '剩余计划：', ...remainingPlanLines] : []),
    '',
    '执行边界：',
    '- 只执行当前任务，不要执行计划中的其他事项，也不要自行推进后续计划。',
    '- 完成后将结果交还 orchestrator，由它决定下一步。',
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
  runId: string;
  delegationId: string;
  task: string;
  gapNote: string | null;
}): AIMessage {
  const lines = [
    '【委派简报·继续】',
    `- 任务仍然是：${params.task}`,
    params.gapNote ? `- 上轮缺口：${params.gapNote}` : null,
    '',
    '- 结合上面的执行记录继续，不要重新开始。',
    '- 只执行当前任务，完成后将结果交还 orchestrator。',
  ].filter((line): line is string => line !== null);

  return stampBriefingMeta(new AIMessage(lines.join('\n')), params);
}
