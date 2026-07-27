import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  defineCapability,
  defineCapabilityDocumentSource,
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

function readGeneralCapability(): AgentCapability {
  const documentUrl = resolveGeneralCapabilityDocumentUrl();
  const documentPath = fileURLToPath(documentUrl);
  const source = readFileSync(documentUrl, 'utf8');
  const { frontmatter, body } = parseFrontmatterDocument(
    source,
    documentPath,
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
    document: defineCapabilityDocumentSource({
      filePath: documentPath,
      content: source,
    }),
  });
}

let cachedGeneralCapability: AgentCapability | null | undefined;

/**
 * The bundled General Capability is loaded through the same Markdown contract
 * as user Capabilities. Keep its immutable result cached, but defer I/O and
 * parsing until the host assembles a runtime so importing local-agent cannot be
 * taken down by one malformed Capability document.
 */
export function loadGeneralCapability(): AgentCapability | null {
  if (cachedGeneralCapability !== undefined) {
    return cachedGeneralCapability;
  }
  try {
    cachedGeneralCapability = readGeneralCapability();
  } catch (error) {
    cachedGeneralCapability = null;
    console.warn(
      '[capabilities] built-in "general" unavailable:',
      error instanceof Error ? error.message : String(error),
    );
  }
  return cachedGeneralCapability;
}
