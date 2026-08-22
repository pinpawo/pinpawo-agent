import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { delimiter } from 'node:path';
import {
  CAPABILITY_DOCUMENT_MAX_BYTES,
  loadCapabilityDirectory,
  parseFrontmatterDocument,
} from './capabilityLoader';

async function mkCapability(
  root: string,
  id: string,
  options: {
    entry?: string;
    body?: string;
    description?: string;
    usesIndent?: string;
  } = {},
) {
  const dir = path.join(root, id);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'CAPABILITY.md'), `---
name: ${id}
description: ${options.description ?? `Description for ${id}`}
uses:
${options.usesIndent ?? '  '}- bash
version: 1
icon: wand.and.stars
color: purple
defaultEnabled: true
${options.entry ? `entry: ${options.entry}\n` : ''}---

${options.body ?? `# ${id}\n\nExecute the requested task.`}
`, 'utf8');
  return dir;
}

test('loadUserCapabilities loads a code-free CAPABILITY.md', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pinpawo-caps-'));
  const previousDirs = process.env.PINPAWO_CAPABILITY_DIRS;
  process.env.PINPAWO_CAPABILITY_DIRS = root;
  try {
    const capabilityDir = await mkCapability(root, 'unit_test_capability');

    const { loadUserCapabilities, readUserCapabilityManifests } = await import('./capabilityLoader');
    const loaded = await loadUserCapabilities();
    const manifests = readUserCapabilityManifests();
    const item = loaded.find(({ meta }) => meta.id === 'unit_test_capability');

    assert.ok(item);
    assert.match(item.capability.instructions.content, /Execute the requested task/);
    assert.match(item.capability.instructions.digest, /^[a-f0-9]{64}$/);
    assert.equal(
      item.capability.document?.filePath,
      path.join(capabilityDir, 'CAPABILITY.md'),
    );
    assert.match(item.capability.document?.digest ?? '', /^[a-f0-9]{64}$/);
    assert.equal(item.capability.lifecycle, undefined);
    assert.ok(manifests.some((meta) => meta.id === 'unit_test_capability'));
  } finally {
    if (previousDirs === undefined) {
      delete process.env.PINPAWO_CAPABILITY_DIRS;
    } else {
      process.env.PINPAWO_CAPABILITY_DIRS = previousDirs;
    }
  }
});

test('loadUserCapabilities preserves legacy v1 description and list syntax', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pinpawo-caps-v1-yaml-'));
  const previousDirs = process.env.PINPAWO_CAPABILITY_DIRS;
  process.env.PINPAWO_CAPABILITY_DIRS = root;
  try {
    await mkCapability(root, 'legacy_yaml_capability', {
      description: 'Handles API: requests for budget #1',
      usesIndent: '\t',
    });

    const { loadUserCapabilities, readUserCapabilityManifests } = await import('./capabilityLoader');
    const loaded = await loadUserCapabilities();
    const manifests = readUserCapabilityManifests();
    const item = loaded.find(
      ({ meta }) => meta.id === 'legacy_yaml_capability',
    );

    assert.equal(
      item?.meta.description,
      'Handles API: requests for budget #1',
    );
    assert.deepEqual(item?.capability.uses, ['bash']);
    assert.equal(
      manifests.find(({ id }) => id === 'legacy_yaml_capability')?.description,
      'Handles API: requests for budget #1',
    );
  } finally {
    if (previousDirs === undefined) {
      delete process.env.PINPAWO_CAPABILITY_DIRS;
    } else {
      process.env.PINPAWO_CAPABILITY_DIRS = previousDirs;
    }
  }
});

test('loadUserCapabilities follows directory symlinks in scan dirs', async () => {
  const scanRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pinpawo-caps-scan-'));
  const sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pinpawo-caps-source-'));
  const previousDirs = process.env.PINPAWO_CAPABILITY_DIRS;
  process.env.PINPAWO_CAPABILITY_DIRS = scanRoot;
  try {
    const sourceDir = await mkCapability(sourceRoot, 'linked_capability');
    await fs.symlink(sourceDir, path.join(scanRoot, 'linked_capability'));

    const { loadUserCapabilities } = await import('./capabilityLoader');
    const loaded = await loadUserCapabilities();

    assert.ok(loaded.some((item) => item.meta.id === 'linked_capability'));
  } finally {
    if (previousDirs === undefined) {
      delete process.env.PINPAWO_CAPABILITY_DIRS;
    } else {
      process.env.PINPAWO_CAPABILITY_DIRS = previousDirs;
    }
  }
});

test('loadCapabilityDirectory strictly loads one explicit collection root', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pinpawo-explicit-caps-'));
  await mkCapability(root, 'second');
  await mkCapability(root, 'first');

  const loaded = await loadCapabilityDirectory(root);

  assert.deepEqual(loaded.map(({ capability }) => capability.name), ['first', 'second']);
});

test('loadCapabilityDirectory rejects invalid child directories', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pinpawo-explicit-invalid-'));
  await fs.mkdir(path.join(root, 'missing-document'));

  await assert.rejects(
    () => loadCapabilityDirectory(root),
    /Invalid Capability directory .*missing-document.*missing CAPABILITY\.md/,
  );
});

test('loadCapabilityDirectory rejects duplicate names within one collection', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pinpawo-explicit-duplicate-'));
  const first = await mkCapability(root, 'first');
  const second = await mkCapability(root, 'second');
  const firstSource = await fs.readFile(path.join(first, 'CAPABILITY.md'), 'utf8');
  await fs.writeFile(
    path.join(second, 'CAPABILITY.md'),
    firstSource.replace('# first', '# duplicate first'),
    'utf8',
  );

  await assert.rejects(
    () => loadCapabilityDirectory(root),
    /Duplicate Capability "first"/,
  );
});

test('loadCapabilityDirectory rejects broken directory symlinks', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pinpawo-explicit-broken-link-'));
  await fs.symlink(
    path.join(root, 'missing-target'),
    path.join(root, 'selected-capability'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );

  await assert.rejects(
    () => loadCapabilityDirectory(root),
    /selected-capability.*symlink target is unavailable or not a directory/,
  );
});

test('validateCapabilityPlugin accepts an entry that only exports lifecycle.finalize', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pinpawo-caps-entry-'));
  const capabilityDir = await mkCapability(root, 'finalized_capability', { entry: './index.js' });
  await fs.writeFile(path.join(capabilityDir, 'index.js'), `
export const lifecycle = {
  finalize(result) {
    return { announceMessageId: result.announceMessageId };
  },
};
`, 'utf8');

  const { validateCapabilityPlugin } = await import('./capabilityLoader');
  const result = await validateCapabilityPlugin(capabilityDir);

  assert.equal(result.ok, true, result.errors.join('\n'));
  assert.equal(typeof result.capability?.lifecycle?.finalize, 'function');
});

test('validateCapabilityPlugin rejects entry paths outside the capability root', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pinpawo-caps-escape-'));
  const capabilityDir = await mkCapability(root, 'escaped_capability', { entry: '../outside.js' });
  await fs.writeFile(path.join(root, 'outside.js'), 'export const lifecycle = { finalize() {} };\n', 'utf8');

  const { validateCapabilityPlugin } = await import('./capabilityLoader');
  const result = await validateCapabilityPlugin(capabilityDir);

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /must stay inside/);
});

test('validateCapabilityPlugin rejects broad code exports', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pinpawo-caps-broad-entry-'));
  const capabilityDir = await mkCapability(root, 'broad_capability', { entry: './index.js' });
  await fs.writeFile(path.join(capabilityDir, 'index.js'), `
export const lifecycle = { finalize() {} };
export function createRuntime() {}
`, 'utf8');

  const { validateCapabilityPlugin } = await import('./capabilityLoader');
  const result = await validateCapabilityPlugin(capabilityDir);

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /may only export lifecycle/);
});

test('validateCapabilityPlugin rejects the host-reserved general name', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pinpawo-caps-reserved-'));
  const capabilityDir = await mkCapability(root, 'general');

  const { validateCapabilityPlugin } = await import('./capabilityLoader');
  const result = await validateCapabilityPlugin(capabilityDir);

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /name "general" is reserved by the local-agent host/);
});

test('validateCapabilityPlugin rejects local-agent built-in names', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pinpawo-caps-reserved-built-in-'));
  const capabilityDir = await mkCapability(root, 'explore');

  const { validateCapabilityPlugin } = await import('./capabilityLoader');
  const result = await validateCapabilityPlugin(capabilityDir);

  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /name "explore" is reserved by the local-agent host/);
});

test('resolveCapabilityDirs parses environment entries with the platform delimiter', async () => {
  const first = await fs.mkdtemp(path.join(os.tmpdir(), 'pinpawo-caps-source-first-'));
  const second = await fs.mkdtemp(path.join(os.tmpdir(), 'pinpawo-caps-source-second-'));
  const previousDirs = process.env.PINPAWO_CAPABILITY_DIRS;
  process.env.PINPAWO_CAPABILITY_DIRS = [first, first, second].join(delimiter);
  try {
    const { resolveCapabilityDirs } = await import('./capabilityLoader');
    const dirs = resolveCapabilityDirs();
    assert.deepEqual(dirs.slice(-2), [first, second]);
  } finally {
    if (previousDirs === undefined) {
      delete process.env.PINPAWO_CAPABILITY_DIRS;
    } else {
      process.env.PINPAWO_CAPABILITY_DIRS = previousDirs;
    }
  }
});

test('parseFrontmatterDocument accepts supported list forms and body delimiters', () => {
  const inline = parseFrontmatterDocument(`---
name: inline_capability
description: Inline uses
uses: [bash, git]
version: 1
---

# Inline

Body may contain a later delimiter:
---
still body
`, '/tmp/inline/CAPABILITY.md');
  assert.deepEqual(inline.frontmatter.uses, ['bash', 'git']);
  assert.match(inline.body, /still body/);

  const block = parseFrontmatterDocument(`---
name: block_capability
description: Block uses
uses:
  - bash
  - git
version: 1
---

# Block
`, '/tmp/block/CAPABILITY.md');
  assert.deepEqual(block.frontmatter.uses, ['bash', 'git']);
});

test('parseFrontmatterDocument accepts CRLF documents', () => {
  const parsed = parseFrontmatterDocument([
    '---',
    'name: crlf_capability',
    'description: CRLF document',
    'uses: [bash]',
    'version: 1',
    '---',
    '',
    '# CRLF',
    '',
    'Execute the requested task.',
    '',
  ].join('\r\n'), '/tmp/crlf/CAPABILITY.md');

  assert.equal(parsed.frontmatter.name, 'crlf_capability');
  assert.deepEqual(parsed.frontmatter.uses, ['bash']);
  assert.match(parsed.body, /Execute the requested task/);
});

test('parseFrontmatterDocument rejects a missing closing delimiter', () => {
  assert.throws(
    () => parseFrontmatterDocument(`---
name: unclosed_capability
description: Missing closing delimiter
uses: [bash]
version: 1

# This is still frontmatter
`, '/tmp/unclosed/CAPABILITY.md'),
    /frontmatter closing delimiter is missing/,
  );
});

const invalidFrontmatterCases: Array<{
  name: string;
  header: string;
  expected: RegExp;
  replacesUses?: boolean;
  replacesVersion?: boolean;
}> = [
  {
    name: 'unknown snake_case field',
    header: 'default_enabled: true',
    expected: /unsupported frontmatter field.*default_enabled/,
  },
  {
    name: 'duplicate Toolkit dependency',
    header: 'uses: [bash, bash]',
    expected: /must not contain duplicate Toolkit names/,
    replacesUses: true,
  },
  {
    name: 'unsupported version',
    header: 'version: 2',
    expected: /"version" must be 1/,
    replacesVersion: true,
  },
];

for (const fixture of invalidFrontmatterCases) {
  test(`parseFrontmatterDocument rejects ${fixture.name}`, () => {
    const uses = fixture.replacesUses ? fixture.header : 'uses: [bash]';
    const version = fixture.replacesVersion ? fixture.header : 'version: 1';
    const extra = fixture.replacesUses || fixture.replacesVersion ? '' : `${fixture.header}\n`;
    assert.throws(
      () => parseFrontmatterDocument(`---
name: invalid_capability
description: Invalid fixture
${uses}
${version}
${extra}---

# Invalid
`, '/tmp/invalid/CAPABILITY.md'),
      fixture.expected,
    );
  });
}

test('parseFrontmatterDocument rejects an empty or oversized Markdown body', () => {
  const header = `---
name: sized_capability
description: Sized fixture
uses: []
version: 1
---
`;
  assert.throws(
    () => parseFrontmatterDocument(header, '/tmp/empty/CAPABILITY.md'),
    /Markdown body must not be empty/,
  );
  assert.throws(
    () => parseFrontmatterDocument(
      `${header}\n${'x'.repeat(CAPABILITY_DOCUMENT_MAX_BYTES + 1)}`,
      '/tmp/oversized/CAPABILITY.md',
    ),
    /Markdown body exceeds/,
  );
});

test('legacy capability directories emit one migration warning instead of disappearing', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pinpawo-caps-legacy-'));
  const legacyDir = path.join(root, 'legacy_capability');
  await fs.mkdir(legacyDir, { recursive: true });
  await fs.writeFile(path.join(legacyDir, 'manifest.json'), '{}\n', 'utf8');
  await fs.writeFile(path.join(legacyDir, 'index.js'), 'export default {};\n', 'utf8');

  const previousDirs = process.env.PINPAWO_CAPABILITY_DIRS;
  const previousWarn = console.warn;
  const warnings: string[] = [];
  process.env.PINPAWO_CAPABILITY_DIRS = root;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  };
  try {
    const { loadUserCapabilities, readUserCapabilityManifests } = await import('./capabilityLoader');
    assert.equal(
      (await loadUserCapabilities()).some(({ meta }) => meta.id === 'legacy_capability'),
      false,
    );
    assert.equal(
      readUserCapabilityManifests().some(({ id }) => id === 'legacy_capability'),
      false,
    );
  } finally {
    console.warn = previousWarn;
    if (previousDirs === undefined) {
      delete process.env.PINPAWO_CAPABILITY_DIRS;
    } else {
      process.env.PINPAWO_CAPABILITY_DIRS = previousDirs;
    }
  }

  const legacyWarnings = warnings.filter((warning) => warning.includes('legacy_capability'));
  assert.equal(legacyWarnings.length, 1);
  assert.match(legacyWarnings[0], /removed manifest\.json\/index\.js format/);
  assert.match(legacyWarnings[0], /migrate it to CAPABILITY\.md/);
});
