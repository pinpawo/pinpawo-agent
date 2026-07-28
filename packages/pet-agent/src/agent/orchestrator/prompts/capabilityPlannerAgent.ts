import {
  buildOrchestratorDecisionPromptPrefix,
} from './shared';
import type { CapabilityPlannerInput } from '../capabilityPlannerRunner';
import {
  CAPABILITY_PLANNER_AGENT_INPUT_PROMPT,
  CAPABILITY_PLANNER_AGENT_SYSTEM_PROMPT,
} from './templates/capabilityPlannerAgent.prompt';

function escapedJson(value: unknown) {
  return escapeXml(JSON.stringify(value));
}

function escapeXml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export function buildCapabilityPlannerAgentSystemPrompt() {
  return CAPABILITY_PLANNER_AGENT_SYSTEM_PROMPT.render({
    sharedPrefix: buildOrchestratorDecisionPromptPrefix(),
  });
}

export function buildCapabilityPlannerAgentInput(input: CapabilityPlannerInput) {
  return CAPABILITY_PLANNER_AGENT_INPUT_PROMPT.render({
    mode: input.mode,
    workspaceContext: escapedJson({
      registry_digest: input.workspace.registryDigest,
      logical_root: '.',
      document_count: input.workspace.entries.length,
      default_document_glob: '**/CAPABILITY.md',
    }),
    userIntentContext: escapeXml(input.userIntentContext),
    pendingTaskContext: input.mode === 'direct'
      ? escapedJson({
          objective: input.pendingTask.task,
          context_summary: input.pendingTask.contextSummary,
        })
      : 'null',
    completedTasksContext: escapedJson(input.completedTasks),
    remainingPlanContext: escapedJson(input.remainingPlan),
    latestHandoffContext: input.latestHandoff
      ? escapeXml(input.latestHandoff)
      : 'null',
  });
}
