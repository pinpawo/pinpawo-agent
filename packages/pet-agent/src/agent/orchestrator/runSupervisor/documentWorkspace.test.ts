import assert from 'node:assert/strict';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import {
  defineCapability,
  defineCapabilityDocumentSource,
  defineInstructionDocument,
  type AgentCapability,
} from '../../../types/capability';
import { defineToolkit } from '../../../types/toolkit';
import {
  materializeCapabilityDocumentWorkspace,
  renderCapabilityDocument,
} from './documentWorkspace';
import { compileAgentRegistry } from '../registry';

function capability(params: {
  name: string;
  description?: string;
  uses?: readonly string[];
  instructions?: string;
  document?: AgentCapability['document'];
}) {
  return defineCapability({
    name: params.name,
    description: params.description ?? `${params.name} capability`,
    uses: params.uses ?? [],
    instructions: defineInstructionDocument({
      content: params.instructions ?? `# ${params.name}\n\nExecute ${params.name}.`,
    }),
    ...(params.document ? { document: params.document } : {}),
  });
}

async function temporaryDirectory(t: TestContext, prefix: string) {
  const path = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => {
    await makeWritable(path);
    await rm(path, { recursive: true, force: true });
  });
  return path;
}

async function makeWritable(path: string): Promise<void> {
  let pathStats;
  try {
    pathStats = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (pathStats.isSymbolicLink()) {
    await rm(path, { force: true });
    return;
  }
  if (!pathStats.isDirectory()) {
    await chmod(path, 0o644);
    return;
  }
  await chmod(path, 0o755);
  const entries = await readdir(path);
  await Promise.all(entries.map((entry) => makeWritable(join(path, entry))));
}

async function waitForDirectoryEntry(
  path: string,
  predicate: (entry: string) => boolean,
) {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if ((await readdir(path)).some(predicate)) {
      return;
    }
    await delay(5);
  }
  throw new Error(`Timed out waiting for a matching entry in "${path}"`);
}

test('workspace renders inline Capabilities as discoverable CAPABILITY.md files', async (t) => {
  const root = await temporaryDirectory(t, 'capability-workspace-generated-');
  const registry = compileAgentRegistry({
    toolkits: [],
    capabilities: [
      capability({
        name: 'general',
        description: 'General workspace execution.',
        instructions: '# General\n\nExecute ordinary work.',
      }),
      capability({
        name: 'unavailable',
        uses: ['missing'],
      }),
    ],
  });

  const workspace = await materializeCapabilityDocumentWorkspace({
    registry,
    cacheRoot: join(root, 'cache'),
  });

  assert.deepEqual(workspace.capabilityNames, ['general']);
  assert.equal(workspace.entries[0]?.provenance, 'generated');
  assert.equal(workspace.entries[0]?.relativePath, 'general/CAPABILITY.md');
  const source = await readFile(
    join(workspace.rootPath, 'general', 'CAPABILITY.md'),
    'utf8',
  );
  assert.equal(source, renderCapabilityDocument(registry.capabilities[0]!.capability));
  assert.match(source, /^---\nname: "general"/);
  assert.match(source, /description: "General workspace execution\."/);
  assert.match(source, /\n# General\n\nExecute ordinary work\.\n$/);
  await assert.rejects(
    lstat(join(workspace.rootPath, 'unavailable', 'CAPABILITY.md')),
    { code: 'ENOENT' },
  );
});

test('workspace copies an authored CAPABILITY.md exactly and records provenance', async (t) => {
  const root = await temporaryDirectory(t, 'capability-workspace-authored-');
  const sourcePath = join(root, 'CAPABILITY.md');
  const source = [
    '---',
    'name: "authored"',
    'description: "Authored capability."',
    'uses: []',
    'version: 1',
    '---',
    '',
    '# Authored',
    '',
    'Preserve this exact source.',
    '',
  ].join('\n');
  await writeFile(sourcePath, source, 'utf8');
  const registry = compileAgentRegistry({
    toolkits: [],
    capabilities: [capability({
      name: 'authored',
      description: 'Authored capability.',
      instructions: '# Authored\n\nPreserve this exact source.',
      document: defineCapabilityDocumentSource({
        filePath: sourcePath,
        content: source,
      }),
    })],
  });

  const workspace = await materializeCapabilityDocumentWorkspace({
    registry,
    cacheRoot: join(root, 'cache'),
  });

  assert.equal(workspace.entries[0]?.provenance, 'authored');
  assert.equal(
    await readFile(join(workspace.rootPath, 'authored', 'CAPABILITY.md'), 'utf8'),
    source,
  );
  assert.doesNotMatch(JSON.stringify(workspace), new RegExp(sourcePath));
  assert.equal(
    (await lstat(join(workspace.rootPath, 'authored', 'CAPABILITY.md'))).isSymbolicLink(),
    false,
  );
});

test('workspace keeps the registered authored snapshot when its source file changes', async (t) => {
  const root = await temporaryDirectory(t, 'capability-workspace-drift-');
  const sourcePath = join(root, 'CAPABILITY.md');
  const original = [
    '---',
    'name: drift',
    'description: drift capability',
    'uses: []',
    'version: 1',
    '---',
    '',
    '# drift',
    '',
    'Execute drift.',
    '',
  ].join('\n');
  await writeFile(sourcePath, original, 'utf8');
  const registered = capability({
    name: 'drift',
    document: defineCapabilityDocumentSource({
      filePath: sourcePath,
      content: original,
    }),
  });
  await writeFile(sourcePath, original.replace('Execute drift.', 'Changed later.'), 'utf8');

  const workspace = await materializeCapabilityDocumentWorkspace({
    registry: compileAgentRegistry({
      toolkits: [],
      capabilities: [registered],
    }),
    cacheRoot: join(root, 'cache'),
  });

  assert.equal(
    await readFile(join(workspace.rootPath, 'drift', 'CAPABILITY.md'), 'utf8'),
    original,
  );
});

test('Capability registration rejects authored metadata that differs from runtime', async (t) => {
  const root = await temporaryDirectory(t, 'capability-workspace-contract-drift-');
  const sourcePath = join(root, 'CAPABILITY.md');
  const source = [
    '---',
    'name: contract_check',
    'description: Authored description.',
    'uses: []',
    'version: 1',
    '---',
    '',
    '# Authored instructions',
    '',
  ].join('\n');
  await writeFile(sourcePath, source, 'utf8');
  assert.throws(
    () => capability({
      name: 'contract_check',
      description: 'Runtime description.',
      instructions: '# Runtime instructions',
      document: defineCapabilityDocumentSource({
        filePath: sourcePath,
        content: source,
      }),
    }),
    /document description differs from the compiled definition/,
  );
});

test('workspace applies allowed capability scope before materialization', async (t) => {
  const root = await temporaryDirectory(t, 'capability-workspace-allowed-');
  const registry = compileAgentRegistry({
    toolkits: [],
    capabilities: [
      capability({ name: 'general' }),
      capability({ name: 'explore' }),
      capability({ name: 'studio_plan' }),
    ],
  });

  const workspace = await materializeCapabilityDocumentWorkspace({
    registry,
    cacheRoot: join(root, 'cache'),
    allowedCapabilityNames: ['studio_plan', 'explore'],
  });

  assert.deepEqual(workspace.capabilityNames, ['explore', 'studio_plan']);
  await assert.rejects(
    lstat(join(workspace.rootPath, 'general', 'CAPABILITY.md')),
    { code: 'ENOENT' },
  );
});

test('workspace digest changes with compiled executor facts', async (t) => {
  const root = await temporaryDirectory(t, 'capability-workspace-generation-');
  const compiledCapability = capability({
    name: 'general',
    uses: ['workspace'],
  });
  const toolkit = (toolName: string) => defineToolkit({
    name: 'workspace',
    description: 'Workspace tools.',
    tools: [{
      tool: tool(async () => 'ok', {
        name: toolName,
        description: `${toolName} tool`,
        schema: z.object({}),
      }),
    }],
  });

  const first = await materializeCapabilityDocumentWorkspace({
    registry: compileAgentRegistry({
      toolkits: [toolkit('read_file')],
      capabilities: [compiledCapability],
    }),
    cacheRoot: join(root, 'cache'),
  });
  const second = await materializeCapabilityDocumentWorkspace({
    registry: compileAgentRegistry({
      toolkits: [toolkit('write_file')],
      capabilities: [compiledCapability],
    }),
    cacheRoot: join(root, 'cache'),
  });

  assert.notEqual(first.registryDigest, second.registryDigest);
  assert.notEqual(first.rootPath, second.rootPath);
});

test('workspace reuses a verified digest snapshot and repairs cache tampering', async (t) => {
  const root = await temporaryDirectory(t, 'capability-workspace-reuse-');
  const warnings: unknown[][] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => {
    warnings.push(args);
  });
  const registry = compileAgentRegistry({
    toolkits: [],
    capabilities: [capability({ name: 'general' })],
  });
  const first = await materializeCapabilityDocumentWorkspace({
    registry,
    cacheRoot: join(root, 'cache'),
  });
  const second = await materializeCapabilityDocumentWorkspace({
    registry,
    cacheRoot: join(root, 'cache'),
  });

  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(second.rootPath, first.rootPath);
  assert.equal(second.registryDigest, first.registryDigest);

  const capabilityDir = join(first.rootPath, 'general');
  const documentPath = join(capabilityDir, 'CAPABILITY.md');
  assert.notEqual((await lstat(first.rootPath)).mode & 0o200, 0);
  assert.equal((await lstat(documentPath)).mode & 0o222, 0);
  await chmod(documentPath, 0o644);
  await writeFile(documentPath, 'tampered', 'utf8');

  const repaired = await materializeCapabilityDocumentWorkspace({
    registry,
    cacheRoot: join(root, 'cache'),
  });

  assert.equal(repaired.reused, false);
  assert.equal(repaired.rootPath, first.rootPath);
  assert.equal(
    await readFile(join(repaired.rootPath, 'general', 'CAPABILITY.md'), 'utf8'),
    renderCapabilityDocument(registry.capabilities[0]!.capability),
  );
  assert.equal(warnings.length, 1);
  assert.match(String(warnings[0]?.[0] ?? ''), /repairing invalid/);
  assert.equal(
    (warnings[0]?.[1] as { code?: unknown } | undefined)?.code,
    'capability_workspace_snapshot_quarantined',
  );
  assert.equal(
    (await readdir(join(root, 'cache')))
      .filter((entry) => entry.startsWith('.invalid-'))
      .length,
    1,
  );
});

test('workspace repairs an incomplete digest directory', async (t) => {
  const root = await temporaryDirectory(t, 'capability-workspace-incomplete-');
  t.mock.method(console, 'warn', () => {});
  const registry = compileAgentRegistry({
    toolkits: [],
    capabilities: [
      capability({ name: 'general' }),
      capability({ name: 'explore' }),
    ],
  });
  const first = await materializeCapabilityDocumentWorkspace({
    registry,
    cacheRoot: join(root, 'cache'),
  });
  await rm(first.rootPath, { recursive: true, force: true });
  await mkdir(first.rootPath);

  const repaired = await materializeCapabilityDocumentWorkspace({
    registry,
    cacheRoot: join(root, 'cache'),
  });

  assert.equal(repaired.reused, false);
  assert.deepEqual(repaired.capabilityNames, ['explore', 'general']);
  assert.match(
    await readFile(join(repaired.rootPath, 'explore', 'CAPABILITY.md'), 'utf8'),
    /name: "explore"/,
  );
});

test('workspace repair does not depend on deleting a read-only quarantine', async (t) => {
  const root = await temporaryDirectory(t, 'capability-workspace-readonly-repair-');
  t.mock.method(console, 'warn', () => {});
  const registry = compileAgentRegistry({
    toolkits: [],
    capabilities: [capability({ name: 'general' })],
  });
  const first = await materializeCapabilityDocumentWorkspace({
    registry,
    cacheRoot: join(root, 'cache'),
  });
  const capabilityDir = join(first.rootPath, 'general');
  const documentPath = join(capabilityDir, 'CAPABILITY.md');
  await chmod(documentPath, 0o644);
  await writeFile(documentPath, 'tampered', 'utf8');
  await chmod(capabilityDir, 0o555);
  await chmod(first.rootPath, 0o555);

  const repaired = await materializeCapabilityDocumentWorkspace({
    registry,
    cacheRoot: join(root, 'cache'),
  });

  assert.equal(repaired.reused, false);
  assert.match(
    await readFile(join(repaired.rootPath, 'general', 'CAPABILITY.md'), 'utf8'),
    /name: "general"/,
  );
});

test('workspace replaces an invalid symlink without touching its target', async (t) => {
  const root = await temporaryDirectory(t, 'capability-workspace-symlink-');
  t.mock.method(console, 'warn', () => {});
  const registry = compileAgentRegistry({
    toolkits: [],
    capabilities: [capability({ name: 'general' })],
  });
  const first = await materializeCapabilityDocumentWorkspace({
    registry,
    cacheRoot: join(root, 'cache'),
  });
  const symlinkTarget = join(root, 'symlink-target');
  await mkdir(symlinkTarget);
  await writeFile(join(symlinkTarget, 'keep.txt'), 'keep', 'utf8');
  await rm(first.rootPath, { recursive: true, force: true });
  await symlink(symlinkTarget, first.rootPath);

  const repaired = await materializeCapabilityDocumentWorkspace({
    registry,
    cacheRoot: join(root, 'cache'),
  });

  assert.equal(repaired.reused, false);
  assert.equal((await lstat(repaired.rootPath)).isSymbolicLink(), false);
  assert.equal(await readFile(join(symlinkTarget, 'keep.txt'), 'utf8'), 'keep');
});

test('concurrent materialization publishes one complete snapshot', async (t) => {
  const root = await temporaryDirectory(t, 'capability-workspace-concurrent-');
  const registry = compileAgentRegistry({
    toolkits: [],
    capabilities: [
      capability({ name: 'general' }),
      capability({ name: 'explore' }),
    ],
  });

  const [left, right] = await Promise.all([
    materializeCapabilityDocumentWorkspace({
      registry,
      cacheRoot: join(root, 'cache'),
    }),
    materializeCapabilityDocumentWorkspace({
      registry,
      cacheRoot: join(root, 'cache'),
    }),
  ]);

  assert.equal(left.rootPath, right.rootPath);
  assert.equal(left.registryDigest, right.registryDigest);
  assert.equal(Number(left.reused) + Number(right.reused), 1);
  assert.match(
    await readFile(join(left.rootPath, 'general', 'CAPABILITY.md'), 'utf8'),
    /name: "general"/,
  );
  assert.match(
    await readFile(join(left.rootPath, 'explore', 'CAPABILITY.md'), 'utf8'),
    /name: "explore"/,
  );
});

test('concurrent repair publishes one complete replacement snapshot', async (t) => {
  const root = await temporaryDirectory(t, 'capability-workspace-concurrent-repair-');
  t.mock.method(console, 'warn', () => {});
  const registry = compileAgentRegistry({
    toolkits: [],
    capabilities: [
      capability({ name: 'general' }),
      capability({ name: 'explore' }),
    ],
  });
  const first = await materializeCapabilityDocumentWorkspace({
    registry,
    cacheRoot: join(root, 'cache'),
  });
  const documentPath = join(first.rootPath, 'general', 'CAPABILITY.md');
  await chmod(documentPath, 0o644);
  await writeFile(documentPath, 'tampered', 'utf8');

  const [left, right] = await Promise.all([
    materializeCapabilityDocumentWorkspace({
      registry,
      cacheRoot: join(root, 'cache'),
    }),
    materializeCapabilityDocumentWorkspace({
      registry,
      cacheRoot: join(root, 'cache'),
    }),
  ]);

  assert.equal(left.rootPath, right.rootPath);
  assert.equal(Number(left.reused) + Number(right.reused), 1);
  assert.match(
    await readFile(join(left.rootPath, 'general', 'CAPABILITY.md'), 'utf8'),
    /name: "general"/,
  );
  assert.match(
    await readFile(join(left.rootPath, 'explore', 'CAPABILITY.md'), 'utf8'),
    /name: "explore"/,
  );
});

test('repair revalidates the snapshot after acquiring the digest lock', async (t) => {
  const root = await temporaryDirectory(t, 'capability-workspace-repair-lock-');
  const warnings: unknown[][] = [];
  t.mock.method(console, 'warn', (...args: unknown[]) => {
    warnings.push(args);
  });
  const registry = compileAgentRegistry({
    toolkits: [],
    capabilities: [capability({ name: 'general' })],
  });
  const cacheRoot = join(root, 'cache');
  const first = await materializeCapabilityDocumentWorkspace({
    registry,
    cacheRoot,
  });
  const documentPath = join(first.rootPath, 'general', 'CAPABILITY.md');
  await chmod(documentPath, 0o644);
  await writeFile(documentPath, 'tampered', 'utf8');

  const repairLockPath = join(
    cacheRoot,
    `.repair-${first.registryDigest}.lock`,
  );
  await mkdir(repairLockPath);
  await writeFile(
    join(repairLockPath, 'owner.json'),
    JSON.stringify({ pid: process.pid, token: 'test-owner' }),
    'utf8',
  );
  const materialization = materializeCapabilityDocumentWorkspace({
    registry,
    cacheRoot,
  });
  await waitForDirectoryEntry(
    cacheRoot,
    (entry) => entry.startsWith(`.pending-repair-${first.registryDigest}-`),
  );
  await writeFile(
    documentPath,
    renderCapabilityDocument(registry.capabilities[0]!.capability),
    'utf8',
  );
  await rm(repairLockPath, { recursive: true, force: true });

  const reused = await materialization;
  assert.equal(reused.reused, true);
  assert.equal(warnings.length, 0);
  assert.deepEqual(
    (await readdir(cacheRoot)).filter((entry) => entry.startsWith('.invalid-')),
    [],
  );
});

test('workspace rejects duplicate allowed capability names', async (t) => {
  const root = await temporaryDirectory(t, 'capability-workspace-duplicates-');
  const registry = compileAgentRegistry({
    toolkits: [],
    capabilities: [capability({ name: 'general' })],
  });

  await assert.rejects(
    materializeCapabilityDocumentWorkspace({
      registry,
      cacheRoot: join(root, 'cache'),
      allowedCapabilityNames: ['general', 'general'],
    }),
    /allowedCapabilityNames must not contain duplicates/,
  );
});

test('workspace requires an absolute cache root', async () => {
  const registry = compileAgentRegistry({
    toolkits: [],
    capabilities: [capability({ name: 'general' })],
  });

  await assert.rejects(
    materializeCapabilityDocumentWorkspace({
      registry,
      cacheRoot: 'relative-cache',
    }),
    /cacheRoot must be absolute/,
  );
});
