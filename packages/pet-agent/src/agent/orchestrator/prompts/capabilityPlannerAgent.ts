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
  if (input.latestUserMessage) {
    lines.push(`最新用户消息：${input.latestUserMessage}`);
  }
  if (input.activeDelegation) {
    lines.push(`当前 Capability：${input.activeDelegation.capability}`);
    lines.push(`当前任务：${input.activeDelegation.task}`);
    lines.push(`当前 delegation ID：${input.activeDelegation.delegationId}`);
  }
  if (input.latestAnnounce) {
    if (input.latestAnnounce.completionReason) {
      lines.push(`执行停止原因：${input.latestAnnounce.completionReason}`);
    }
    if (input.latestAnnounce.text) {
      lines.push(`待验收的执行结果：${input.latestAnnounce.text}`);
    }
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
  const userGoal = buildRunUserGoalContext(input.userGoal);
  return input.mode === 'entry' && !input.latestUserMessage
    ? CAPABILITY_PLANNER_ENTRY_INPUT_PROMPT.render({ userGoal })
    : CAPABILITY_PLANNER_BOUNDARY_INPUT_PROMPT.render({
      userGoal,
      planningState: buildPlanningState(input),
    });
}
