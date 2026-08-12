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
import { ToolMessage } from '@langchain/core/messages';
import { isCommand } from '@langchain/langgraph';
import {
  defineCapability,
  defineInstructionDocument,
} from '../../../types/capability';
import {
  materializeCapabilityDocumentWorkspace,
  type CapabilityDocumentWorkspace,
} from './documentWorkspace';
import {
  CAPABILITY_PLANNER_GREP_SEARCH_TOOL_NAME,
  createCapabilityPlannerFileExplorer,
  type CapabilityPlannerFileExplorer,
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
  const content = typeof raw === 'string'
    ? raw
    : (() => {
        assert.ok(isCommand(raw));
        const update = raw.update as { messages?: unknown[] } | undefined;
        const message = update?.messages?.[0];
        assert.ok(message instanceof ToolMessage);
        assert.equal(typeof message.content, 'string');
        return message.content as string;
      })();
  return JSON.parse(content) as {
    ok: boolean;
    data?: Record<string, unknown>;
    error?: { code: string; message: string };
  };
}

test('Planner file explorer exposes one registry discovery tool', async (t) => {
  const { workspace } = await workspaceFixture(t);
  const explorer = createCapabilityPlannerFileExplorer({ workspace });

  assert.deepEqual(
    explorer.tools.map(({ name }) => name),
    [CAPABILITY_PLANNER_GREP_SEARCH_TOOL_NAME],
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
      matchedTerms: ['browser', 'research'],
    }],
  );
  const matches = first.data?.matches as Array<Record<string, unknown>>;
  assert.match(String(matches[0]?.content), /# Browser\n\nOpen and inspect web pages\./);
  assert.match(
    String(matches[1]?.content),
    /# Explore\n\nDo not use browser for repository research\./,
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

test('grep_search returns verified General fallback after a literal miss', async (t) => {
  const { workspace } = await workspaceFixture(t);
  const explorer = createCapabilityPlannerFileExplorer({ workspace });

  const result = await invoke(
    explorer,
    CAPABILITY_PLANNER_GREP_SEARCH_TOOL_NAME,
    { query: 'list files directory' },
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.data?.matches, []);
  const fallback = result.data?.fallback as Record<string, unknown>;
  assert.equal(fallback.capabilityName, 'general');
  assert.equal(fallback.path, 'general/CAPABILITY.md');
  assert.equal(fallback.reason, 'general_fallback');
  assert.match(String(fallback.content), /Handle ordinary local work/);
  assert.deepEqual(fallback.matchedTerms, []);
});

test('memory backend is explicit and preserves complete registry search results', async (t) => {
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
});

test('grep_search enforces compact queries without an active Planner graph', async (t) => {
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

test('grep_search rejects tampered documents when they are returned', async (t) => {
  const { workspace } = await workspaceFixture(t);
  const documentPath = join(workspace.rootPath, 'general', 'CAPABILITY.md');
  await chmod(documentPath, 0o644);
  await writeFile(documentPath, 'tampered', 'utf8');
  const explorer = createCapabilityPlannerFileExplorer({ workspace });

  const unaffectedSearch = await invoke(
    explorer,
    CAPABILITY_PLANNER_GREP_SEARCH_TOOL_NAME,
    { query: 'browser' },
  );
  assert.equal(unaffectedSearch.ok, true);
  assert.deepEqual(
    (unaffectedSearch.data?.matches as Array<Record<string, unknown>>).map(
      ({ path }) => path,
    ),
    ['browser/CAPABILITY.md', 'explore/CAPABILITY.md'],
  );

  const searchResult = await invoke(
    explorer,
    CAPABILITY_PLANNER_GREP_SEARCH_TOOL_NAME,
    { query: 'tampered' },
  );
  assert.equal(searchResult.ok, false);
  assert.equal(searchResult.error?.code, 'document_tampered');
});

test('grep_search rejects a symlink introduced after workspace publication', async (t) => {
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
    CAPABILITY_PLANNER_GREP_SEARCH_TOOL_NAME,
    { query: 'outside secret' },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'workspace_invalid');
  assert.doesNotMatch(JSON.stringify(result), /outside secret/);
});

test('grep_search never returns a partial Capability document', async (t) => {
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

  const result = await invoke(
    explorer,
    CAPABILITY_PLANNER_GREP_SEARCH_TOOL_NAME,
    { query: 'budget' },
  );
  assert.equal(result.ok, false);
  assert.equal(result.error?.code, 'planning_limit_reached');
  assert.equal(explorer.didReachDocumentReadLimit(), true);
  assert.doesNotMatch(JSON.stringify(result), /x{40}/);
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
