import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { handleLocalHttpRequest } from './localHttpHandlers';
import {
  createLocalServerRuntimeDepsStore,
  type LocalServerDeps,
} from './localServerTypes';
import type { LoadedUserCapability } from './capabilityLoader';
import { clearAgentRunActivity, recordOperationActivity } from './operationActivityState';

function makeReq(url: string, authorization?: string): IncomingMessage {
  return {
    url,
    headers: {
      host: '127.0.0.1:3210',
      ...(authorization ? { authorization } : {}),
    },
  } as IncomingMessage;
}

function makeRes() {
  const res = {
    statusCode: 0,
    body: '',
    headers: undefined as unknown,
    done: Promise.resolve(),
    writeHead(statusCode: number, headers: unknown) {
      res.statusCode = statusCode;
      res.headers = headers;
      return res;
    },
    end(body?: unknown) {
      res.body = typeof body === 'string' ? body : '';
    },
  };
  return res as unknown as ServerResponse & typeof res;
}

test('handleLocalHttpRequest serves TUI sessions list and resume endpoints', async () => {
  const deps = {} as LocalServerDeps;
  const listRes = makeRes();

  assert.equal(handleLocalHttpRequest(makeReq('/sessions', 'Bearer secret'), listRes, deps, {
    authToken: 'secret',
    loadSnapshot: async () => ({}),
    listSessions: async () => [{
      id: 'pet-a:one',
      title: 'first',
      messageCount: 2,
      createdAt: '2026-06-01T01:00:00.000Z',
      updatedAt: '2026-06-01T01:01:00.000Z',
      active: true,
    }],
    resumeSession: async () => {
      throw new Error('not called');
    },
  }), true);

  await Promise.resolve();
  assert.equal(listRes.statusCode, 200);
  assert.deepEqual(JSON.parse(listRes.body), {
    sessions: [{
      id: 'pet-a:one',
      title: 'first',
      messageCount: 2,
      createdAt: '2026-06-01T01:00:00.000Z',
      updatedAt: '2026-06-01T01:01:00.000Z',
      active: true,
    }],
  });

  const resumeRes = makeRes();
  assert.equal(handleLocalHttpRequest(makeReq('/sessions/resume?sessionId=pet-a%3Aone', 'Bearer secret'), resumeRes, deps, {
    authToken: 'secret',
    loadSnapshot: async () => ({}),
    listSessions: async () => [],
    resumeSession: async (sessionId) => ({
      session: { id: sessionId, title: 'first' },
      snapshot: { version: 3 },
    }),
  }), true);

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(resumeRes.statusCode, 200);
  assert.deepEqual(JSON.parse(resumeRes.body), {
    session: { id: 'pet-a:one', title: 'first' },
    snapshot: { version: 3 },
  });
});

test('handleLocalHttpRequest reports an active-run resume conflict', async () => {
  const res = makeRes();
  handleLocalHttpRequest(
    makeReq('/sessions/resume?sessionId=pet-a%3Aone', 'Bearer secret'),
    res,
    {} as LocalServerDeps,
    {
      authToken: 'secret',
      loadSnapshot: async () => ({}),
      listSessions: async () => [],
      resumeSession: async () => {
        throw Object.assign(new Error('cannot resume a session while a run is active'), {
          code: 'session_resume_conflict',
        });
      },
    },
  );

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(res.statusCode, 409);
  assert.deepEqual(JSON.parse(res.body), {
    error: 'cannot resume a session while a run is active',
  });
});

test('handleLocalHttpRequest serves TUI snapshot endpoint', async () => {
  const deps = {} as LocalServerDeps;
  const snapshotRes = makeRes();

  assert.equal(handleLocalHttpRequest(makeReq('/snapshot', 'Bearer secret'), snapshotRes, deps, {
    authToken: 'secret',
    loadSnapshot: async () => ({
      version: 3,
      session: {
        sessionId: 'chat:pet-a',
        kind: 'chat',
        timeline: [{
          id: 'message:0:user',
          type: 'message',
          role: 'user',
          text: 'hello',
          status: 'completed',
        }],
        activeRun: null,
      },
    }),
    listSessions: async () => [],
    resumeSession: async () => {
      throw new Error('not called');
    },
  }), true);

  await Promise.resolve();
  assert.equal(snapshotRes.statusCode, 200);
  assert.deepEqual(JSON.parse(snapshotRes.body), {
    version: 3,
    session: {
      sessionId: 'chat:pet-a',
      kind: 'chat',
      timeline: [{
        id: 'message:0:user',
        type: 'message',
        role: 'user',
        text: 'hello',
        status: 'completed',
      }],
      activeRun: null,
    },
  });
});

test('handleLocalHttpRequest does not expose the removed history endpoint', () => {
  const res = makeRes();
  assert.equal(handleLocalHttpRequest(makeReq('/history', 'Bearer secret'), res, {} as LocalServerDeps, {
    authToken: 'secret',
    loadSnapshot: async () => ({}),
    listSessions: async () => [],
    resumeSession: async () => {
      throw new Error('not called');
    },
  }), false);
});

test('handleLocalHttpRequest rejects requests without a valid local token', async () => {
  const deps = {} as LocalServerDeps;
  const options = {
    authToken: 'secret',
    loadSnapshot: async () => {
      throw new Error('not called');
    },
    listSessions: async () => {
      throw new Error('not called');
    },
    resumeSession: async () => {
      throw new Error('not called');
    },
  };

  const missingRes = makeRes();
  assert.equal(handleLocalHttpRequest(makeReq('/health'), missingRes, deps, options), true);
  assert.equal(missingRes.statusCode, 401);
  assert.deepEqual(JSON.parse(missingRes.body), { error: 'unauthorized' });

  const wrongRes = makeRes();
  assert.equal(handleLocalHttpRequest(makeReq('/health', 'Bearer wrong'), wrongRes, deps, options), true);
  assert.equal(wrongRes.statusCode, 401);

  const okRes = makeRes();
  assert.equal(handleLocalHttpRequest(makeReq('/health', 'Bearer secret'), okRes, {
    actorId: 'pet-a',
  } as LocalServerDeps, options), true);
  assert.equal(okRes.statusCode, 200);
});

test('handleLocalHttpRequest exposes active operation health fields', async () => {
  clearAgentRunActivity();
  recordOperationActivity({
    type: 'operation',
    requestId: 'req-1',
    phase: 'started',
    operation: {
      kind: 'bash.read_file',
      title: '读文件',
      target: 'README.md',
      summary: 'read',
    },
  });

  const res = makeRes();
  assert.equal(handleLocalHttpRequest(makeReq('/health', 'Bearer secret'), res, {
    actorId: 'pet-a',
    actorName: '羊',
  } as LocalServerDeps, {
    authToken: 'secret',
    loadSnapshot: async () => ({}),
    listSessions: async () => [],
    resumeSession: async () => {
      throw new Error('not called');
    },
  }), true);

  assert.equal(res.statusCode, 200);
  const payload = JSON.parse(res.body);
  assert.equal(payload.active_operation_kind, 'bash.read_file');
  assert.equal(payload.active_operation_title, '读文件');
  assert.equal(payload.active_operation_target, 'README.md');
  assert.equal(payload.active_operation_summary, 'read');
  assert.equal(payload.active_operation_phase, 'started');
  assert.equal(payload.agent_run_phase, 'using_tool');

  clearAgentRunActivity('req-1');
});

test('capability rescan replaces frozen runtime capability snapshots', async () => {
  const definition = {
    meta: {
      id: 'custom-test',
      name: 'Custom Test',
      description: 'test capability',
      icon: 'test',
      color: 'gray',
      defaultEnabled: true,
      builtIn: false,
    },
    capability: { name: 'custom-test' },
  } as LoadedUserCapability;
  const runtimeDeps = createLocalServerRuntimeDepsStore({
    actorId: 'pet-a',
    llmConfig: {
      apiKey: 'test',
      baseUrl: 'http://localhost',
      model: 'test-model',
    },
    workdir: '/tmp/pinpawo-capability-rescan',
    userCapabilityDefinitions: [],
    userCapabilities: [],
    rescanUserCapabilities: async () => ({
      userCapabilityDefinitions: [definition],
      userCapabilities: [definition],
    }),
  });
  const before = runtimeDeps.get();
  const res = makeRes();

  assert.equal(handleLocalHttpRequest(
    makeReq('/capabilities/rescan', 'Bearer secret'),
    res,
    before,
    {
      authToken: 'secret',
      loadSnapshot: async () => ({}),
      listSessions: async () => [],
      resumeSession: async () => {
        throw new Error('not called');
      },
      updateCapabilities: (patch) => runtimeDeps.updateCapabilities(patch),
    },
  ), true);

  await new Promise((resolve) => setTimeout(resolve, 0));
  const after = runtimeDeps.get();
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).status, 'ok');
  assert.equal(JSON.parse(res.body).loaded, 1);
  assert.notEqual(after, before);
  assert.deepEqual(before.userCapabilities, []);
  assert.equal(after.userCapabilities?.[0], definition);
  assert.equal(Object.isFrozen(after.userCapabilities), true);
});

test('Toolkit refresh updates frozen runtime lists with copy-on-write', async () => {
  const toolkit = {
    name: 'dynamic-test',
    availability: () => ({ available: true as const }),
  } as NonNullable<LocalServerDeps['localToolkits']>[number];
  const runtimeDeps = createLocalServerRuntimeDepsStore({
    actorId: 'pet-a',
    llmConfig: {
      apiKey: 'test',
      baseUrl: 'http://localhost',
      model: 'test-model',
    },
    workdir: '/tmp/pinpawo-capability-refresh',
    localToolkitDefinitions: [toolkit],
    localToolkits: [],
  });
  const before = runtimeDeps.get();
  const res = makeRes();

  handleLocalHttpRequest(
    makeReq('/health?refresh_toolkit=dynamic-test', 'Bearer secret'),
    res,
    before,
    {
      authToken: 'secret',
      loadSnapshot: async () => ({}),
      listSessions: async () => [],
      resumeSession: async () => {
        throw new Error('not called');
      },
      updateCapabilities: (patch) => runtimeDeps.updateCapabilities(patch),
    },
  );

  await new Promise((resolve) => setTimeout(resolve, 0));
  const after = runtimeDeps.get();
  assert.equal(res.statusCode, 200);
  assert.deepEqual(before.localToolkits, []);
  assert.equal(after.localToolkits?.[0], toolkit);
  assert.equal(Object.isFrozen(after.localToolkits), true);
});

test('handleLocalHttpRequest exposes canonical workdir Studio paths on runtime endpoint', async () => {
  const workdir = await fs.mkdtemp(join(tmpdir(), 'pinpawo-runtime-'));
  const stateRoot = join(workdir, '.pinpawo');
  const studioConfigPath = join(stateRoot, 'studio.json');
  await fs.mkdir(stateRoot, { recursive: true });
  await fs.writeFile(studioConfigPath, '{}', 'utf8');

  const res = makeRes();
  assert.equal(handleLocalHttpRequest(makeReq('/runtime', 'Bearer secret'), res, {
    actorId: 'pet-a',
    llmConfig: {
      model: 'test-model',
      contextWindowTokens: 32000,
    },
    workdir: `${workdir}-legacy`,
    runtimeConfig: {
      workdir,
      workspace: {
        id: 'workspace-test',
        name: 'Runtime Test',
        rootPath: workdir,
      },
      stateRoot,
      studioConfigPath,
      studioDueRunsPath: join(stateRoot, 'studio-due-runs.json'),
      petsDir: join(stateRoot, 'pets'),
      studioWikiBaseDir: join(stateRoot, 'studio-wiki'),
      checkpointPath: join(stateRoot, 'checkpoints.json'),
      tuiCheckpointPath: join(stateRoot, 'checkpoints-tui.json'),
      tuiSessionPath: join(stateRoot, 'tui-sessions.json'),
      capabilityArtifactRoot: join(stateRoot, 'capability-artifacts'),
    },
  } as LocalServerDeps, {
    authToken: 'secret',
    loadSnapshot: async () => ({}),
    listSessions: async () => [],
    resumeSession: async () => {
      throw new Error('not called');
    },
  }), true);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), {
    llm_model: 'test-model',
    llm_context_window_tokens: 32000,
    workdir,
    workspace_id: 'workspace-test',
    workspace_name: 'Runtime Test',
    workspace_root: workdir,
    state_root: stateRoot,
    studio_config_path: studioConfigPath,
    studio_due_runs_path: join(stateRoot, 'studio-due-runs.json'),
    pets_dir: join(stateRoot, 'pets'),
    studio_wiki_base_dir: join(stateRoot, 'studio-wiki'),
  });
});

test('handleLocalHttpRequest serves studio due-runs trace when scheduler is available', async () => {
  const workdir = await fs.mkdtemp(join(tmpdir(), 'pinpawo-runtime-'));
  const stateRoot = join(workdir, '.pinpawo');
  const trace = [{
    runId: 'run-1',
    conversationId: 'conv-1',
    idempotencyKey: 'studio:conv-1:run:run-1',
    status: 'success',
    attempt: 1,
    ownerUserId: null,
    finalPetRunId: 'pet-run-1',
  } as const];

  const res = makeRes();
  assert.equal(handleLocalHttpRequest(makeReq('/studio_due_runs', 'Bearer secret'), res, {
    actorId: 'pet-a',
    llmConfig: {
      model: 'test-model',
      contextWindowTokens: 32000,
    },
    workdir,
    runtimeConfig: {
      workdir,
      stateRoot,
      studioConfigPath: join(stateRoot, 'studio.json'),
      studioDueRunsPath: join(stateRoot, 'studio-due-runs.json'),
      petsDir: join(stateRoot, 'pets'),
      studioWikiBaseDir: join(stateRoot, 'studio-wiki'),
      checkpointPath: join(stateRoot, 'checkpoints.json'),
      tuiCheckpointPath: join(stateRoot, 'checkpoints-tui.json'),
      tuiSessionPath: join(stateRoot, 'tui-sessions.json'),
      capabilityArtifactRoot: join(stateRoot, 'capability-artifacts'),
    },
    studioDueRunScheduler: {
      trace: async () => trace,
    } as unknown as LocalServerDeps['studioDueRunScheduler'],
  } as LocalServerDeps, {
    authToken: 'secret',
    loadSnapshot: async () => ({}),
    listSessions: async () => [],
    resumeSession: async () => {
      throw new Error('not called');
    },
  }), true);

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), {
    workdir,
    studio_due_runs_path: join(stateRoot, 'studio-due-runs.json'),
    studio_due_runs: trace,
  });
});

test('handleLocalHttpRequest filters studio due-runs trace by status and limit', async () => {
  const workdir = await fs.mkdtemp(join(tmpdir(), 'pinpawo-runtime-'));
  const stateRoot = join(workdir, '.pinpawo');
  const trace = [
    {
      runId: 'run-1',
      conversationId: 'conv-1',
      idempotencyKey: 'studio:conv-1:run:run-1',
      status: 'pending',
      attempt: 1,
      ownerUserId: null,
      finalPetRunId: 'pet-run-1',
      workdir,
    },
    {
      runId: 'run-2',
      conversationId: 'conv-2',
      idempotencyKey: 'studio:conv-2:run:run-2',
      status: 'success',
      attempt: 2,
      ownerUserId: null,
      finalPetRunId: 'pet-run-2',
      workdir,
    },
    {
      runId: 'run-3',
      conversationId: 'conv-3',
      idempotencyKey: 'studio:conv-3:run:run-3',
      status: 'failed',
      attempt: 1,
      ownerUserId: null,
      finalPetRunId: 'pet-run-3',
      workdir,
    },
  ] as const;

  const filtered = [
    {
      runId: 'run-2',
      conversationId: 'conv-2',
      idempotencyKey: 'studio:conv-2:run:run-2',
      status: 'success',
      attempt: 2,
      ownerUserId: null,
      finalPetRunId: 'pet-run-2',
      workdir,
    },
  ];

  const res = makeRes();
  assert.equal(handleLocalHttpRequest(makeReq('/studio_due_runs?status=success&limit=2', 'Bearer secret'), res, {
    actorId: 'pet-a',
    llmConfig: {
      model: 'test-model',
      contextWindowTokens: 32000,
    },
    workdir,
    runtimeConfig: {
      workdir,
      stateRoot,
      studioConfigPath: join(stateRoot, 'studio.json'),
      studioDueRunsPath: join(stateRoot, 'studio-due-runs.json'),
      petsDir: join(stateRoot, 'pets'),
      studioWikiBaseDir: join(stateRoot, 'studio-wiki'),
      checkpointPath: join(stateRoot, 'checkpoints.json'),
      tuiCheckpointPath: join(stateRoot, 'checkpoints-tui.json'),
      tuiSessionPath: join(stateRoot, 'tui-sessions.json'),
      capabilityArtifactRoot: join(stateRoot, 'capability-artifacts'),
    },
    studioDueRunScheduler: {
      trace: async () => trace,
    } as unknown as LocalServerDeps['studioDueRunScheduler'],
  } as LocalServerDeps, {
    authToken: 'secret',
    loadSnapshot: async () => ({}),
    listSessions: async () => [],
    resumeSession: async () => {
      throw new Error('not called');
    },
  }), true);

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), {
    workdir,
    studio_due_runs_path: join(stateRoot, 'studio-due-runs.json'),
    studio_due_runs: filtered,
  });
});

test('handleLocalHttpRequest rejects invalid studio_due_runs limit', async () => {
  const res = makeRes();
  assert.equal(handleLocalHttpRequest(makeReq('/studio_due_runs?limit=xx', 'Bearer secret'), res, {
    actorId: 'pet-a',
    llmConfig: {
      model: 'test-model',
      contextWindowTokens: 32000,
    },
    workdir: '/tmp/workspace',
    runtimeConfig: {
      workdir: '/tmp/workspace',
      stateRoot: '/tmp/workspace/.pinpawo',
      studioConfigPath: '/tmp/workspace/.pinpawo/studio.json',
      studioDueRunsPath: '/tmp/workspace/.pinpawo/studio-due-runs.json',
      petsDir: '/tmp/workspace/.pinpawo/pets',
      studioWikiBaseDir: '/tmp/workspace/.pinpawo/studio-wiki',
      checkpointPath: '/tmp/workspace/.pinpawo/checkpoints.json',
      tuiCheckpointPath: '/tmp/workspace/.pinpawo/checkpoints-tui.json',
      tuiSessionPath: '/tmp/workspace/.pinpawo/tui-sessions.json',
      capabilityArtifactRoot: '/tmp/workspace/.pinpawo/capability-artifacts',
    },
    studioDueRunScheduler: {
      trace: async () => [] as const,
    } as unknown as LocalServerDeps['studioDueRunScheduler'],
  } as LocalServerDeps, {
    authToken: 'secret',
    loadSnapshot: async () => ({}),
    listSessions: async () => [],
    resumeSession: async () => {
      throw new Error('not called');
    },
  }), true);

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(res.statusCode, 400);
  assert.deepEqual(JSON.parse(res.body), {
    error: 'invalid limit',
  });
});

test('handleLocalHttpRequest returns 404 when studio due-runs scheduler is unavailable', async () => {
  const res = makeRes();
  assert.equal(handleLocalHttpRequest(makeReq('/studio_due_runs', 'Bearer secret'), res, {
    actorId: 'pet-a',
    llmConfig: {
      model: 'test-model',
      contextWindowTokens: 32000,
    },
    workdir: '/tmp/workspace',
  } as LocalServerDeps, {
    authToken: 'secret',
    loadSnapshot: async () => ({}),
    listSessions: async () => [],
    resumeSession: async () => {
      throw new Error('not called');
    },
  }), true);

  assert.equal(res.statusCode, 404);
  assert.deepEqual(JSON.parse(res.body), { error: 'studio_due_runs unavailable' });
});

test('handleLocalHttpRequest returns due-run metrics when include=metrics', async () => {
  const workdir = await fs.mkdtemp(join(tmpdir(), 'pinpawo-runtime-'));
  const stateRoot = join(workdir, '.pinpawo');
  const scheduler = {
    trace: async () => [{
      runId: 'run-1',
      conversationId: 'conv-1',
      idempotencyKey: 'studio:conv-1:run:run-1',
      status: 'success',
      attempt: 1,
      ownerUserId: null,
      finalPetRunId: 'pet-run-1',
      workdir,
      createdAt: '2026-06-19T00:00:00.000Z',
      claimedAt: '2026-06-19T00:00:01.000Z',
      completedAt: '2026-06-19T00:00:02.000Z',
    }],
    metrics: async () => ({
      statusCounts: {
        pending: 0,
        claimed: 0,
        running: 0,
        success: 1,
        failed: 0,
        canceled: 0,
      },
      totalRows: 1,
      totalAttempts: 1,
      retriedRows: 0,
      retriedAttempts: 0,
      queueWaitMs: {
        count: 1,
        averageMs: 1000,
        minMs: 1000,
        maxMs: 1000,
      },
      runDurationMs: {
        count: 1,
        averageMs: 1000,
        minMs: 1000,
        maxMs: 1000,
      },
      failureCodeCounts: {},
    }),
  } as unknown as LocalServerDeps['studioDueRunScheduler'];

  const res = makeRes();
  assert.equal(handleLocalHttpRequest(makeReq('/studio_due_runs?include=metrics', 'Bearer secret'), res, {
    actorId: 'pet-a',
    llmConfig: {
      model: 'test-model',
      contextWindowTokens: 32000,
    },
    workdir,
    runtimeConfig: {
      workdir,
      stateRoot,
      studioConfigPath: join(stateRoot, 'studio.json'),
      studioDueRunsPath: join(stateRoot, 'studio-due-runs.json'),
      petsDir: join(stateRoot, 'pets'),
      studioWikiBaseDir: join(stateRoot, 'studio-wiki'),
      checkpointPath: join(stateRoot, 'checkpoints.json'),
      tuiCheckpointPath: join(stateRoot, 'checkpoints-tui.json'),
      tuiSessionPath: join(stateRoot, 'tui-sessions.json'),
      capabilityArtifactRoot: join(stateRoot, 'capability-artifacts'),
    },
    studioDueRunScheduler: scheduler,
  } as LocalServerDeps, {
    authToken: 'secret',
    loadSnapshot: async () => ({}),
    listSessions: async () => [],
    resumeSession: async () => {
      throw new Error('not called');
    },
  }), true);

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(res.statusCode, 200);
  const payload = JSON.parse(res.body);
  assert.equal(payload.studio_due_runs.length, 1);
  assert.equal(payload.studio_due_run_metrics.totalRows, 1);
});
