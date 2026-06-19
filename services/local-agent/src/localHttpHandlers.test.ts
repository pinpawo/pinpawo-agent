import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { handleLocalHttpRequest } from './localHttpHandlers';
import type { LocalServerDeps } from './localServerTypes';
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
    loadHistory: async () => [],
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
    loadHistory: async () => [],
    listSessions: async () => [],
    resumeSession: async (sessionId) => ({
      session: { id: sessionId, title: 'first' },
      messages: [{ role: 'user', text: 'hello' }],
    }),
  }), true);

  await Promise.resolve();
  assert.equal(resumeRes.statusCode, 200);
  assert.deepEqual(JSON.parse(resumeRes.body), {
    session: { id: 'pet-a:one', title: 'first' },
    messages: [{ role: 'user', text: 'hello' }],
  });
});

test('handleLocalHttpRequest rejects requests without a valid local token', async () => {
  const deps = {} as LocalServerDeps;
  const options = {
    authToken: 'secret',
    loadHistory: async () => {
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
    loadHistory: async () => [],
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

test('handleLocalHttpRequest exposes workdir Studio config source on runtime endpoint', async () => {
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
    workdir,
    runtimeConfig: {
      workdir,
      stateRoot,
      studioConfigPath,
      petsDir: join(stateRoot, 'pets'),
      studioWikiBaseDir: join(stateRoot, 'studio-wiki'),
      checkpointPath: join(stateRoot, 'checkpoints.json'),
      tuiCheckpointPath: join(stateRoot, 'checkpoints-tui.json'),
      tuiSessionPath: join(stateRoot, 'tui-sessions.json'),
      capabilityArtifactRoot: join(stateRoot, 'capability-artifacts'),
    },
  } as LocalServerDeps, {
    authToken: 'secret',
    loadHistory: async () => [],
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
    state_root: stateRoot,
    studio_config_path: studioConfigPath,
    pets_dir: join(stateRoot, 'pets'),
    studio_wiki_base_dir: join(stateRoot, 'studio-wiki'),
    studio_config_source: 'workdir',
    studio_config_active_path: studioConfigPath,
    legacy_studio_config_path: join(homedir(), '.pinpawo', 'studio.json'),
  });
});
