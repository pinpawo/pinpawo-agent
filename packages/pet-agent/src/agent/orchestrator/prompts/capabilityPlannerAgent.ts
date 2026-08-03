import {
  indentXmlBlock,
  promptBlock,
  xmlTextBlock,
} from './shared';
import type { CapabilityPlannerInput } from '../capabilityPlannerRunner';
import {
  CAPABILITY_PLANNER_AGENT_INPUT_PROMPT,
  CAPABILITY_PLANNER_BOUNDARY_SYSTEM_PROMPT,
  CAPABILITY_PLANNER_ENTRY_SYSTEM_PROMPT,
} from './templates/capabilityPlannerAgent.prompt';

function buildCompletedTaskBlock(
  task: CapabilityPlannerInput['completedTask'],
) {
  return task ? xmlTextBlock('completed_task', task) : null;
}

function buildRemainingPlanBlock(
  tasks: CapabilityPlannerInput['remainingPlan'],
) {
  if (tasks.length === 0) return null;
  const lines = ['<remaining_plan>'];
  for (const task of tasks) {
    lines.push('  <task>');
    lines.push(indentXmlBlock(xmlTextBlock('capability', task.capability), 4));
    lines.push(indentXmlBlock(xmlTextBlock('description', task.task), 4));
    lines.push('  </task>');
  }
  lines.push('</remaining_plan>');
  return lines.join('\n');
}

export function buildCapabilityPlannerAgentSystemPrompt(
  mode: CapabilityPlannerInput['mode'],
) {
  return mode === 'entry'
    ? CAPABILITY_PLANNER_ENTRY_SYSTEM_PROMPT.render({})
    : CAPABILITY_PLANNER_BOUNDARY_SYSTEM_PROMPT.render({});
}

export function buildCapabilityPlannerAgentInput(input: CapabilityPlannerInput) {
  return CAPABILITY_PLANNER_AGENT_INPUT_PROMPT.render({
    completedTaskBlock: promptBlock(
      buildCompletedTaskBlock(input.completedTask),
      2,
    ),
    remainingPlanBlock: promptBlock(
      buildRemainingPlanBlock(input.remainingPlan),
      2,
    ),
  });
}
