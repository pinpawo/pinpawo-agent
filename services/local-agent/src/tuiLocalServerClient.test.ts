import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseLocalServerRuntime,
  parseResumeSessionSummary,
  TuiLocalServerClient,
} from './tui/tuiLocalServerClient';

test('parseResumeSessionSummary validates resume session payloads', () => {
  assert.deepEqual(parseResumeSessionSummary({
    id: 'chat:pet-a',
    kind: 'chat',
    title: 'Pet chat',
    messageCount: 3,
    createdAt: '2026-06-03T00:00:00.000Z',
    updatedAt: '2026-06-03T00:01:00.000Z',
    active: true,
  }), {
    id: 'chat:pet-a',
    kind: 'chat',
    title: 'Pet chat',
    messageCount: 3,
    createdAt: '2026-06-03T00:00:00.000Z',
    updatedAt: '2026-06-03T00:01:00.000Z',
    active: true,
  });
  assert.equal(parseResumeSessionSummary({ id: 'missing-title' }), null);
});

test('parseLocalServerRuntime reads workdir-scoped runtime paths', () => {
  assert.deepEqual(parseLocalServerRuntime({
    llm_model: 'deepseek-v4-pro',
    llm_context_window_tokens: '64000',
    workdir: '/tmp/workspace',
    workspace_id: 'workspace-test',
    workspace_name: 'Workspace Test',
    workspace_root: '/tmp/workspace',
    state_root: '/tmp/workspace/.pinpawo',
    studio_config_path: '/tmp/workspace/.pinpawo/studio.json',
    studio_due_runs_path: '/tmp/workspace/.pinpawo/studio-due-runs.json',
    studio_config_source: 'legacy_home',
    studio_config_active_path: '/home/user/.pinpawo/studio.json',
    legacy_studio_config_path: '/home/user/.pinpawo/studio.json',
    pets_dir: '/tmp/workspace/.pinpawo/pets',
    studio_wiki_base_dir: '/tmp/workspace/.pinpawo/studio-wiki',
  }), {
    model: 'deepseek-v4-pro',
    contextWindow: 64000,
    cwd: '/tmp/workspace',
    workspaceId: 'workspace-test',
    workspaceName: 'Workspace Test',
    workspaceRoot: '/tmp/workspace',
    stateRoot: '/tmp/workspace/.pinpawo',
    studioConfigPath: '/tmp/workspace/.pinpawo/studio.json',
    studioDueRunsPath: '/tmp/workspace/.pinpawo/studio-due-runs.json',
    studioConfigSource: 'legacy_home',
    studioConfigActivePath: '/home/user/.pinpawo/studio.json',
    legacyStudioConfigPath: '/home/user/.pinpawo/studio.json',
    petsDir: '/tmp/workspace/.pinpawo/pets',
    studioWikiBaseDir: '/tmp/workspace/.pinpawo/studio-wiki',
  });
});

test('TuiLocalServerClient reads current snapshots, sessions, resume, and health', async () => {
  const seenUrls: string[] = [];
  const seenAuth: Array<string | undefined> = [];
  const snapshot = sessionSnapshot('chat:pet');
  const resumedSnapshot = sessionSnapshot('chat:one');
  const fetchImpl = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    seenUrls.push(url);
    seenAuth.push((init?.headers as Record<string, string> | undefined)?.Authorization);
    if (url.endsWith('/health')) return jsonResponse({ ok: true });
    if (url.endsWith('/snapshot')) return jsonResponse(snapshot);
    if (url.endsWith('/runtime')) return jsonResponse({ model: 'gpt-test', workdir: '/tmp/work' });
    if (url.endsWith('/sessions')) {
      return jsonResponse({
        sessions: [{
          id: 'chat:one',
          kind: 'chat',
          title: 'One',
          createdAt: '2026-06-03T00:00:00.000Z',
          updatedAt: '2026-06-03T00:01:00.000Z',
        }],
      });
    }
    if (url.includes('/sessions/resume?sessionId=chat%3Aone')) {
      return jsonResponse({
        session: {
          id: 'chat:one',
          kind: 'chat',
          title: 'One',
          createdAt: '2026-06-03T00:00:00.000Z',
          updatedAt: '2026-06-03T00:01:00.000Z',
          active: true,
        },
        snapshot: resumedSnapshot,
      });
    }
    return new Response('{}', { status: 404 });
  };
  const client = new TuiLocalServerClient({
    port: 3210,
    fetchImpl: fetchImpl as typeof fetch,
    tokenProvider: () => 'secret',
  });

  assert.equal(await client.isHealthy(), true);
  const loaded = await client.readSessionSnapshot();
  assert.equal(loaded.session.sessionId, 'chat:pet');
  assert.equal(loaded.session.runtime?.model, 'snapshot-model');
  assert.equal(loaded.session.runtime?.cwd, '/tmp/snapshot-work');
  assert.equal(loaded.session.activeRun?.reviewAction?.actionId, 'interrupt-1');
  assert.equal('status' in (loaded.session.activeRun?.reviewAction ?? {}), false);
  assert.equal(loaded.session.timeline[1]?.type, 'operation');
  assert.equal((await client.readRuntime())?.model, 'gpt-test');
  assert.deepEqual((await client.listResumeSessions()).map((item) => item.id), ['chat:one']);
  const resumed = await client.resumeSession('chat:one');
  assert.equal(resumed.session.active, true);
  assert.equal(resumed.snapshot.session.sessionId, 'chat:one');

  assert.deepEqual(seenUrls, [
    'http://127.0.0.1:3210/health',
    'http://127.0.0.1:3210/snapshot',
    'http://127.0.0.1:3210/runtime',
    'http://127.0.0.1:3210/sessions',
    'http://127.0.0.1:3210/sessions/resume?sessionId=chat%3Aone',
  ]);
  assert.deepEqual(seenAuth, Array(5).fill('Bearer secret'));
});

test('TuiLocalServerClient rejects non-versioned snapshot payloads without history fallback', async () => {
  const seenUrls: string[] = [];
  const client = new TuiLocalServerClient({
    port: 3210,
    fetchImpl: (async (url: RequestInfo | URL) => {
      const href = String(url);
      seenUrls.push(href);
      if (href.endsWith('/runtime')) return jsonResponse({});
      if (href.endsWith('/snapshot')) {
        return jsonResponse({
          sessionId: 'chat:legacy',
          kind: 'chat',
          timeline: [],
          runs: [],
        });
      }
      return new Response('{}', { status: 404 });
    }) as typeof fetch,
  });

  await assert.rejects(() => client.readSessionSnapshot(), /invalid local server snapshot payload/);
  assert.equal(seenUrls.some((url) => url.endsWith('/history')), false);
});

test('TuiLocalServerClient rejects malformed current snapshots', async () => {
  const client = new TuiLocalServerClient({
    port: 3210,
    fetchImpl: (async (url: RequestInfo | URL) => {
      if (String(url).endsWith('/runtime')) return jsonResponse({});
      return jsonResponse({
        version: 1,
        session: {
          sessionId: 'chat:pet',
          kind: 'chat',
          timeline: [{
            id: 'subagent-1',
            type: 'message',
            role: 'subagent',
            text: 'working',
            status: 'streaming',
            source: 'live-event',
          }],
          activeRun: null,
        },
      });
    }) as typeof fetch,
  });

  await assert.rejects(() => client.readSessionSnapshot(), /invalid local server snapshot payload/);
});

test('TuiLocalServerClient requires a current snapshot in resume responses', async () => {
  const client = new TuiLocalServerClient({
    port: 3210,
    fetchImpl: (async () => jsonResponse({
      session: {
        id: 'chat:one',
        kind: 'chat',
        title: 'One',
        createdAt: '2026-06-03T00:00:00.000Z',
        updatedAt: '2026-06-03T00:01:00.000Z',
      },
      messages: [{ role: 'assistant', text: 'legacy fallback' }],
    })) as typeof fetch,
  });

  await assert.rejects(() => client.resumeSession('chat:one'), /invalid resume session snapshot/);
});

test('TuiLocalServerClient rejects a resume snapshot for a different session', async () => {
  const client = new TuiLocalServerClient({
    port: 3210,
    fetchImpl: (async () => jsonResponse({
      session: {
        id: 'chat:one',
        kind: 'chat',
        title: 'One',
        createdAt: '2026-06-03T00:00:00.000Z',
        updatedAt: '2026-06-03T00:01:00.000Z',
      },
      snapshot: sessionSnapshot('chat:other'),
    })) as typeof fetch,
  });

  await assert.rejects(() => client.resumeSession('chat:one'), /invalid resume session snapshot/);
});

test('TuiLocalServerClient treats health errors as unhealthy', async () => {
  const client = new TuiLocalServerClient({
    port: 3210,
    fetchImpl: (async () => {
      throw new Error('offline');
    }) as typeof fetch,
  });

  assert.equal(await client.isHealthy(), false);
});

function sessionSnapshot(sessionId: string) {
  return {
    version: 1,
    session: {
      sessionId,
      kind: 'chat',
      timeline: [
        {
          id: 'message:0:user',
          type: 'message',
          role: 'user',
          text: 'restored from checkpoint',
          status: 'completed',
          source: 'checkpoint',
          requestId: 'req-review',
        },
        {
          id: 'req-review:operation:call-1',
          type: 'operation',
          requestId: 'req-review',
          operationKey: 'call-1',
          kind: 'browser.open',
          title: 'Open page',
          phase: 'completed',
          source: 'live-event',
        },
      ],
      activeRun: {
        requestId: 'req-review',
        phase: 'waiting_human',
        reviewAction: {
          actionId: 'interrupt-1',
          status: 'waiting',
          reviews: [{
            id: 'review-1',
            schemaVersion: 1,
            view: { kind: 'plain', body: 'Approve?' },
            options: [],
          }],
        },
      },
      runtime: {
        model: 'snapshot-model',
        cwd: '/tmp/snapshot-work',
      },
    },
  };
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
