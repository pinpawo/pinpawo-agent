import { HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { randomUUID } from 'node:crypto';
import { getAgentMessageMetadata, setAgentMessageMetadata } from '../../messages';
import { indentXmlBlock, xmlTextBlock } from '../../../prompts/xml';
import type { UserRequest } from '../types';

/** Supervisor discloses this invocation's objective and next steps through briefing. */

export const DELEGATION_BRIEFING_SOURCE = 'delegation_briefing';

export type DelegationSpec = {
  userRequest: UserRequest;
  task: string;
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
    `<delegation_briefing role="task_boundary" source="orchestrator">`,
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
