import { createHash } from 'node:crypto';
import type { AgentCapability } from './capability';

export const CAPABILITY_DOCUMENT_FILE_NAME = 'CAPABILITY.md';
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

function parseScalar(raw: string): string | boolean | number {
  const value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      throw new Error(`invalid quoted frontmatter value: ${value}`);
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^\d+$/.test(value)) return Number(value);
  return value;
}

function parseUsesInline(raw: string): string[] {
  const value = raw.trim();
  if (value === '[]') return [];
  if (!value.startsWith('[') || !value.endsWith(']')) {
    throw new Error('frontmatter "uses" must be a YAML list');
  }
  return value
    .slice(1, -1)
    .split(',')
    .map((item) => String(parseScalar(item)).trim())
    .filter(Boolean);
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
  const body = normalized.slice(end + 5).trim();
  const raw: Record<string, unknown> = {};
  let listKey: string | null = null;
  for (const [index, line] of header.split('\n').entries()) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const listItem = line.match(/^\s+-\s+(.+)$/);
    if (listItem) {
      if (!listKey) {
        throw new Error(`${path}:${String(index + 2)}: list item has no field`);
      }
      const items = raw[listKey];
      if (!Array.isArray(items)) {
        throw new Error(`${path}:${String(index + 2)}: invalid list`);
      }
      items.push(String(parseScalar(listItem[1])).trim());
      continue;
    }

    const field = line.match(/^([A-Za-z][A-Za-z0-9_]*):(?:\s*(.*))?$/);
    if (!field) {
      throw new Error(`${path}:${String(index + 2)}: unsupported frontmatter syntax`);
    }
    const [, key, value = ''] = field;
    listKey = null;
    if (key === 'uses') {
      raw[key] = value.trim() ? parseUsesInline(value) : [];
      listKey = value.trim() ? null : key;
    } else {
      raw[key] = parseScalar(value);
    }
  }

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
