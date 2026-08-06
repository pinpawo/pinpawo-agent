import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import { randomUUID } from 'node:crypto';
import { getPinpetMeta, setPinpetMeta, stampMessageCreatedAtUtc } from './messageLanes';
import { indentXmlBlock, xmlTextBlock } from './prompts/shared';
import type { MessageLane } from './types';

/**
 * Delegation briefing — the downward counterpart of the (upward) subagent
 * handoff. When a delegation materializes, the Capability Planner node renders the
 * structured current task into a compact delegation-lane AIMessage, so the
 * executing subagent reads its task boundary from message history instead of a
 * dynamic system prompt. Main receives only a concise plan message.
 *
 * Naming contract: "briefing" is orchestrator → subagent (task dispatch);
 * "handoff" is subagent → main (deliverable return). See issue #362.
 *
 * DelegationSpec is the source of truth. Its XML briefing is a deterministic
 * projection for the selected subagent — no model call and no reverse parsing.
 * Runtime metadata, rather than XML content, drives lane routing and cleanup.
 */

export const DELEGATION_BRIEFING_SOURCE = 'delegation_briefing';
export const DELEGATION_PLAN_SOURCE = 'delegation_plan';

type DelegationSpecBase = {
  lane: MessageLane;
  runId: string;
  delegationId: string;
  task: string;
};

export type DelegationSpec = DelegationSpecBase & (
  | {
      mode: 'initial';
      essentialContext: string | null;
    }
  | {
      mode: 'continue';
      gapNote: string | null;
    }
);

export type MaterializedDelegation = {
  mainMessages: AIMessage[];
  laneMessages: [AIMessage];
};

function stampBriefingMeta(message: AIMessage, spec: DelegationSpec) {
  message.id ??= randomUUID();
  stampMessageCreatedAtUtc(message);
  setPinpetMeta(message, {
    source: DELEGATION_BRIEFING_SOURCE,
    synthetic: true,
    lane: spec.lane,
    runId: spec.runId,
    delegationId: spec.delegationId,
  });
  return message;
}

export function isDelegationBriefingMessage(message: BaseMessage): boolean {
  return getPinpetMeta(message).source === DELEGATION_BRIEFING_SOURCE;
}

function buildDelegationPlanMessage(params: {
  runId: string;
  delegationId: string;
  task: string;
}): AIMessage {
  const message = new AIMessage(`接下来我会先处理这项任务：${params.task}`);
  message.id ??= randomUUID();
  stampMessageCreatedAtUtc(message);
  setPinpetMeta(message, {
    source: DELEGATION_PLAN_SOURCE,
    runId: params.runId,
    delegationId: params.delegationId,
  });
  return message;
}

function renderDelegationBriefingXml(spec: DelegationSpec): string {
  const blocks = [
    xmlTextBlock('task', spec.task),
    spec.mode === 'initial' && spec.essentialContext
      ? xmlTextBlock('essential_context', spec.essentialContext)
      : null,
    spec.mode === 'continue' && spec.gapNote
      ? xmlTextBlock('gap_note', spec.gapNote)
      : null,
  ].filter((block): block is string => block !== null);

  return [
    `<delegation_briefing role="task_boundary" source="orchestrator" mode="${spec.mode}">`,
    ...blocks.map((block) => indentXmlBlock(block, 2)),
    '</delegation_briefing>',
  ].join('\n');
}

/**
 * Materialize a typed delegation into its user-facing main plan (initial only)
 * and private lane briefing. Stable execution rules stay in the governing
 * prompt; XML contains only per-delegation data and is never parsed back into
 * runtime state.
 */
export function materializeDelegation(spec: DelegationSpec): MaterializedDelegation {
  const briefingMessage = stampBriefingMeta(
    new AIMessage(renderDelegationBriefingXml(spec)),
    spec,
  );
  const mainMessages = spec.mode === 'initial'
    ? [buildDelegationPlanMessage(spec)]
    : [];

  return {
    mainMessages,
    laneMessages: [briefingMessage],
  };
}
