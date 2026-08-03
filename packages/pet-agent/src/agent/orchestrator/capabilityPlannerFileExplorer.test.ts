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
} from '../../types/capability';
import {
  materializeCapabilityDocumentWorkspace,
  type CapabilityDocumentWorkspace,
} from './capabilityDocumentWorkspace';
import {
  CAPABILITY_PLANNER_GREP_SEARCH_TOOL_NAME,
  CAPABILITY_PLANNER_VIEW_FILE_CHUNK_TOOL_NAME,
  createCapabilityPlannerFileExplorer,
  type CapabilityPlannerFileExplorer,
} from './capabilityPlannerFileExplorer';
import { compileAgentRegistry } from './registry';

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
  const root = await temporaryDirectory(t, 'capability-planner-files-');
  const workspace = await materializeCapabilityDocumentWorkspace({
    registry: compileAgentRegistry({
      toolkits: [],
      capabilities,
    }),
    cacheRoot: join(root, 'cache'),
  });
  return { root, workspace };
}

function plannerTool(
  explorer: CapabilityPlannerFileExplorer,
  name: string,
) {
  const selected = explorer.tools.find((candidate) => candidate.name === name);
  assert.ok(selected, `missing Planner file tool ${name}`);
  return selected;
}

async function invoke(
  explorer: CapabilityPlannerFileExplorer,
  name: string,
  input: Record<string, unknown>,
) {
  const raw = await plannerTool(explorer, name).invoke(input);
  assert.equal(typeof raw, 'string');
  return JSON.parse(raw) as {
    ok: boolean;
    data?: Record<string, unknown>;
    error?: { code: string; message: string };
  };
}

test('Planner file explorer exposes only candidate search and document reading', async (t) => {
  const { workspace } = await workspaceFixture(t);
  const explorer = createCapabilityPlannerFileExplorer({ workspace });

  assert.deepEqual(
    explorer.tools.map(({ name }) => name),
    [
      CAPABILITY_PLANNER_GREP_SEARCH_TOOL_NAME,
      CAPABILITY_PLANNER_VIEW_FILE_CHUNK_TOOL_NAME,
    ],
  );
  assert.equal('uses' in explorer, false);
});

test('grep_search finds candidates from immutable Workspace documents', async (t) => {
  const { workspace } = await workspaceFixture(t);
  const explorer = createCapabilityPlannerFileExplorer({ workspace });

  const first = await invoke(
    explorer,
    CAPABILITY_PLANNER_GREP_SEARCH_TOOL_NAME,
    { query: 'BROWSER|research' },
  );
  assert.equal(first.ok, true);
  assert.deepEqual(
    (first.data?.matches as Array<Record<string, unknown>>).map(
      ({ path, matchedTerms }) => ({ path, matchedTerms }),
    ),
    [{
      path: 'browser/CAPABILITY.md',
      matchedTerms: ['browser'],
    }, {
      path: 'explore/CAPABILITY.md',
      matchedTerms: ['research'],
    }],
  );
  assert.equal(first.data?.complete, true);
});

test('grep_search searches complete Capability documents', async (t) => {
  const { workspace } = await workspaceFixture(t);
  const explorer = createCapabilityPlannerFileExplorer({ workspace });

  const result = await invoke(
    explorer,
    CAPABILITY_PLANNER_GREP_SEARCH_TOOL_NAME,
    { query: 'browser' },
  );
  assert.deepEqual(
    (result.data?.matches as Array<Record<string, unknown>>).map(
      ({ path }) => path,
    ),
    ['browser/CAPABILITY.md', 'explore/CAPABILITY.md'],
  );
});

test('memory backend is explicit and preserves registry search/read semantics', async (t) => {
  const { workspace } = await workspaceFixture(t);
  const filesystem = createCapabilityPlannerFileExplorer({ workspace });
  const memory = createCapabilityPlannerFileExplorer({
    workspace,
    registryBackend: 'memory',
  });

  const filesystemSearch = await invoke(
    filesystem,
    CAPABILITY_PLANNER_GREP_SEARCH_TOOL_NAME,
    { query: 'browser|research' },
  );
  const memorySearch = await invoke(
    memory,
    CAPABILITY_PLANNER_GREP_SEARCH_TOOL_NAME,
    { query: 'browser|research' },
  );
  assert.deepEqual(memorySearch.data?.matches, filesystemSearch.data?.matches);

  const memoryDocument = await invoke(
    memory,
    CAPABILITY_PLANNER_VIEW_FILE_CHUNK_TOOL_NAME,
    { path: 'browser/CAPABILITY.md', startLine: 1, endLine: 4 },
  );
  assert.equal(memoryDocument.ok, true);
  assert.match(String(memoryDocument.data?.content), /description:.*browser/i);
});

test('grep_search enforces compact queries without owning Planner workflow state', async (t) => {
  const { workspace } = await workspaceFixture(t);
  const invalidExplorer = createCapabilityPlannerFileExplorer({ workspace });
  const invalid = await invoke(
    invalidExplorer,
    CAPABILITY_PLANNER_GREP_SEARCH_TOOL_NAME,
    { query: 'one|two|three|four' },
  );
  assert.equal(invalid.ok, false);
  assert.equal(invalid.error?.code, 'invalid_query');

  const explorer = createCapabilityPlannerFileExplorer({ workspace });
  const first = await invoke(
    explorer,
    CAPABILITY_PLANNER_GREP_SEARCH_TOOL_NAME,
    { query: 'browser' },
  );
  assert.equal(first.ok, true);
  const second = await invoke(
    explorer,
    CAPABILITY_PLANNER_GREP_SEARCH_TOOL_NAME,
    { query: 'browser' },
  );
  assert.equal(second.ok, true);
});

test('view_file_chunk returns stable line ranges and a continuation cursor', async (t) => {
  const { workspace } = await workspaceFixture(t);
  const explorer = createCapabilityPlannerFileExplorer({ workspace });

  const first = await invoke(
    explorer,
    CAPABILITY_PLANNER_VIEW_FILE_CHUNK_TOOL_NAME,
    {
      path: 'general/CAPABILITY.md',
      startLine: 1,
      endLine: 3,
    },
  );
  assert.equal(first.ok, true);
  assert.match(String(first.data?.content), /^1: ---\n2: name:/);
  assert.deepEqual(first.data?.range, {
    startLine: 1,
    endLine: 3,
    totalLines: 11,
  });
  assert.equal(first.data?.nextStartLine, 4);
  assert.equal(first.data?.complete, false);

  const second = await invoke(
    explorer,
    CAPABILITY_PLANNER_VIEW_FILE_CHUNK_TOOL_NAME,
    {
      path: 'general/CAPABILITY.md',
      startLine: 4,
      endLine: 100,
    },
  );
  assert.equal(second.data?.nextStartLine, null);
  assert.equal(second.data?.complete, true);
  assert.match(String(second.data?.content), /Handle ordinary local work\./);
});

test('Planner file tools reject paths outside the materialized generation', async (t) => {
  const { workspace } = await workspaceFixture(t);
  const explorer = createCapabilityPlannerFileExplorer({ workspace });

  const traversal = await invoke(
    explorer,
    CAPABILITY_PLANNER_VIEW_FILE_CHUNK_TOOL_NAME,
    { path: '../outside/CAPABILITY.md' },
  );
  assert.equal(traversal.ok, false);
  assert.equal(traversal.error?.code, 'invalid_path');

  const missing = await invoke(
    explorer,
    CAPABILITY_PLANNER_VIEW_FILE_CHUNK_TOOL_NAME,
    { path: 'missing/CAPABILITY.md' },
  );
  assert.equal(missing.ok, false);
  assert.equal(missing.error?.code, 'document_not_found');
});

test('Planner file tools reject document tampering after workspace publication', async (t) => {
  const { workspace } = await workspaceFixture(t);
  const documentPath = join(workspace.rootPath, 'general', 'CAPABILITY.md');
  await chmod(documentPath, 0o644);
  await writeFile(documentPath, 'tampered', 'utf8');
  const explorer = createCapabilityPlannerFileExplorer({ workspace });

  const searchResult = await invoke(
    explorer,
    CAPABILITY_PLANNER_GREP_SEARCH_TOOL_NAME,
    { query: 'general' },
  );
  assert.equal(searchResult.ok, false);
  assert.equal(searchResult.error?.code, 'document_tampered');

  const viewResult = await invoke(
    explorer,
    CAPABILITY_PLANNER_VIEW_FILE_CHUNK_TOOL_NAME,
    { path: 'general/CAPABILITY.md' },
  );
  assert.equal(viewResult.ok, false);
  assert.equal(viewResult.error?.code, 'document_tampered');
});

test('Planner file tools reject a symlink introduced after workspace publication', async (t) => {
  const { root, workspace } = await workspaceFixture(t);
  const capabilityDir = join(workspace.rootPath, 'general');
  const documentPath = join(capabilityDir, 'CAPABILITY.md');
  const outsidePath = join(root, 'outside.md');
  await writeFile(outsidePath, 'outside secret', 'utf8');
  await chmod(capabilityDir, 0o755);
  await rm(documentPath);
  await symlink(outsidePath, documentPath);
  const explorer = createCapabilityPlannerFileExplorer({ workspace });

  const result = await invoke(
    explorer,
    CAPABILITY_PLANNER_VIEW_FILE_CHUNK_TOOL_NAME,
    { path: 'general/CAPABILITY.md' },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'workspace_invalid');
  assert.doesNotMatch(JSON.stringify(result), /outside secret/);
});

test('document read limit applies only to document contents', async (t) => {
  const { workspace } = await workspaceFixture(t, [
    capability({
      name: 'budget',
      instructions: `# budget\n\n${'x'.repeat(500)}`,
    }),
  ]);
  const explorer = createCapabilityPlannerFileExplorer({
    workspace,
    maxDocumentReadBytes: 80,
  });

  const first = await invoke(
    explorer,
    CAPABILITY_PLANNER_VIEW_FILE_CHUNK_TOOL_NAME,
    {
      path: 'budget/CAPABILITY.md',
      startLine: 10,
      endLine: 10,
    },
  );
  assert.equal(first.ok, true);
  assert.equal(first.data?.stoppedBy, 'line_too_long');

  const second = await invoke(
    explorer,
    CAPABILITY_PLANNER_GREP_SEARCH_TOOL_NAME,
    { query: 'budget' },
  );
  assert.equal(second.ok, true);
  assert.deepEqual(
    (second.data?.matches as Array<Record<string, unknown>>).map(({ path }) => path),
    ['budget/CAPABILITY.md'],
  );

  const third = await invoke(
    explorer,
    CAPABILITY_PLANNER_VIEW_FILE_CHUNK_TOOL_NAME,
    { path: 'budget/CAPABILITY.md' },
  );
  assert.equal(third.ok, false);
  assert.equal(third.error?.code, 'planning_limit_reached');
  assert.equal(explorer.didReachDocumentReadLimit(), true);
  assert.doesNotMatch(JSON.stringify(second), /registryDigest|observationBudget/);
});

test('grep_search returns no candidates for an empty Capability workspace', async (t) => {
  const { workspace } = await workspaceFixture(t, []);
  const explorer = createCapabilityPlannerFileExplorer({ workspace });

  const result = await invoke(
    explorer,
    CAPABILITY_PLANNER_GREP_SEARCH_TOOL_NAME,
    { query: 'general' },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.data?.matches, []);
  assert.equal(result.data?.complete, true);
});
