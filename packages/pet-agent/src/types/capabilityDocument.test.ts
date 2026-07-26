import assert from 'node:assert/strict';
import test from 'node:test';
import {
  defineCapability,
  defineInstructionDocument,
} from './capability';
import {
  assertCapabilityDocumentMatches,
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
