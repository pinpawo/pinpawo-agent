import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  defineCapability,
  defineCapabilityDocumentSource,
  defineInstructionDocument,
  type AgentCapability,
} from '@pinpawo/pet-agent';
import { parseFrontmatterDocument } from '../../capabilityLoader';

function resolveCapabilityCreatorDocumentUrl(): URL {
  const sourceUrl = new URL('./CAPABILITY.md', import.meta.url);
  if (existsSync(sourceUrl)) return sourceUrl;

  const bundledUrl = new URL('./capabilities/capabilityCreator/CAPABILITY.md', import.meta.url);
  if (existsSync(bundledUrl)) return bundledUrl;

  throw new Error('Built-in capability_creator Capability document is missing');
}

let cachedCapability: AgentCapability | undefined;

export function createCapabilityCreatorCapability(): AgentCapability {
  if (cachedCapability) return cachedCapability;
  const documentUrl = resolveCapabilityCreatorDocumentUrl();
  const documentPath = fileURLToPath(documentUrl);
  const source = readFileSync(documentUrl, 'utf8');
  const { frontmatter, body } = parseFrontmatterDocument(source, documentPath);
  cachedCapability = defineCapability({
    name: frontmatter.name,
    description: frontmatter.description,
    uses: frontmatter.uses,
    instructions: defineInstructionDocument({
      content: body,
    }),
    document: defineCapabilityDocumentSource({
      filePath: documentPath,
      content: source,
    }),
  });
  return cachedCapability;
}

export { createCapabilityCreatorToolkit } from './tools';
