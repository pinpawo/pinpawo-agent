import type { CapabilityPlannerCapabilityDocument } from '../capabilityPlanner/fileExplorer';
import type { CapabilityPlannerInput } from '../capabilityPlanner/runner';
import {
  CAPABILITY_PLANNER_BOUNDARY_INPUT_PROMPT,
  CAPABILITY_PLANNER_BOUNDARY_SYSTEM_PROMPT,
  CAPABILITY_PLANNER_ENTRY_INPUT_PROMPT,
  CAPABILITY_PLANNER_ENTRY_SYSTEM_PROMPT,
} from './templates/capabilityPlannerAgent.prompt';
import { buildRunUserRequestContext } from './context';
import { indentXmlBlock, xmlTextBlock } from './shared';

function escapeXmlAttribute(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function buildCapabilityContext(
  documents: readonly CapabilityPlannerCapabilityDocument[],
) {
  return [
    '<capability_context source="planner_state" trust="read_only">',
    ...(documents.length > 0
      ? documents.map((document) => indentXmlBlock(xmlTextBlock(
          'capability',
          document.content,
          ` name="${escapeXmlAttribute(document.capabilityName)}"`,
        ), 2))
      : ['  <none />']),
    '</capability_context>',
  ].join('\n');
}

function buildPlanningBoundary(input: Extract<CapabilityPlannerInput, { mode: 'boundary' }>) {
  const activeDelegation = [
    `  <active_delegation capability="${escapeXmlAttribute(input.activeDelegation.capability)}">`,
    indentXmlBlock(xmlTextBlock('task', input.activeDelegation.task), 4),
    '  </active_delegation>',
  ];
  const remainingPlan = input.remainingPlan.length > 0 ? [
    '  <remaining_plan>',
    ...input.remainingPlan.map((task) => indentXmlBlock(xmlTextBlock(
      'task',
      task.task,
      ` capability="${escapeXmlAttribute(task.capability)}"`,
    ), 4)),
    '  </remaining_plan>',
  ] : ['  <remaining_plan />'];
  return [
    '<planning_boundary source="orchestrator_state" trust="read_only">',
    ...activeDelegation,
    ...remainingPlan,
    '</planning_boundary>',
  ].join('\n');
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
  disclosedCapabilities: readonly CapabilityPlannerCapabilityDocument[],
) {
  const userRequest = buildRunUserRequestContext(input.userRequest);
  const capabilityContext = buildCapabilityContext(disclosedCapabilities);
  return input.mode === 'entry'
    ? CAPABILITY_PLANNER_ENTRY_INPUT_PROMPT.render({
        userRequest,
        capabilityContext,
      })
    : CAPABILITY_PLANNER_BOUNDARY_INPUT_PROMPT.render({
        userRequest,
        capabilityContext,
        planningBoundary: buildPlanningBoundary(input),
      });
}
