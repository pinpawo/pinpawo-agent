import assert from 'node:assert/strict';
import {
  chmod,
  lstat,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import {
  defineCapability,
  defineInstructionDocument,
} from '../../../types/capability';
import {
  materializeCapabilityDocumentWorkspace,
  type CapabilityDocumentWorkspace,
} from './documentWorkspace';
import {
  createRunSupervisorFileExplorer,
  createRunSupervisorSearchTool,
  type RunSupervisorFileExplorer,
} from './fileExplorer';
import { compileAgentRegistry } from '../registry';

async function makeWritable(path: string): Promise<void> {
  let stats;
  try {
    stats = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    await chmod(path, 0o644);
    return;
  }
  await chmod(path, 0o755);
  const entries = await readdir(path);
  await Promise.all(entries.map((entry) => makeWritable(join(path, entry))));
}

async function temporaryDirectory(t: TestContext, prefix: string) {
  const path = await mkdtemp(join(tmpdir(), prefix));
  t.after(async () => {
    await makeWritable(path);
    await rm(path, { recursive: true, force: true });
  });
  return path;
}

function capability(params: {
  name: string;
  description?: string;
  instructions?: string;
}) {
  return defineCapability({
    name: params.name,
    description: params.description ?? `${params.name} capability`,
    uses: [],
    instructions: defineInstructionDocument({
      content: params.instructions ?? `# ${params.name}\n\nExecute ${params.name}.`,
    }),
  });
}

async function workspaceFixture(
  t: TestContext,
  capabilities = [
    capability({
      name: 'general',
      instructions: '# General\n\nHandle ordinary local work.',
    }),
    capability({
      name: 'browser',
      description: 'Use a browser to inspect web pages.',
      instructions: '# Browser\n\nOpen and inspect web pages.',
    }),
    capability({
      name: 'explore',
      description: 'Research sources and inspect evidence.',
      instructions: '# Explore\n\nDo not use browser for repository research.',
    }),
  ],
) {
  const root = await temporaryDirectory(t, 'run-supervisor-files-');
  const workspace = await materializeCapabilityDocumentWorkspace({
    registry: compileAgentRegistry({
      toolkits: [],
      capabilities,
    }),
    cacheRoot: join(root, 'cache'),
  });
  return { root, workspace };
}

async function search(
  explorer: RunSupervisorFileExplorer,
  terms: readonly string[],
) {
  return explorer.search(terms);
}

test('Supervisor file explorer exposes a typed registry discovery service', async (t) => {
  const { workspace } = await workspaceFixture(t);
  const explorer = createRunSupervisorFileExplorer({ workspace });

  assert.equal(typeof explorer.search, 'function');
  assert.equal('tools' in explorer, false);
  assert.equal('uses' in explorer, false);
});

test('capability_search finds candidates from immutable Workspace documents', async (t) => {
  const { workspace } = await workspaceFixture(t);
  const explorer = createRunSupervisorFileExplorer({ workspace });

  const first = await search(explorer, ['BROWSER', 'research']);
  assert.equal(first.ok, true);
  if (!first.ok) assert.fail('expected capability search to succeed');
  assert.deepEqual(
    first.data.matches.map(
      ({ path, matchedTerms }) => ({ path, matchedTerms }),
    ),
    [{
      path: 'browser/CAPABILITY.md',
      matchedTerms: ['browser'],
    }, {
      path: 'explore/CAPABILITY.md',
      matchedTerms: ['browser', 'research'],
    }],
  );
  const matches = first.data.matches;
  assert.match(String(matches[0]?.content), /# Browser\n\nOpen and inspect web pages\./);
  assert.match(
    String(matches[1]?.content),
    /# Explore\n\nDo not use browser for repository research\./,
  );
  assert.equal(first.data.complete, true);
});

test('capability_search searches complete Capability documents', async (t) => {
  const { workspace } = await workspaceFixture(t);
  const explorer = createRunSupervisorFileExplorer({ workspace });

  const result = await search(explorer, ['browser']);
  if (!result.ok) assert.fail('expected capability search to succeed');
  assert.deepEqual(
    result.data.matches.map(({ path }) => path),
    ['browser/CAPABILITY.md', 'explore/CAPABILITY.md'],
  );
});

test('Supervisor reads every disclosed Capability in stable order', async (t) => {
  const { workspace } = await workspaceFixture(t);
  const explorer = createRunSupervisorFileExplorer({ workspace });

  const documents = await explorer.readCapabilities(['general', 'browser']);

  assert.deepEqual(documents.map(({ capabilityName }) => capabilityName), [
    'general',
    'browser',
  ]);
  assert.equal(documents[0]?.path, 'general/CAPABILITY.md');
  assert.match(documents[0]?.content ?? '', /Handle ordinary local work/);
  assert.match(documents[1]?.content ?? '', /Open and inspect web pages/);
});

test('Supervisor can preload a configured default Capability instead of General', async (t) => {
  const { workspace } = await workspaceFixture(t);
  const explorer = createRunSupervisorFileExplorer({
    workspace,
    defaultCapabilityName: 'explore',
  });

  const [defaultCapability] = await explorer.readCapabilities(['explore']);
  const generalSearch = await explorer.search(['ordinary local work']);
  const exploreSearch = await explorer.search(['repository research']);

  assert.equal(defaultCapability?.capabilityName, 'explore');
  assert.equal(defaultCapability?.path, 'explore/CAPABILITY.md');
  assert.match(defaultCapability?.content ?? '', /repository research/);
  assert.equal(generalSearch.ok, true);
  if (generalSearch.ok) {
    assert.deepEqual(
      generalSearch.data.matches.map(({ path }) => path),
      ['general/CAPABILITY.md'],
    );
  }
  assert.equal(exploreSearch.ok, true);
  if (exploreSearch.ok) assert.deepEqual(exploreSearch.data.matches, []);
});

test('capability_search excludes the preloaded General Capability', async (t) => {
  const { workspace } = await workspaceFixture(t);
  const explorer = createRunSupervisorFileExplorer({ workspace });

  const result = await explorer.search(['ordinary local work']);

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.data.matches, []);
});

test('capability_search remains pure discovery after a literal miss', async (t) => {
  const { workspace } = await workspaceFixture(t);
  const explorer = createRunSupervisorFileExplorer({ workspace });

  const result = await search(explorer, ['list files directory']);

  assert.equal(result.ok, true);
  if (!result.ok) assert.fail('expected capability search to succeed');
  assert.deepEqual(result.data.matches, []);
  assert.equal('fallback' in result.data, false);
});

test('memory backend is explicit and preserves complete registry search results', async (t) => {
  const { workspace } = await workspaceFixture(t);
  const filesystem = createRunSupervisorFileExplorer({ workspace });
  const memory = createRunSupervisorFileExplorer({
    workspace,
    registryBackend: 'memory',
  });

  const filesystemSearch = await search(filesystem, ['browser', 'research']);
  const memorySearch = await search(memory, ['browser', 'research']);
  if (!filesystemSearch.ok) assert.fail(filesystemSearch.error.message);
  if (!memorySearch.ok) assert.fail(memorySearch.error.message);
  assert.deepEqual(memorySearch.data.matches, filesystemSearch.data.matches);
});

test('capability_search bounds literal terms without an active Supervisor graph', async (t) => {
  const { workspace } = await workspaceFixture(t);
  const searchTool = createRunSupervisorSearchTool(
    async () => JSON.stringify({ ok: true }),
  );
  // The term count is unbounded: per-term shape is what keeps a search literal.
  assert.ok(await searchTool.invoke({ terms: ['one', 'two', 'three', 'four'] }));
  assert.ok(await searchTool.invoke({
    terms: ['failing test root cause analysis'],
  }));
  await assert.rejects(searchTool.invoke({
    terms: ['x'.repeat(81)],
  }), /String must contain at most 80 character/);

  const explorer = createRunSupervisorFileExplorer({ workspace });
  const first = await search(explorer, ['browser']);
  assert.equal(first.ok, true);
  const second = await search(explorer, ['browser']);
  assert.equal(second.ok, true);
});

test('Supervisor document reads reject tampered workspace content', async (t) => {
  const { workspace } = await workspaceFixture(t);
  const documentPath = join(workspace.rootPath, 'general', 'CAPABILITY.md');
  await chmod(documentPath, 0o644);
  await writeFile(documentPath, 'tampered', 'utf8');
  const explorer = createRunSupervisorFileExplorer({ workspace });

  await assert.rejects(
    explorer.readCapabilities(['general']),
    { code: 'document_tampered' },
  );

  const unaffectedSearch = await search(explorer, ['browser']);
  assert.equal(unaffectedSearch.ok, true);
  if (!unaffectedSearch.ok) assert.fail('expected capability search to succeed');
  assert.deepEqual(
    unaffectedSearch.data.matches.map(({ path }) => path),
    ['browser/CAPABILITY.md', 'explore/CAPABILITY.md'],
  );

  const searchResult = await search(explorer, ['tampered']);
  assert.equal(searchResult.ok, true);
  if (!searchResult.ok) return;
  assert.deepEqual(searchResult.data.matches, []);
});

test('capability_search rejects a symlink introduced after workspace publication', async (t) => {
  const { root, workspace } = await workspaceFixture(t);
  const capabilityDir = join(workspace.rootPath, 'browser');
  const documentPath = join(capabilityDir, 'CAPABILITY.md');
  const outsidePath = join(root, 'outside.md');
  await writeFile(outsidePath, 'outside secret', 'utf8');
  await chmod(capabilityDir, 0o755);
  await rm(documentPath);
  await symlink(outsidePath, documentPath);
  const explorer = createRunSupervisorFileExplorer({ workspace });

  const result = await search(explorer, ['outside secret']);
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'workspace_invalid');
  assert.doesNotMatch(JSON.stringify(result), /outside secret/);
});

test('capability_search never returns a partial Capability document', async (t) => {
  const { workspace } = await workspaceFixture(t, [
    capability({
      name: 'budget',
      instructions: `# budget\n\n${'x'.repeat(500)}`,
    }),
  ]);
  const explorer = createRunSupervisorFileExplorer({
    workspace,
    maxDocumentReadBytes: 80,
  });

  const result = await search(explorer, ['budget']);
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'supervisor_discovery_limit_reached');
  assert.equal(explorer.didReachDocumentReadLimit(), true);
  assert.doesNotMatch(JSON.stringify(result), /x{40}/);
});

test('capability_search returns no candidates for an empty Capability workspace', async (t) => {
  const { workspace } = await workspaceFixture(t, []);
  const explorer = createRunSupervisorFileExplorer({ workspace });

  const result = await search(explorer, ['general']);
  assert.equal(result.ok, true);
  assert.deepEqual(result.data?.matches, []);
  assert.equal(result.data?.complete, true);
  assert.deepEqual(await explorer.readCapabilities([]), []);
});
