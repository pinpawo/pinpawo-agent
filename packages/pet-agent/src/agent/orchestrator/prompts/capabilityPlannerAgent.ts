import {
  buildOrchestratorDecisionPromptPrefix,
  indentXmlBlock,
  promptBlock,
  xmlTextBlock,
} from './shared';
import type { CapabilityPlannerInput } from '../capabilityPlannerRunner';
import {
  CAPABILITY_PLANNER_AGENT_INPUT_PROMPT,
  CAPABILITY_PLANNER_AGENT_SYSTEM_PROMPT,
} from './templates/capabilityPlannerAgent.prompt';

function escapeXmlAttribute(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function buildCompletedTasksBlock(
  tasks: CapabilityPlannerInput['completedTasks'],
) {
  if (tasks.length === 0) return null;
  const lines = ['<completed_tasks>'];
  for (const task of tasks) {
    lines.push('  <task>');
    lines.push(indentXmlBlock(xmlTextBlock('objective', task.objective), 4));
    if (task.result) {
      lines.push(indentXmlBlock(xmlTextBlock('result', task.result), 4));
    }
    lines.push('  </task>');
  }
  lines.push('</completed_tasks>');
  return lines.join('\n');
}

function buildRemainingPlanBlock(
  tasks: CapabilityPlannerInput['remainingPlan'],
) {
  if (tasks.length === 0) return null;
  const lines = ['<remaining_plan>'];
  for (const task of tasks) {
    lines.push('  <task>');
    lines.push(indentXmlBlock(xmlTextBlock('objective', task.objective), 4));
    lines.push(indentXmlBlock(
      xmlTextBlock('capability_intent', task.capabilityIntent),
      4,
    ));
    lines.push('  </task>');
  }
  lines.push('</remaining_plan>');
  return lines.join('\n');
}

export function buildCapabilityPlannerAgentSystemPrompt() {
  return CAPABILITY_PLANNER_AGENT_SYSTEM_PROMPT.render({
    sharedPrefix: buildOrchestratorDecisionPromptPrefix(),
  });
}

export function buildCapabilityPlannerAgentInput(input: CapabilityPlannerInput) {
  return CAPABILITY_PLANNER_AGENT_INPUT_PROMPT.render({
    mode: input.mode,
    registryDigest: escapeXmlAttribute(input.workspace.registryDigest),
    documentCount: String(input.workspace.entries.length),
    userIntentContextBlock: promptBlock(input.userIntentContext, 2),
    completedTasksBlock: promptBlock(
      buildCompletedTasksBlock(input.completedTasks),
      2,
    ),
    remainingPlanBlock: promptBlock(
      buildRemainingPlanBlock(input.remainingPlan),
      2,
    ),
    latestHandoffBlock: promptBlock(
      input.latestHandoff
        ? xmlTextBlock('latest_handoff', input.latestHandoff)
        : null,
      2,
    ),
  });
}
