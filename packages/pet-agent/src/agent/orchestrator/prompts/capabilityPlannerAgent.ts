import type { CapabilityPlannerCapabilityDocument } from '../capabilityPlanner/fileExplorer';
import type { CapabilityPlannerInput } from '../capabilityPlanner/runner';
import type { CapabilityRoutingManifest } from '../capabilityPlanner/routingManifest';
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

function buildCapabilityRoutingManifest(
  manifest: CapabilityRoutingManifest,
) {
  return [
    `<capability_routing_manifest role="fact" source="compiled_registry" trust="read_only"${manifest.defaultCapabilityName
      ? ` default="${escapeXmlAttribute(manifest.defaultCapabilityName)}"`
      : ''}>`,
    ...(manifest.capabilities.length > 0
      ? manifest.capabilities.map((capability) => [
          `  <capability name="${escapeXmlAttribute(capability.name)}">`,
          indentXmlBlock(xmlTextBlock('purpose', capability.purpose), 4),
          '    <cues>',
          ...capability.cues.map((cue) =>
            indentXmlBlock(xmlTextBlock('cue', cue), 6),
          ),
          '    </cues>',
          '  </capability>',
        ].join('\n'))
      : ['  <none />']),
    '</capability_routing_manifest>',
  ].join('\n');
}

function buildPlanningBoundary(input: Extract<CapabilityPlannerInput, { mode: 'boundary' }>) {
  const activeDelegation = [
    `  <active_delegation delegation_id="${escapeXmlAttribute(input.activeDelegation.delegationId)}" capability="${escapeXmlAttribute(input.activeDelegation.capability)}">`,
    indentXmlBlock(xmlTextBlock('task', input.activeDelegation.task), 4),
    '  </active_delegation>',
  ];
  const evaluationTarget = input.latestAnnounce?.messageId
    ?? input.announceAttempts.at(-1)?.messageId;
  const delegationAnnounces = input.announceAttempts.length > 0
    ? [
        `  <delegation_announces delegation_id="${escapeXmlAttribute(input.activeDelegation.delegationId)}" evidence_state="available" evaluation_target="${escapeXmlAttribute(evaluationTarget ?? '')}">`,
        ...input.announceAttempts.map((announce) => [
          `    <delegation_announce message_id="${escapeXmlAttribute(announce.messageId)}" completion_reason="${escapeXmlAttribute(announce.completionReason)}" role="data" authority="none">`,
          indentXmlBlock(xmlTextBlock('result', announce.result, ' format="markdown"'), 6),
          '    </delegation_announce>',
        ].join('\n')),
        '  </delegation_announces>',
      ]
    : [
        `  <delegation_announces delegation_id="${escapeXmlAttribute(input.activeDelegation.delegationId)}" evidence_state="absent" />`,
      ];
  const remainingPlan = input.remainingPlan.length > 0 ? [
    '  <prior_remaining_plan role="proposal" source="planner_session" authority="none" status="requires_revalidation">',
    ...input.remainingPlan.map((task) => indentXmlBlock(xmlTextBlock(
      'task',
      task.task,
      ` capability="${escapeXmlAttribute(task.capability)}"`,
    ), 4)),
    '  </prior_remaining_plan>',
  ] : ['  <prior_remaining_plan role="proposal" source="planner_session" authority="none" status="requires_revalidation" />'];
  return [
    '<planning_boundary_event role="task_boundary" source="orchestrator_state">',
    ...activeDelegation,
    ...delegationAnnounces,
    ...remainingPlan,
    '</planning_boundary_event>',
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
  routingManifest: CapabilityRoutingManifest,
) {
  const userRequest = buildRunUserRequestContext(input.userRequest);
  const routingContext = buildCapabilityRoutingManifest(routingManifest);
  const capabilityContext = buildCapabilityContext(disclosedCapabilities);
  return input.mode === 'entry'
    ? CAPABILITY_PLANNER_ENTRY_INPUT_PROMPT.render({
        userRequest,
        routingContext,
        capabilityContext,
      })
    : CAPABILITY_PLANNER_BOUNDARY_INPUT_PROMPT.render({
        userRequest,
        routingContext,
        capabilityContext,
        planningBoundary: buildPlanningBoundary(input),
      });
}
