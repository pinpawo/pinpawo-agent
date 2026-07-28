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
  CAPABILITY_PLANNER_GLOB_SEARCH_TOOL_NAME,
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
      instructions: '# Browser\n\nInspect web pages in a browser.',
    }),
    capability({
      name: 'explore',
      instructions: '# Explore\n\nResearch sources and inspect evidence.',
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
    registryDigest: string;
    data?: Record<string, unknown>;
    error?: { code: string; message: string };
    observationBudget: {
      maxDocumentBytes: number;
      consumedDocumentBytes: number;
      remainingDocumentBytes: number;
      exhausted: boolean;
    };
  };
}

test('Planner file explorer exposes only private read tools and paginates filesystem discovery', async (t) => {
  const { workspace } = await workspaceFixture(t);
  const explorer = createCapabilityPlannerFileExplorer({ workspace });

  assert.deepEqual(
    explorer.tools.map(({ name }) => name),
    [
      CAPABILITY_PLANNER_GLOB_SEARCH_TOOL_NAME,
      CAPABILITY_PLANNER_GREP_SEARCH_TOOL_NAME,
      CAPABILITY_PLANNER_VIEW_FILE_CHUNK_TOOL_NAME,
    ],
  );
  assert.equal('uses' in explorer, false);

  const first = await invoke(
    explorer,
    CAPABILITY_PLANNER_GLOB_SEARCH_TOOL_NAME,
    { limit: 2 },
  );
  assert.equal(first.ok, true);
  assert.equal(first.registryDigest, workspace.registryDigest);
  assert.deepEqual(first.data?.paths, [
    'browser/CAPABILITY.md',
    'explore/CAPABILITY.md',
  ]);
  assert.equal(first.data?.nextCursor, 2);
  assert.equal(first.data?.complete, false);

  const second = await invoke(
    explorer,
    CAPABILITY_PLANNER_GLOB_SEARCH_TOOL_NAME,
    { cursor: 2 },
  );
  assert.deepEqual(second.data?.paths, ['general/CAPABILITY.md']);
  assert.equal(second.data?.nextCursor, null);
  assert.equal(second.data?.complete, true);
});

test('grep_search lets the model explore literal matches without relevance ranking', async (t) => {
  const { workspace } = await workspaceFixture(t);
  const explorer = createCapabilityPlannerFileExplorer({ workspace });

  const first = await invoke(
    explorer,
    CAPABILITY_PLANNER_GREP_SEARCH_TOOL_NAME,
    { query: 'INSPECT', limit: 1 },
  );
  assert.equal(first.ok, true);
  assert.deepEqual(
    (first.data?.matches as Array<Record<string, unknown>>).map(
      ({ path }) => path,
    ),
    ['browser/CAPABILITY.md'],
  );
  assert.equal(first.data?.nextCursor, 1);
  assert.equal(first.data?.complete, false);

  const second = await invoke(
    explorer,
    CAPABILITY_PLANNER_GREP_SEARCH_TOOL_NAME,
    { query: 'inspect', cursor: 1 },
  );
  assert.deepEqual(
    (second.data?.matches as Array<Record<string, unknown>>).map(
      ({ path }) => path,
    ),
    ['explore/CAPABILITY.md'],
  );
  assert.equal(second.data?.nextCursor, null);
  assert.equal(second.data?.complete, true);
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

  const result = await invoke(
    explorer,
    CAPABILITY_PLANNER_VIEW_FILE_CHUNK_TOOL_NAME,
    { path: 'general/CAPABILITY.md' },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'document_tampered');
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

test('document observation budget is shared across all Planner file tools', async (t) => {
  const { workspace } = await workspaceFixture(t, [
    capability({
      name: 'budget',
      instructions: `# budget\n\n${'x'.repeat(500)}`,
    }),
  ]);
  const explorer = createCapabilityPlannerFileExplorer({
    workspace,
    maxObservationBytes: 80,
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
  assert.equal(first.observationBudget.exhausted, true);
  assert.equal(explorer.getObservationBudget().consumedDocumentBytes, 80);

  const second = await invoke(
    explorer,
    CAPABILITY_PLANNER_GLOB_SEARCH_TOOL_NAME,
    {},
  );
  assert.equal(second.ok, false);
  assert.equal(second.error?.code, 'planning_limit_reached');
});

test('empty Capability workspace remains truthfully discoverable as empty', async (t) => {
  const { workspace } = await workspaceFixture(t, []);
  const explorer = createCapabilityPlannerFileExplorer({ workspace });

  const result = await invoke(
    explorer,
    CAPABILITY_PLANNER_GLOB_SEARCH_TOOL_NAME,
    {},
  );
  assert.equal(result.ok, true);
  assert.deepEqual(result.data?.paths, []);
  assert.equal(result.data?.complete, true);
});
