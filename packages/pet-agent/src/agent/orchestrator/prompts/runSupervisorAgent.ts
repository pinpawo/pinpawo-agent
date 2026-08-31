import type { RunSupervisorCapabilityDocument } from '../runSupervisor/fileExplorer';
import type { RunSupervisorInput } from '../runSupervisor/runner';
import {
  RUN_SUPERVISOR_BOUNDARY_INPUT_PROMPT,
  RUN_SUPERVISOR_BOUNDARY_SYSTEM_PROMPT,
  RUN_SUPERVISOR_ENTRY_INPUT_PROMPT,
  RUN_SUPERVISOR_ENTRY_SYSTEM_PROMPT,
} from './templates/runSupervisorAgent.prompt';
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
  documents: readonly RunSupervisorCapabilityDocument[],
) {
  return [
    '<capability_context source="supervisor_state" trust="read_only">',
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

function buildSupervisionBoundary(input: Extract<RunSupervisorInput, { mode: 'boundary' }>) {
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
    '  <prior_remaining_plan role="proposal" source="supervisor_session" authority="none" status="requires_revalidation">',
    ...input.remainingPlan.map((task) => indentXmlBlock(xmlTextBlock(
      'task',
      task.task,
      ` capability="${escapeXmlAttribute(task.capability)}"`,
    ), 4)),
    '  </prior_remaining_plan>',
  ] : ['  <prior_remaining_plan role="proposal" source="supervisor_session" authority="none" status="requires_revalidation" />'];
  return [
    '<supervision_boundary_event role="task_boundary" source="orchestrator_state">',
    ...activeDelegation,
    ...delegationAnnounces,
    ...remainingPlan,
    '</supervision_boundary_event>',
  ].join('\n');
}

export function buildRunSupervisorAgentSystemPrompt(
  mode: RunSupervisorInput['mode'],
) {
  return mode === 'entry'
    ? RUN_SUPERVISOR_ENTRY_SYSTEM_PROMPT.render({})
    : RUN_SUPERVISOR_BOUNDARY_SYSTEM_PROMPT.render({});
}

export function buildRunSupervisorAgentInput(
  input: RunSupervisorInput,
  disclosedCapabilities: readonly RunSupervisorCapabilityDocument[],
) {
  const userRequest = buildRunUserRequestContext(input.userRequest);
  const capabilityContext = buildCapabilityContext(disclosedCapabilities);
  return input.mode === 'entry'
    ? RUN_SUPERVISOR_ENTRY_INPUT_PROMPT.render({
        userRequest,
        capabilityContext,
      })
    : RUN_SUPERVISOR_BOUNDARY_INPUT_PROMPT.render({
        userRequest,
        capabilityContext,
        supervisionBoundary: buildSupervisionBoundary(input),
      });
}
