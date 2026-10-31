import type { CapabilityRoutingManifest } from '../runSupervisor/routingManifest';
import { escapeXmlAttribute, indentXmlBlock, xmlTextBlock } from '../../../prompts/xml';

/** The same current Capability facts inform goal resolution and planning. */
export function buildCapabilityRoutingManifest(manifest: CapabilityRoutingManifest): string {
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
