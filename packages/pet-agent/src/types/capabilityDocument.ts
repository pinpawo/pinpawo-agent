import { createHash } from 'node:crypto';
import { parseDocument, visit } from 'yaml';
import type { AgentCapability } from './capability';

export const CAPABILITY_DOCUMENT_FILE_NAME = 'CAPABILITY.md';
export const CAPABILITY_DOCUMENT_FRONTMATTER_MAX_BYTES = 16 * 1024;
export const CAPABILITY_DOCUMENT_MAX_BYTES = 64 * 1024;

export type CapabilityDocumentFrontmatter = {
  name: string;
  description: string;
  uses: string[];
  version: 1;
  icon?: string;
  color?: string;
  defaultEnabled?: boolean;
  entry?: string;
};

/**
 * CAPABILITY.md v1 shipped before the strict YAML parser. Preserve only the
 * two legacy spellings that existing user documents could rely on while
 * leaving every other field and YAML feature under the strict parser.
 */
function normalizeLegacyV1Frontmatter(header: string): string {
  let inBlockUses = false;
  return header.split('\n').map((line) => {
    const field = line.match(/^([A-Za-z][A-Za-z0-9_]*):[ \t]*(.*)$/);
    if (field) {
      const [, key, rawValue = ''] = field;
      inBlockUses = key === 'uses' && !rawValue.trim();
      if (key === 'description') {
        const value = rawValue.trim();
        const hasExplicitYamlForm = [
          '"',
          "'",
          '|',
          '>',
          '!',
          '&',
          '*',
          '[',
          '{',
        ].some((prefix) => value.startsWith(prefix));
        if (
          value
          && !hasExplicitYamlForm
          && (value.includes('#') || value.includes(':'))
        ) {
          return `description: ${JSON.stringify(value)}`;
        }
      }
      return line;
    }

    if (inBlockUses) {
      const listItem = line.match(/^([ \t]+)-([ \t]+)(.+)$/);
      if (
        listItem
        && (listItem[1]?.includes('\t') || listItem[2]?.includes('\t'))
      ) {
        return `  - ${listItem[3] ?? ''}`;
      }
    }
    return line;
  }).join('\n');
}

function parseFrontmatterYaml(
  header: string,
  path: string,
): Record<string, unknown> {
  const document = parseDocument(header, {
    version: '1.2',
    schema: 'core',
    strict: true,
    stringKeys: true,
    uniqueKeys: true,
    merge: false,
    resolveKnownTags: false,
    logLevel: 'error',
  });
  const issue = document.errors[0] ?? document.warnings[0];
  if (issue) {
    const detail = issue.code === 'DUPLICATE_KEY'
      ? 'duplicate frontmatter field'
      : `invalid YAML frontmatter: ${issue.message}`;
    throw new Error(`${path}: ${detail}`);
  }

  let unsupportedFeature: string | null = null;
  visit(document, {
    Alias: () => {
      unsupportedFeature = 'aliases';
      return visit.BREAK;
    },
    Node: (_key, node) => {
      if (node.anchor) {
        unsupportedFeature = 'anchors';
        return visit.BREAK;
      }
      if (node.tag) {
        unsupportedFeature = 'explicit tags';
        return visit.BREAK;
      }
    },
  });
  if (unsupportedFeature) {
    throw new Error(
      `${path}: YAML ${unsupportedFeature} are not supported in Capability frontmatter`,
    );
  }

  let parsed: unknown;
  try {
    parsed = document.toJS({
      mapAsMap: true,
      maxAliasCount: 0,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${path}: invalid YAML frontmatter: ${message}`);
  }
  if (!(parsed instanceof Map)) {
    throw new Error(`${path}: YAML frontmatter must be a mapping`);
  }

  return Object.fromEntries(parsed) as Record<string, unknown>;
}

export function parseCapabilityDocument(
  source: string,
  path: string,
): { frontmatter: CapabilityDocumentFrontmatter; body: string } {
  const normalized = source.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    throw new Error(`${path}: must start with YAML frontmatter`);
  }
  const end = normalized.indexOf('\n---\n', 4);
  if (end < 0) {
    throw new Error(`${path}: frontmatter closing delimiter is missing`);
  }

  const header = normalized.slice(4, end);
  if (
    Buffer.byteLength(header, 'utf8')
    > CAPABILITY_DOCUMENT_FRONTMATTER_MAX_BYTES
  ) {
    throw new Error(
      `${path}: YAML frontmatter exceeds ${String(CAPABILITY_DOCUMENT_FRONTMATTER_MAX_BYTES)} bytes`,
    );
  }
  const body = normalized.slice(end + 5).trim();
  const raw = parseFrontmatterYaml(
    normalizeLegacyV1Frontmatter(header),
    path,
  );

  const supported = new Set([
    'name',
    'description',
    'uses',
    'version',
    'icon',
    'color',
    'defaultEnabled',
    'entry',
  ]);
  const unknown = Object.keys(raw).filter((key) => !supported.has(key));
  if (unknown.length > 0) {
    throw new Error(`${path}: unsupported frontmatter field(s): ${unknown.join(', ')}`);
  }
  if (typeof raw.name !== 'string' || !raw.name.trim()) {
    throw new Error(`${path}: "name" must be a non-empty string`);
  }
  if (typeof raw.description !== 'string' || !raw.description.trim()) {
    throw new Error(`${path}: "description" must be a non-empty string`);
  }
  if (
    !Array.isArray(raw.uses)
    || raw.uses.some((name) => typeof name !== 'string' || !name.trim())
  ) {
    throw new Error(`${path}: "uses" must contain Toolkit names`);
  }
  if (new Set(raw.uses).size !== raw.uses.length) {
    throw new Error(`${path}: "uses" must not contain duplicate Toolkit names`);
  }
  if (raw.version !== 1) {
    throw new Error(`${path}: "version" must be 1`);
  }
  if (!body) {
    throw new Error(`${path}: Markdown body must not be empty`);
  }
  if (Buffer.byteLength(body, 'utf8') > CAPABILITY_DOCUMENT_MAX_BYTES) {
    throw new Error(
      `${path}: Markdown body exceeds ${String(CAPABILITY_DOCUMENT_MAX_BYTES)} bytes`,
    );
  }

  for (const field of ['icon', 'color', 'entry'] as const) {
    if (
      raw[field] !== undefined
      && (typeof raw[field] !== 'string' || !raw[field].trim())
    ) {
      throw new Error(`${path}: "${field}" must be a non-empty string when present`);
    }
  }
  if (
    raw.defaultEnabled !== undefined
    && typeof raw.defaultEnabled !== 'boolean'
  ) {
    throw new Error(`${path}: "defaultEnabled" must be a boolean when present`);
  }

  return {
    frontmatter: raw as CapabilityDocumentFrontmatter,
    body,
  };
}

export function assertCapabilityDocumentMatches(
  capability: AgentCapability,
  source: string,
  path: string,
) {
  const { frontmatter, body } = parseCapabilityDocument(source, path);
  if (frontmatter.name !== capability.name) {
    throw new Error(
      `Capability "${capability.name}" document declares name "${frontmatter.name}"`,
    );
  }
  if (frontmatter.description !== capability.description) {
    throw new Error(
      `Capability "${capability.name}" document description differs from the compiled definition`,
    );
  }
  if (
    frontmatter.uses.length !== capability.uses.length
    || frontmatter.uses.some((name, index) => name !== capability.uses[index])
  ) {
    throw new Error(
      `Capability "${capability.name}" document Toolkit dependencies differ from the compiled definition`,
    );
  }
  const bodyDigest = createHash('sha256').update(body, 'utf8').digest('hex');
  if (bodyDigest !== capability.instructions.digest) {
    throw new Error(
      `Capability "${capability.name}" document instructions differ from the compiled definition`,
    );
  }
}
