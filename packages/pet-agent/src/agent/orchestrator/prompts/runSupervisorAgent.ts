import type { RunSupervisorCapabilityDocument } from '../runSupervisor/capabilityDocuments';
import type { RunSupervisorInput } from '../runSupervisor/runner';
import type { CapabilityRoutingManifest } from '../runSupervisor/routingManifest';
import {
  RUN_SUPERVISOR_BOUNDARY_SYSTEM_PROMPT,
  RUN_SUPERVISOR_CONTEXT_PROMPT,
  RUN_SUPERVISOR_ENTRY_SYSTEM_PROMPT,
  RUN_SUPERVISOR_TURN_PROMPT,
} from './templates/runSupervisorAgent.prompt';
import { buildRunUserRequestContext } from './context';
import { buildCapabilityRoutingManifest } from './capabilityRoutingManifest';
import { escapeXmlAttribute, indentXmlBlock, xmlTextBlock } from '../../../prompts/xml';
import { buildInvocationHintContext } from '../../../prompts/invocationHint';

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

function buildSupervisionBoundary(input: RunSupervisorInput) {
  return xmlTextBlock('supervisor_plan', JSON.stringify(input.state));
}

export function buildRunSupervisorAgentSystemPrompt(
  mode: RunSupervisorInput['mode'],
) {
  return mode === 'entry'
    ? RUN_SUPERVISOR_ENTRY_SYSTEM_PROMPT.render({})
    : RUN_SUPERVISOR_BOUNDARY_SYSTEM_PROMPT.render({});
}

/** Facts stable for the run: the request, the routing manifest and disclosed documents. */
export function buildRunSupervisorContextInput(
  input: RunSupervisorInput,
  disclosedCapabilities: readonly RunSupervisorCapabilityDocument[],
  routingManifest: CapabilityRoutingManifest,
) {
  return RUN_SUPERVISOR_CONTEXT_PROMPT.render({
    userRequest: [buildRunUserRequestContext(input.userRequest),
      ...(input.hint ? [buildInvocationHintContext(input.hint, 'supervisor')] : []),
    ].join('\n\n'),
    routingContext: buildCapabilityRoutingManifest(routingManifest),
    capabilityContext: buildCapabilityContext(disclosedCapabilities),
  });
}

/** Facts and instructions for this invocation only. */
export function buildRunSupervisorTurnInput(input: RunSupervisorInput) {
  const turnContext = xmlTextBlock('invocation', input.mode === 'entry'
    ? 'This run has no plan yet. Interpret the user request, then call submit_plan before any delegate_capability; delegations in earlier runs followed plans of their own and are not a pattern to repeat. Ask the user directly when only they can supply missing information, a choice or an authorization. Preserve established requirements unless the user requests a change.'
    : 'Keep the goal and its authorization scope. Adjust pending work, and calibrate adjustedGoal within that scope, when the latest user message or execution evidence warrants it. Ask the user before going beyond the goal.');
  // Entry always starts from an empty plan (plan_request clears it), so only a
  // boundary has plan facts to show.
  return RUN_SUPERVISOR_TURN_PROMPT.render({
    planContext: input.mode === 'entry' ? '' : buildSupervisionBoundary(input),
    turnContext,
  }).trim();
}
