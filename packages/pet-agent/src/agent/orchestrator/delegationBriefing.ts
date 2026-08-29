import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import { randomUUID } from 'node:crypto';
import {
  getAgentMessageMetadata,
  setPinpetMeta,
  stampMessageCreatedAtUtc,
} from '../messages';
import { indentXmlBlock, xmlTextBlock } from './prompts/shared';
import type { MessageLane, UserRequest } from './types';

/**
 * Delegation briefing — the downward counterpart of the (upward) subagent
 * handoff. Immediately before a Capability model call, the runtime projects the
 * stable user request and the current task into one compact AIMessage. The
 * projection is invocation-only: neither it nor a separate user-request context
 * message is persisted in canonical main or private-lane history.
 *
 * Naming contract: "briefing" is orchestrator → subagent (task dispatch);
 * "handoff" is subagent → main (deliverable return). See issue #362.
 *
 * DelegationSpec is the source of truth. Its XML briefing is a deterministic
 * projection for the selected subagent — no model call and no reverse parsing.
 * Runtime metadata, rather than XML content, drives lane routing and cleanup.
 */

export const DELEGATION_BRIEFING_SOURCE = 'delegation_briefing';

type DelegationSpecBase = {
  lane: MessageLane;
  transcriptRunId: string;
  delegationId: string;
  userRequest: UserRequest;
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
  laneMessages: [AIMessage];
};

function stampBriefingMeta(message: AIMessage, spec: DelegationSpec) {
  message.id ??= randomUUID();
  stampMessageCreatedAtUtc(message);
  setPinpetMeta(message, {
    source: DELEGATION_BRIEFING_SOURCE,
    synthetic: true,
    persistence: 'invocation',
    lane: spec.lane,
    // Message metadata keeps the existing storage key, but its value scopes
    // the stable delegation transcript and must not follow a resumed root run.
    runId: spec.transcriptRunId,
    delegationId: spec.delegationId,
  });
  return message;
}

export function isDelegationBriefingMessage(message: BaseMessage): boolean {
  return getAgentMessageMetadata(message).source === DELEGATION_BRIEFING_SOURCE;
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
    [
      '<run_user_request role="goal_context" source="orchestrator_state" trust="read_only">',
      indentXmlBlock(xmlTextBlock('request', spec.userRequest), 2),
      '</run_user_request>',
    ].join('\n'),
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
 * Materialize a typed delegation into its model-visible briefing. Stable
 * execution rules stay in the governing prompt; XML contains only invocation
 * data and is never parsed back into runtime state.
 */
export function materializeDelegation(spec: DelegationSpec): MaterializedDelegation {
  const briefingMessage = stampBriefingMeta(
    new AIMessage(renderDelegationBriefingXml(spec)),
    spec,
  );
  return {
    laneMessages: [briefingMessage],
  };
}
