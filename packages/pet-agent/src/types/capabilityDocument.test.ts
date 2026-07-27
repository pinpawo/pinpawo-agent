import assert from 'node:assert/strict';
import test from 'node:test';
import {
  defineCapability,
  defineInstructionDocument,
} from './capability';
import {
  assertCapabilityDocumentMatches,
  CAPABILITY_DOCUMENT_FRONTMATTER_MAX_BYTES,
  parseCapabilityDocument,
} from './capabilityDocument';

const SOURCE = [
  '---',
  'name: inspect',
  'description: "Inspect a repository."',
  'uses:',
  '  - git',
  '  - bash',
  'version: 1',
  'icon: magnifyingglass',
  '---',
  '',
  '# Inspect',
  '',
  'Read the repository.',
  '',
].join('\n');

test('parseCapabilityDocument owns the shared CAPABILITY.md contract', () => {
  const parsed = parseCapabilityDocument(SOURCE, '/tmp/inspect/CAPABILITY.md');

  assert.deepEqual(parsed.frontmatter, {
    name: 'inspect',
    description: 'Inspect a repository.',
    uses: ['git', 'bash'],
    version: 1,
    icon: 'magnifyingglass',
  });
  assert.equal(parsed.body, '# Inspect\n\nRead the repository.');
});

test('parseCapabilityDocument supports inline uses and CRLF input', () => {
  const parsed = parseCapabilityDocument(
    SOURCE
      .replace('uses:\n  - git\n  - bash', 'uses: ["git", "bash"]')
      .replace(/\n/g, '\r\n'),
    '/tmp/inspect/CAPABILITY.md',
  );

  assert.deepEqual(parsed.frontmatter.uses, ['git', 'bash']);
});

test('parseCapabilityDocument supports YAML block scalars and single-quote escapes', () => {
  const parsed = parseCapabilityDocument(
    SOURCE
      .replace(
        'description: "Inspect a repository."',
        [
          'description: >-',
          "  It's useful to inspect",
          '  a repository.',
        ].join('\n'),
      )
      .replace('icon: magnifyingglass', "icon: 'it''s-visible'"),
    '/tmp/inspect/CAPABILITY.md',
  );

  assert.equal(
    parsed.frontmatter.description,
    "It's useful to inspect a repository.",
  );
  assert.equal(parsed.frontmatter.icon, "it's-visible");
});

test('parseCapabilityDocument rejects duplicate frontmatter fields', () => {
  assert.throws(
    () => parseCapabilityDocument(
      SOURCE.replace(
        'description: "Inspect a repository."',
        [
          'description: "Inspect a repository."',
          'description: "Replace the first value."',
        ].join('\n'),
      ),
      '/tmp/inspect/CAPABILITY.md',
    ),
    /duplicate frontmatter field/,
  );
});

test('parseCapabilityDocument rejects YAML aliases and anchors', () => {
  assert.throws(
    () => parseCapabilityDocument(
      SOURCE
        .replace(
          'description: "Inspect a repository."',
          'description: &shared "Inspect a repository."',
        )
        .replace('icon: magnifyingglass', 'icon: *shared'),
      '/tmp/inspect/CAPABILITY.md',
    ),
    /YAML (?:anchors|aliases) are not supported/,
  );
});

test('parseCapabilityDocument requires a frontmatter mapping', () => {
  assert.throws(
    () => parseCapabilityDocument(
      [
        '---',
        '- name',
        '- description',
        '---',
        '',
        '# Invalid',
      ].join('\n'),
      '/tmp/invalid/CAPABILITY.md',
    ),
    /YAML frontmatter must be a mapping/,
  );
});

test('parseCapabilityDocument rejects oversized YAML before parsing it', () => {
  assert.throws(
    () => parseCapabilityDocument(
      [
        '---',
        'name: oversized',
        `description: ${'x'.repeat(CAPABILITY_DOCUMENT_FRONTMATTER_MAX_BYTES)}`,
        'uses: []',
        'version: 1',
        '---',
        '',
        '# Oversized',
      ].join('\n'),
      '/tmp/oversized/CAPABILITY.md',
    ),
    new RegExp(
      `YAML frontmatter exceeds ${String(CAPABILITY_DOCUMENT_FRONTMATTER_MAX_BYTES)} bytes`,
    ),
  );
});

test('parseCapabilityDocument rejects unknown frontmatter fields', () => {
  assert.throws(
    () => parseCapabilityDocument(
      SOURCE.replace('icon: magnifyingglass', 'semantic_rank: 10'),
      '/tmp/inspect/CAPABILITY.md',
    ),
    /unsupported frontmatter field/,
  );
});

test('assertCapabilityDocumentMatches validates the complete runtime contract', () => {
  const capability = defineCapability({
    name: 'inspect',
    description: 'Inspect a repository.',
    uses: ['git', 'bash'],
    instructions: defineInstructionDocument({
      content: '# Inspect\n\nRead the repository.',
    }),
  });

  assert.doesNotThrow(() =>
    assertCapabilityDocumentMatches(
      capability,
      SOURCE,
      '/tmp/inspect/CAPABILITY.md',
    ));
  assert.throws(
    () => assertCapabilityDocumentMatches(
      {
        ...capability,
        uses: ['bash', 'git'],
      },
      SOURCE,
      '/tmp/inspect/CAPABILITY.md',
    ),
    /Toolkit dependencies differ/,
  );
});
