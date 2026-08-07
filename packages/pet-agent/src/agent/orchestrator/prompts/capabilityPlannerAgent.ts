import type { CapabilityPlannerInput } from '../capabilityPlanner/runner';
import {
  CAPABILITY_PLANNER_AGENT_INPUT_PROMPT,
  CAPABILITY_PLANNER_BOUNDARY_SYSTEM_PROMPT,
  CAPABILITY_PLANNER_ENTRY_SYSTEM_PROMPT,
} from './templates/capabilityPlannerAgent.prompt';
import { indentXmlBlock, xmlTextBlock } from './shared';

function buildPlanningState(input: CapabilityPlannerInput) {
  const lines: string[] = [];
  if (input.completedTask) {
    lines.push(`刚完成的任务：${input.completedTask}`);
  }
  if (input.completedTaskResult) {
    lines.push(`任务结果摘要：${input.completedTaskResult}`);
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
  return CAPABILITY_PLANNER_AGENT_INPUT_PROMPT.render({
    briefing: buildPlannerBriefing(input),
    planningState: buildPlanningState(input),
  });
}

function buildPlannerBriefing(input: CapabilityPlannerInput): string {
  const lines = [
    '<planner_request_briefing role="task_boundary" source="orchestrator" trust="read_only">',
    indentXmlBlock(xmlTextBlock('objective', input.briefing.objective), 2),
  ];
  if (input.briefing.context) {
    lines.push(indentXmlBlock(xmlTextBlock('relevant_context', input.briefing.context), 2));
  }
  lines.push('</planner_request_briefing>');
  return lines.join('\n');
}
