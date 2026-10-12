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
import { escapeXmlAttribute, indentXmlBlock, xmlTextBlock } from '../../../prompts/xml';

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
          '    <toolkits>',
          ...capability.toolkits.map((toolkit) => [
            `      <toolkit name="${escapeXmlAttribute(toolkit.name)}">`,
            indentXmlBlock(xmlTextBlock('description', toolkit.description), 8),
            '      </toolkit>',
          ].join('\n')),
          '    </toolkits>',
          '  </capability>',
        ].join('\n'))
      : ['  <none />']),
    '</capability_routing_manifest>',
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
    userRequest: buildRunUserRequestContext(input.userRequest),
    routingContext: buildCapabilityRoutingManifest(routingManifest),
    capabilityContext: buildCapabilityContext(disclosedCapabilities),
  });
}

/** Facts and instructions for this invocation only. */
export function buildRunSupervisorTurnInput(input: RunSupervisorInput) {
  const turnContext = xmlTextBlock('invocation', input.mode === 'entry'
    ? 'Interpret the user request before submitting the execution plan. Preserve established requirements unless the user requests a change.'
    : 'Keep the goal and its authorization scope. Adjust pending work, and calibrate adjustedGoal within that scope, when the latest user message or execution evidence warrants it. Ask the user before going beyond the goal.');
  return RUN_SUPERVISOR_TURN_PROMPT.render({
    planContext: input.mode === 'entry'
      ? xmlTextBlock('remaining_plan', JSON.stringify(input.state.plan))
      : buildSupervisionBoundary(input),
    turnContext,
  });
}
