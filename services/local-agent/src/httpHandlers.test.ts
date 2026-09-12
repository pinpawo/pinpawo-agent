import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { handleLocalHttpRequest } from './httpHandlers';
import type { ServerDeps } from './serverTypes';
import { readLocalAgentPackageVersion } from './packageVersion';
import { createTestModelServerDeps } from './testing/modelProfiles';

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

test('handleLocalHttpRequest exposes no conversation capability routes', () => {
  // HTTP carries the operational surface only. Conversation capability lives
  // in the WebSocket/stdio handler set, which the TUI uses via session.list /
  // session.snapshot.get / session.resume.
  for (const pathname of ['/health', '/history', '/snapshot', '/sessions', '/sessions/resume']) {
    assert.equal(
      handleLocalHttpRequest(makeReq(pathname, 'Bearer secret'), makeRes(), {} as ServerDeps, {
        authToken: 'secret',
      }),
      false,
      `${pathname} must not be served over HTTP`,
    );
  }
});

test('handleLocalHttpRequest rejects requests without a valid local token', async () => {
  const deps = {} as ServerDeps;
  const options = {
    authToken: 'secret',
  };

  const missingRes = makeRes();
  assert.equal(handleLocalHttpRequest(makeReq('/runtime'), missingRes, deps, options), true);
  assert.equal(missingRes.statusCode, 401);
  assert.deepEqual(JSON.parse(missingRes.body), { error: 'unauthorized' });

  const wrongRes = makeRes();
  assert.equal(handleLocalHttpRequest(makeReq('/runtime', 'Bearer wrong'), wrongRes, deps, options), true);
  assert.equal(wrongRes.statusCode, 401);

  // Authorization is decided before the route body runs, so the rejected
  // cases need no deps. A valid token reaching a real projection is covered
  // by the runtime-endpoint test below.
});

test('Capability HTTP routes are not part of the local server contract', () => {
  const deps = {} as ServerDeps;
  const options = {
    authToken: 'secret',
  };

  assert.equal(handleLocalHttpRequest(
    makeReq('/capabilities', 'Bearer secret'),
    makeRes(),
    deps,
    options,
  ), false);
  assert.equal(handleLocalHttpRequest(
    makeReq('/capabilities/rescan', 'Bearer secret'),
    makeRes(),
    deps,
    options,
  ), false);
});

test('handleLocalHttpRequest keeps Studio paths out of the Chat runtime endpoint', async () => {
  const workdir = await fs.mkdtemp(join(tmpdir(), 'pinpawo-runtime-'));
  const stateRoot = join(workdir, '.pinpawo');
  await fs.mkdir(stateRoot, { recursive: true });

  const res = makeRes();
  assert.equal(handleLocalHttpRequest(makeReq('/runtime', 'Bearer secret'), res, {
    serverMode: 'chat',
    petId: 'pet-a',
    ...createTestModelServerDeps({ contextWindowTokens: 32000 }),
    runtimeConfig: {
      workdir,
      workspace: {
        id: 'workspace-test',
        name: 'Runtime Test',
        rootPath: workdir,
      },
      stateRoot,
      checkpointPath: join(stateRoot, 'checkpoints.json'),
      tuiCheckpointPath: join(stateRoot, 'checkpoints-tui.json'),
      tuiSessionPath: join(stateRoot, 'tui-sessions.json'),
      capabilityArtifactRoot: join(stateRoot, 'capability-artifacts'),
    },
  } as ServerDeps, {
    authToken: 'secret',
  }), true);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), {
    local_agent_version: readLocalAgentPackageVersion(),
    server_mode: 'chat',
    model_profile_id: 'test-profile',
    model_profile_label: 'Test profile',
    model_profile_available: true,
    llm_model: 'test-model',
    llm_context_window_tokens: 32000,
    context_compaction_watermark_tokens: 24000,
    workdir,
    workspace_id: 'workspace-test',
    workspace_name: 'Runtime Test',
    workspace_root: workdir,
    state_root: stateRoot,
  });
});
