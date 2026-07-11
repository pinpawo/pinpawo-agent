import type { BaseMessage } from '@langchain/core/messages';
import type { AgentActor } from '../../../types/agent';
import { buildPreparedRequestContext } from './context';
import {
  buildDecisionConfig,
  buildOrchestratorDecisionPromptPrefix,
  indentXmlBlock,
  xmlTextBlock,
} from './shared';
import { ENTRY_DECISION_SYSTEM_PROMPT } from './templates/entryDecision.prompt';

export function buildTaskDecisionSystemPrompt(params: {
  actor: AgentActor;
  outputInstruction: string;
}): string {
  return ENTRY_DECISION_SYSTEM_PROMPT.render({
    config: buildDecisionConfig(params.actor),
    sharedPrefix: buildOrchestratorDecisionPromptPrefix(),
    outputInstruction: params.outputInstruction,
  });
}

export function buildTaskDecisionInput(params: {
  latestUserRequest: string | null;
  recentMessages: BaseMessage[];
  requestContext?: string | null;
  runDelegationContext?: string | null;
  runtimeContext?: string | null;
}): string {
  const context = params.requestContext ?? buildPreparedRequestContext({
    latestUserRequest: params.latestUserRequest,
    recentMessages: params.recentMessages,
    recentAnnounces: [],
  });
  return [
    '<task_decision_input>',
    params.runtimeContext ? indentXmlBlock(params.runtimeContext, 2) : null,
    indentXmlBlock(context, 2),
    params.runDelegationContext
      ? indentXmlBlock(xmlTextBlock('run_delegation_summaries', params.runDelegationContext, ' role="fact" source="state"'), 2)
      : null,
    '</task_decision_input>',
  ].filter((line) => line !== null).join('\n');
}
