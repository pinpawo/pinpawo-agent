import type { RunSupervisorCapabilityDocument } from '../runSupervisor/capabilityDocuments';
import type { RunSupervisorInput } from '../runSupervisor/runner';
import type { CapabilityRoutingManifest } from '../runSupervisor/routingManifest';
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

export function buildRunSupervisorAgentInput(
  input: RunSupervisorInput,
  disclosedCapabilities: readonly RunSupervisorCapabilityDocument[],
  routingManifest: CapabilityRoutingManifest,
) {
  const userRequest = buildRunUserRequestContext(input.userRequest);
  const routingContext = buildCapabilityRoutingManifest(routingManifest);
  const capabilityContext = buildCapabilityContext(disclosedCapabilities);
  const remainingPlan = xmlTextBlock('remaining_plan', JSON.stringify(input.state.plan));
  const turnContext = xmlTextBlock('invocation', input.inputId.startsWith('human:')
    ? input.mode === 'boundary'
      ? 'Fresh user input: interpret it before any execution. If it explicitly requests or confirms a change, use adjust_plan to update the goal and pending work, choosing whether to continue or replace the active delegation. Do not ask again for an adjustment the user already requested.'
      : 'Fresh user input: interpret it before submitting the execution plan. Preserve established requirements unless the user requests or confirms a change.'
    : 'Keep the established goal and plan. Ask the user before changing them.');
  return input.mode === 'entry'
    ? RUN_SUPERVISOR_ENTRY_INPUT_PROMPT.render({
        userRequest,
        routingContext,
        capabilityContext: [capabilityContext, remainingPlan, turnContext].join('\n\n'),
      })
    : RUN_SUPERVISOR_BOUNDARY_INPUT_PROMPT.render({
        userRequest,
        routingContext,
        capabilityContext: [capabilityContext, turnContext].join('\n\n'),
        supervisionBoundary: buildSupervisionBoundary(input),
      });
}
