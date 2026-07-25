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

export function buildCapabilityDecisionSystemPrompt(params: {
  actor: AgentActor;
  outputInstruction: string;
}): string {
  return CAPABILITY_DECISION_SYSTEM_PROMPT.render({
    config: buildDecisionConfig(params.actor),
    sharedPrefix: buildOrchestratorDecisionPromptPrefix(),
    outputInstruction: params.outputInstruction,
  });
}

export function buildCapabilityDecisionInput(params: {
  pendingTask: RunPendingTask | null;
  availableExecutorsContext?: string | null;
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
    availableExecutorsBlock: promptBlock(params.availableExecutorsContext
      ? xmlTextBlock(
          'available_executors',
          params.availableExecutorsContext,
          ' role="fact" source="runtime"',
        )
      : null, 2),
  });
}
