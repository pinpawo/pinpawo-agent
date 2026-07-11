import type { AgentActor } from '../../../types/agent';
import {
  buildDecisionConfig,
  buildOrchestratorDecisionPromptPrefix,
  promptBlock,
  xmlTextBlock,
} from './shared';
import {
  CAPABILITY_PLANNER_INPUT_PROMPT,
  CAPABILITY_PLANNER_SYSTEM_PROMPT,
} from './templates/capabilityPlanner.prompt';

export function buildCapabilityPlanningDecisionSystemPrompt(params: {
  actor: AgentActor;
  outputInstruction: string;
}): string {
  return CAPABILITY_PLANNER_SYSTEM_PROMPT.render({
    config: buildDecisionConfig(params.actor),
    sharedPrefix: buildOrchestratorDecisionPromptPrefix(),
    outputInstruction: params.outputInstruction,
  });
}

export function buildCapabilityPlanningDecisionInput(params: {
  mode: 'entry' | 'boundary';
  userIntentContext: string;
  remainingPlan: Array<{ objective: string; capabilityIntent: string; status: 'concrete' | 'deferred' }>;
  latestHandoff: string | null;
  capabilityRegistryContext: string;
}): string {
  return CAPABILITY_PLANNER_INPUT_PROMPT.render({
    mode: params.mode,
    userIntentContextBlock: promptBlock(params.userIntentContext, 2),
    remainingPlanBlock: promptBlock(
      xmlTextBlock('remaining_plan', JSON.stringify(params.remainingPlan), ' role="state"'),
      2,
    ),
    latestHandoffBlock: promptBlock(params.latestHandoff
      ? xmlTextBlock('latest_handoff', params.latestHandoff)
      : '<latest_handoff missing="true" />', 2),
    capabilityRegistryBlock: promptBlock(
      xmlTextBlock('capability_registry', params.capabilityRegistryContext, ' role="fact"'),
      2,
    ),
  });
}
