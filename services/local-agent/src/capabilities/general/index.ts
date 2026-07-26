import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  defineCapability,
  defineInstructionDocument,
  GENERAL_CAPABILITY_NAME,
  type AgentCapability,
} from '@pinpawo/pet-agent';
import { parseFrontmatterDocument } from '../../capabilityLoader';

function resolveGeneralCapabilityDocumentUrl(): URL {
  const sourceUrl = new URL('./CAPABILITY.md', import.meta.url);
  if (existsSync(sourceUrl)) return sourceUrl;

  const bundledUrl = new URL('./capabilities/general/CAPABILITY.md', import.meta.url);
  if (existsSync(bundledUrl)) return bundledUrl;

  throw new Error('Built-in general Capability document is missing');
}

function loadGeneralCapability(): AgentCapability {
  const documentUrl = resolveGeneralCapabilityDocumentUrl();
  const { frontmatter, body } = parseFrontmatterDocument(
    readFileSync(documentUrl, 'utf8'),
    fileURLToPath(documentUrl),
  );
  if (frontmatter.name !== GENERAL_CAPABILITY_NAME) {
    throw new Error(
      `Built-in General Capability must use the reserved name "${GENERAL_CAPABILITY_NAME}"`,
    );
  }
  return defineCapability({
    name: frontmatter.name,
    description: frontmatter.description,
    uses: frontmatter.uses,
    instructions: defineInstructionDocument({
      content: body,
    }),
  });
}

export const generalCapability = loadGeneralCapability();
