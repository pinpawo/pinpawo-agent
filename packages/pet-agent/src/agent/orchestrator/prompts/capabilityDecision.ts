import type { AgentActor } from '../../../types/agent';
import type { RunPendingTask } from '../types';
import { clipForPrompt } from '../utils';
import {
  buildDecisionConfig,
  buildOrchestratorDecisionPromptPrefix,
  promptBlock,
  xmlTextBlock,
} from './shared';
import {
  CAPABILITY_DECISION_INPUT_PROMPT,
  CAPABILITY_DECISION_SYSTEM_PROMPT,
} from './templates/capabilityDecision.prompt';

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
  return CAPABILITY_DECISION_INPUT_PROMPT.render({
    runtimeContextBlock: promptBlock(params.runtimeContext, 2),
    taskBlock: promptBlock(task
      ? xmlTextBlock('task', clipForPrompt(task.task, 420))
      : '<task missing="true" />', 2),
    contextSummaryBlock: promptBlock(task?.contextSummary
      ? xmlTextBlock('context_summary', clipForPrompt(task.contextSummary, 420))
      : null, 2),
    searchKeywordsBlock: promptBlock(task?.searchKeywords
      ? xmlTextBlock('search_keywords', clipForPrompt(task.searchKeywords, 240))
      : null, 2),
    routeTargetsBlock: promptBlock(params.targetsContext
      ? xmlTextBlock('route_targets', params.targetsContext, ' role="fact" source="capability_search"')
      : null, 2),
  });
}
