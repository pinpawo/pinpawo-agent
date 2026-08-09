import type { CapabilityPlannerInput } from '../capabilityPlanner/runner';
import {
  CAPABILITY_PLANNER_BOUNDARY_INPUT_PROMPT,
  CAPABILITY_PLANNER_BOUNDARY_SYSTEM_PROMPT,
  CAPABILITY_PLANNER_ENTRY_INPUT_PROMPT,
  CAPABILITY_PLANNER_ENTRY_SYSTEM_PROMPT,
} from './templates/capabilityPlannerAgent.prompt';
import { buildRunUserGoalContext } from './context';

function buildPlanningState(input: CapabilityPlannerInput) {
  const lines: string[] = [];
  if (input.completedTask) {
    lines.push(`刚完成的任务：${input.completedTask}`);
  }
  if (input.completedTaskResult) {
    lines.push(`已接受的任务结果：${input.completedTaskResult}`);
  }
  if (input.remainingPlan.length > 0) {
    lines.push('此前保留的后续任务：');
    for (const task of input.remainingPlan) {
      lines.push(`- [${task.capability}] ${task.task}`);
    }
  }
  return lines.length > 0 ? lines.join('\n') : '无。';
}

export function buildCapabilityPlannerAgentSystemPrompt(
  mode: CapabilityPlannerInput['mode'],
) {
  return mode === 'entry'
    ? CAPABILITY_PLANNER_ENTRY_SYSTEM_PROMPT.render({})
    : CAPABILITY_PLANNER_BOUNDARY_SYSTEM_PROMPT.render({});
}

export function buildCapabilityPlannerAgentInput(input: CapabilityPlannerInput) {
  return input.mode === 'entry'
    ? CAPABILITY_PLANNER_ENTRY_INPUT_PROMPT.render({
      userGoal: buildRunUserGoalContext(input.userGoal),
    })
    : CAPABILITY_PLANNER_BOUNDARY_INPUT_PROMPT.render({
      userGoal: buildRunUserGoalContext(input.userGoal),
      planningState: buildPlanningState(input),
    });
}
