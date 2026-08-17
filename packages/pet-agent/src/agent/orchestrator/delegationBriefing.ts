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
 * dynamic system prompt. A concise start record remains in main so the
 * canonical conversation preserves the complete task lifecycle.
 *
 * Naming contract: "briefing" is orchestrator → subagent (task dispatch);
 * "handoff" is subagent → main (deliverable return). See issue #362.
 *
 * DelegationSpec is the source of truth. Its XML briefing is a deterministic
 * projection for the selected subagent — no model call and no reverse parsing.
 * Runtime metadata, rather than XML content, drives lane routing and cleanup.
 */

export const DELEGATION_BRIEFING_SOURCE = 'delegation_briefing';
export const DELEGATION_STARTED_SOURCE = 'delegation_started';

type DelegationSpecBase = {
  lane: MessageLane;
  transcriptRunId: string;
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
      guidance: string | null;
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
    // Message metadata keeps the existing storage key, but its value scopes
    // the stable delegation transcript and must not follow a resumed root run.
    runId: spec.transcriptRunId,
    delegationId: spec.delegationId,
  });
  return message;
}

export function isDelegationBriefingMessage(message: BaseMessage): boolean {
  return getPinpetMeta(message).source === DELEGATION_BRIEFING_SOURCE;
}

export function isDelegationStartedMessage(message: BaseMessage): boolean {
  return getPinpetMeta(message).source === DELEGATION_STARTED_SOURCE;
}

export function insertBeforeLatestDelegationBriefing(
  messages: BaseMessage[],
  contextMessage: BaseMessage,
): BaseMessage[] {
  let briefingIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isDelegationBriefingMessage(messages[index])) {
      briefingIndex = index;
      break;
    }
  }
  const insertionIndex = briefingIndex >= 0 ? briefingIndex : messages.length;
  return [
    ...messages.slice(0, insertionIndex),
    contextMessage,
    ...messages.slice(insertionIndex),
  ];
}

function renderDelegationBriefingXml(spec: DelegationSpec): string {
  const blocks = [
    xmlTextBlock('task', spec.task),
    spec.mode === 'initial' && spec.essentialContext
      ? xmlTextBlock('essential_context', spec.essentialContext)
      : null,
    spec.mode === 'continue' && spec.guidance
      ? xmlTextBlock('guidance', spec.guidance)
      : null,
  ].filter((block): block is string => block !== null);

  return [
    `<delegation_briefing role="task_boundary" source="orchestrator" mode="${spec.mode}">`,
    ...blocks.map((block) => indentXmlBlock(block, 2)),
    '</delegation_briefing>',
  ].join('\n');
}

/**
 * Record a new delegation in canonical main history. The stable message id
 * makes replaying the same delegation idempotent in LangGraph's message
 * reducer; continuation and resume paths do not create this record.
 */
export function materializeDelegationStarted(spec: DelegationSpecBase): AIMessage {
  const message = new AIMessage(`开始执行计划任务：${spec.task}`);
  message.id = `delegation-started:${spec.transcriptRunId}:${spec.delegationId}`;
  stampMessageCreatedAtUtc(message);
  setPinpetMeta(message, {
    source: DELEGATION_STARTED_SOURCE,
    runId: spec.transcriptRunId,
    delegationId: spec.delegationId,
    task: spec.task,
  });
  return message;
}

/**
 * Materialize a typed delegation into its private lane briefing. Stable
 * execution rules stay in the governing prompt; XML contains only
 * per-delegation data and is never parsed back into runtime state.
 */
export function materializeDelegation(spec: DelegationSpec): MaterializedDelegation {
  const briefingMessage = stampBriefingMeta(
    new AIMessage(renderDelegationBriefingXml(spec)),
    spec,
  );
  return {
    mainMessages: spec.mode === 'initial'
      ? [materializeDelegationStarted(spec)]
      : [],
    laneMessages: [briefingMessage],
  };
}
