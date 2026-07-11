import type { AgentActor } from '../../../types/agent';
import {
  buildDecisionConfig,
  buildOrchestratorDecisionPromptPrefix,
  indentXmlBlock,
  xmlTextBlock,
} from './shared';
import { CAPABILITY_PLANNER_SYSTEM_PROMPT } from './templates/capabilityPlanner.prompt';

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
  return [
    '<capability_planning_input>',
    `  <mode>${params.mode}</mode>`,
    indentXmlBlock(params.userIntentContext, 2),
    indentXmlBlock(xmlTextBlock('remaining_plan', JSON.stringify(params.remainingPlan), ' role="state"'), 2),
    params.latestHandoff
      ? indentXmlBlock(xmlTextBlock('latest_handoff', params.latestHandoff), 2)
      : '  <latest_handoff missing="true" />',
    indentXmlBlock(xmlTextBlock('capability_registry', params.capabilityRegistryContext, ' role="fact"'), 2),
    '</capability_planning_input>',
  ].join('\n');
}
