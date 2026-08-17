import type { CapabilityPlannerInput } from '../capabilityPlanner/runner';
import type { CapabilityPlannerDefaultCapability } from '../capabilityPlanner/fileExplorer';
import {
  CAPABILITY_PLANNER_BOUNDARY_INPUT_PROMPT,
  CAPABILITY_PLANNER_BOUNDARY_SYSTEM_PROMPT,
  CAPABILITY_PLANNER_ENTRY_INPUT_PROMPT,
  CAPABILITY_PLANNER_ENTRY_SYSTEM_PROMPT,
} from './templates/capabilityPlannerAgent.prompt';
import { buildRunUserRequestContext } from './context';
import { indentXmlBlock, promptBlock, xmlTextBlock } from './shared';

function buildDefaultCapabilityContext(
  defaultCapability: CapabilityPlannerDefaultCapability | null,
) {
  if (!defaultCapability) return '';
  return [
    '<default_capability role="default_executor" source="immutable_workspace" trust="read_only">',
    indentXmlBlock(xmlTextBlock('name', defaultCapability.capabilityName), 2),
    indentXmlBlock(xmlTextBlock('path', defaultCapability.path), 2),
    indentXmlBlock(xmlTextBlock('document', defaultCapability.content), 2),
    '</default_capability>',
  ].join('\n');
}

function buildPlanningState(input: CapabilityPlannerInput) {
  const lines: string[] = [];
  if (input.activeDelegation) {
    lines.push(`当前 Capability：${input.activeDelegation.capability}`);
    lines.push(`当前任务：${input.activeDelegation.task}`);
  }
  if (input.latestAnnounce) {
    if (input.latestAnnounce.completionReason) {
      lines.push(`执行停止原因：${input.latestAnnounce.completionReason}`);
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

export function buildCapabilityPlannerAgentInput(
  input: CapabilityPlannerInput,
  defaultCapability: CapabilityPlannerDefaultCapability | null = null,
) {
  const userRequest = buildRunUserRequestContext(input.userRequest);
  const defaultCapabilityContext = promptBlock(
    buildDefaultCapabilityContext(defaultCapability),
    0,
  );
  return input.mode === 'entry'
    ? CAPABILITY_PLANNER_ENTRY_INPUT_PROMPT.render({
      defaultCapabilityContext,
      userRequest,
    })
    : CAPABILITY_PLANNER_BOUNDARY_INPUT_PROMPT.render({
      defaultCapabilityContext,
      userRequest,
      planningState: buildPlanningState(input),
    });
}
