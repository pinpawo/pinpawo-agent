import type { AgentActor } from '../../../types/agent';
import {
  buildDecisionConfig,
  buildOrchestratorDecisionPromptPrefix,
  promptBlock,
  xmlTextBlock,
} from './shared';
import {
  GOAL_CREATION_INPUT_PROMPT,
  GOAL_CREATION_SYSTEM_PROMPT,
} from './templates/goalCreation.prompt';

export function buildGoalCreationSystemPrompt(actor: AgentActor): string {
  return GOAL_CREATION_SYSTEM_PROMPT.render({
    config: buildDecisionConfig(actor),
    sharedPrefix: buildOrchestratorDecisionPromptPrefix(),
  });
}

export function buildGoalCreationInput(params: {
  runDelegationContext?: string | null;
  runtimeContext?: string | null;
}): string {
  return GOAL_CREATION_INPUT_PROMPT.render({
    runtimeContextBlock: promptBlock(params.runtimeContext, 2),
    runDelegationContextBlock: promptBlock(params.runDelegationContext
      ? xmlTextBlock(
          'run_delegation_summaries',
          params.runDelegationContext,
          ' role="fact" source="state"',
        )
      : null, 2),
  });
}
