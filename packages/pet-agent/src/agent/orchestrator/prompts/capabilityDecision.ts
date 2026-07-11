import type { AgentActor } from '../../../types/agent';
import type { RunPendingTask } from '../types';
import { clipForPrompt } from '../utils';
import {
  buildDecisionConfig,
  buildOrchestratorDecisionPromptPrefix,
  indentXmlBlock,
  xmlTextBlock,
} from './shared';
import { CAPABILITY_DECISION_SYSTEM_PROMPT } from './templates/capabilityDecision.prompt';

export function buildRouteDecisionSystemPrompt(params: {
  actor: AgentActor;
  outputInstruction: string;
}): string {
  return CAPABILITY_DECISION_SYSTEM_PROMPT.render({
    config: buildDecisionConfig(params.actor),
    sharedPrefix: buildOrchestratorDecisionPromptPrefix(),
    outputInstruction: params.outputInstruction,
  });
}

export function buildRouteDecisionInput(params: {
  pendingTask: RunPendingTask | null;
  targetsContext?: string | null;
  runtimeContext?: string | null;
}): string {
  const task = params.pendingTask;
  return [
    '<capability_decision_input>',
    params.runtimeContext ? indentXmlBlock(params.runtimeContext, 2) : null,
    task
      ? indentXmlBlock(xmlTextBlock('task', clipForPrompt(task.task, 420)), 2)
      : '  <task missing="true" />',
    task?.contextSummary
      ? indentXmlBlock(xmlTextBlock('context_summary', clipForPrompt(task.contextSummary, 420)), 2)
      : null,
    task?.searchKeywords
      ? indentXmlBlock(xmlTextBlock('search_keywords', clipForPrompt(task.searchKeywords, 240)), 2)
      : null,
    params.targetsContext
      ? indentXmlBlock(xmlTextBlock('route_targets', params.targetsContext, ' role="fact" source="capability_search"'), 2)
      : null,
    '</capability_decision_input>',
  ].filter((line) => line !== null).join('\n');
}
