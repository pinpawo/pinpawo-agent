import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  defineCapability,
  defineCapabilityDocumentSource,
  defineInstructionDocument,
  parseCapabilityDocument,
  type AgentCapability,
} from '@pinpawo/pet-agent';

/** The same authored Agent capability is shared by every Pet using this Plugin. */
export function loadChannelContextCapability(): AgentCapability {
  const url = new URL('../capabilities/channel-context/CAPABILITY.md', import.meta.url);
  const filePath = fileURLToPath(url);
  const content = readFileSync(url, 'utf8');
  const { frontmatter, body } = parseCapabilityDocument(content, filePath);
  return defineCapability({
    name: frontmatter.name,
    description: frontmatter.description,
    uses: frontmatter.uses,
    instructions: defineInstructionDocument({ content: body }),
    document: defineCapabilityDocumentSource({ filePath, content }),
  });
}
