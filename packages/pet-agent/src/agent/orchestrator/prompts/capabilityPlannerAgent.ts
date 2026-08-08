import type {
  CapabilityPlannerBriefing,
  CapabilityPlannerInput,
} from '../capabilityPlanner/runner';
import {
  CAPABILITY_PLANNER_BOUNDARY_INPUT_PROMPT,
  CAPABILITY_PLANNER_BOUNDARY_SYSTEM_PROMPT,
  CAPABILITY_PLANNER_ENTRY_INPUT_PROMPT,
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
  return input.mode === 'entry'
    ? CAPABILITY_PLANNER_ENTRY_INPUT_PROMPT.render({
      briefing: buildPlannerBriefing(input.briefing),
      planningState: buildPlanningState(input),
    })
    : CAPABILITY_PLANNER_BOUNDARY_INPUT_PROMPT.render({
      planningState: buildPlanningState(input),
    });
}

/**
 * Entry-only. Restating the request at a boundary would repeat the goal at a
 * lower fidelity than the remaining plan already carries, while claiming the
 * authority of a resolved task boundary.
 */
function buildPlannerBriefing(briefing: CapabilityPlannerBriefing): string {
  const lines = [
    '<planner_request_briefing role="task_boundary" source="orchestrator" trust="read_only">',
    indentXmlBlock(xmlTextBlock('objective', briefing.objective), 2),
  ];
  if (briefing.context) {
    lines.push(indentXmlBlock(xmlTextBlock('relevant_context', briefing.context), 2));
  }
  lines.push('</planner_request_briefing>');
  return lines.join('\n');
}
