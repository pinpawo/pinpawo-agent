import type { AgentActor } from '../../../types/agent';
import {
  buildDecisionConfig,
  buildOrchestratorDecisionPromptPrefix,
  promptBlock,
  xmlTextBlock,
} from './shared';
import {
  ENTRY_DECISION_INPUT_PROMPT,
  ENTRY_DECISION_SYSTEM_PROMPT,
} from './templates/entryDecision.prompt';

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
  runDelegationContext?: string | null;
  runtimeContext?: string | null;
}): string {
  return ENTRY_DECISION_INPUT_PROMPT.render({
    runtimeContextBlock: promptBlock(params.runtimeContext, 2),
    runDelegationContextBlock: promptBlock(params.runDelegationContext
      ? xmlTextBlock('run_delegation_summaries', params.runDelegationContext, ' role="fact" source="state"')
      : null, 2),
  });
}
