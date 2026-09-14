import { HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { randomUUID } from 'node:crypto';
import { getAgentMessageMetadata, setAgentMessageMetadata } from '../../messages';
import { indentXmlBlock, xmlTextBlock } from '../../../prompts/xml';
import type { UserRequest } from '../types';

/**
 * Delegation briefing — the downward counterpart of the (upward) subagent
 * handoff. Immediately before a Capability model call, the runtime projects the
 * stable user request, current plan task and Supervisor-authored briefing into
 * one HumanMessage. The
 * projection is invocation-only: neither it nor a separate user-request context
 * message is persisted in canonical main or private-lane history.
 *
 * Naming contract: "briefing" is orchestrator → subagent (task dispatch);
 * "handoff" is subagent → main (deliverable return). See issue #362.
 *
 * DelegationSpec is the source of truth. Its XML briefing is a deterministic
 * projection for the selected subagent — no model call and no reverse parsing.
 * The caller's typed delegation scope, rather than this message, drives lane
 * routing and cleanup.
 */

export const DELEGATION_BRIEFING_SOURCE = 'delegation_briefing';

export type DelegationSpec = {
  userRequest: UserRequest;
  task: string;
  mode: 'initial' | 'continue';
  briefing: string;
};

function stampBriefingMeta(message: HumanMessage) {
  message.id ??= randomUUID();
  setAgentMessageMetadata(message, {
    source: DELEGATION_BRIEFING_SOURCE,
  });
  return message;
}

export function isDelegationBriefingMessage(message: BaseMessage): boolean {
  return getAgentMessageMetadata(message).source === DELEGATION_BRIEFING_SOURCE;
}

function renderDelegationBriefingXml(spec: DelegationSpec): string {
  const blocks = [
    [
      '<run_user_request role="goal_context" source="orchestrator_state" trust="read_only">',
      indentXmlBlock(xmlTextBlock('request', spec.userRequest), 2),
      '</run_user_request>',
    ].join('\n'),
    xmlTextBlock('task', spec.task),
    xmlTextBlock('briefing', spec.briefing),
  ];

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
export function materializeDelegation(spec: DelegationSpec): HumanMessage {
  return stampBriefingMeta(
    new HumanMessage(renderDelegationBriefingXml(spec)),
  );
}
