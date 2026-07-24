import assert from 'node:assert/strict';
import test from 'node:test';
import {
  defineCapability,
  defineInstructionDocument,
} from './capability';

test('defineInstructionDocument normalizes content and computes a stable digest', () => {
  const first = defineInstructionDocument({
    content: '\n# Inspect\n\nRead the repository.\n',
    source: { kind: 'inline', id: 'test:inspect' },
  });
  const second = defineInstructionDocument({
    content: '# Inspect\n\nRead the repository.',
    source: { kind: 'inline', id: 'test:inspect-copy' },
  });

  assert.equal(first.content, '# Inspect\n\nRead the repository.');
  assert.equal(first.digest, second.digest);
  assert.match(first.digest, /^[a-f0-9]{64}$/);
});

test('defineCapability rejects duplicate required Toolkit dependencies', () => {
  assert.throws(
    () => defineCapability({
      name: 'inspect',
      description: 'Inspect a repository.',
      uses: ['git', 'git'],
      instructions: defineInstructionDocument({
        content: '# Inspect\n\nRead the repository.',
        source: { kind: 'inline', id: 'test:inspect' },
      }),
    }),
    /uses must not contain duplicates/,
  );
});

test('defineCapability rejects names that cannot form a stable route id', () => {
  assert.throws(
    () => defineCapability({
      name: 'inspect.repo',
      description: 'Inspect a repository.',
      uses: ['git'],
      instructions: defineInstructionDocument({
        content: '# Inspect\n\nRead the repository.',
        source: { kind: 'inline', id: 'test:inspect' },
      }),
    }),
    /must use lowercase letters/,
  );
});

test('defineCapability reports a contract error for a non-string name', () => {
  assert.throws(
    () => defineCapability({
      name: 42,
      description: 'Inspect a repository.',
      uses: ['git'],
      instructions: defineInstructionDocument({
        content: '# Inspect\n\nRead the repository.',
        source: { kind: 'inline', id: 'test:inspect' },
      }),
    } as never),
    /Capability name must be non-empty/,
  );
});

test('defineCapability rejects an InstructionDocument whose content drifted from its digest', () => {
  const instructions = defineInstructionDocument({
    content: '# Inspect\n\nRead the repository.',
    source: { kind: 'inline', id: 'test:inspect' },
  });

  assert.throws(
    () => defineCapability({
      name: 'inspect',
      description: 'Inspect a repository.',
      uses: ['git'],
      instructions: {
        ...instructions,
        content: '# Inspect\n\nMutated after digesting.',
      },
    }),
    /instruction digest does not match content/,
  );
});
