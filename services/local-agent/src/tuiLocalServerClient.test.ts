import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseHistoryMessages,
  parseLocalServerRuntime,
  parseResumeSessionSummary,
  TuiLocalServerClient,
} from './tui/tuiLocalServerClient';

test('parseHistoryMessages keeps visible chat transcript messages only', () => {
  const messages = parseHistoryMessages([
    { role: 'user', text: 'hello' },
    { role: 'assistant', text: 'world' },
    { role: 'system', text: 'notice' },
    { role: 'tool', text: 'hidden' },
    { role: 'user', text: '  ' },
  ]);

  assert.deepEqual(messages.map((item) => [item.kind, item.text]), [
    ['user', 'hello'],
    ['assistant', 'world'],
    ['system', 'notice'],
  ]);
});

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

test('TuiLocalServerClient reads sessions, resume payloads, history, and health', async () => {
  const seenUrls: string[] = [];
  const seenAuth: Array<string | undefined> = [];
  const fetchImpl = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    seenUrls.push(url);
    seenAuth.push((init?.headers as Record<string, string> | undefined)?.Authorization);
    if (url.endsWith('/health')) {
      return jsonResponse({ ok: true });
    }
    if (url.endsWith('/history')) {
      return jsonResponse({
        messages: [
          { role: 'user', text: 'restored' },
          { role: 'system', text: 'notice' },
          { role: 'tool', text: 'not visible' },
        ],
      });
    }
    if (url.endsWith('/snapshot')) {
      return jsonResponse({
        sessionId: 'chat:pet',
        kind: 'chat',
        timeline: [{
          id: 'message:0:user',
          type: 'message',
          role: 'user',
          text: 'restored from snapshot',
          status: 'completed',
          source: 'checkpoint',
          requestId: 'req-review',
        }],
        runs: [{
          requestId: 'req-review',
          sessionId: 'chat:pet',
          kind: 'chat',
          phase: 'waiting_human',
          timelineEntryIds: ['message:0:user'],
          pendingReview: {
            requestId: 'req-review',
            reviewId: 'review-1',
            status: 'waiting',
            petId: 'pet-a',
            review: {
              id: 'review-1',
              schemaVersion: 1,
              view: { kind: 'plain', body: 'Approve?' },
              options: [],
            },
          },
        }],
        activeRunId: 'req-review',
        pendingReviewId: 'review-1',
      });
    }
    if (url.endsWith('/sessions')) {
      return jsonResponse({
        sessions: [
          {
            id: 'chat:one',
            title: 'One',
            createdAt: '2026-06-03T00:00:00.000Z',
            updatedAt: '2026-06-03T00:01:00.000Z',
          },
          { id: 'bad' },
        ],
      });
    }
    if (url.includes('/sessions/resume?sessionId=chat%3Aone')) {
      return jsonResponse({
        session: {
          id: 'chat:one',
          kind: 'studio',
          title: 'One',
          createdAt: '2026-06-03T00:00:00.000Z',
          updatedAt: '2026-06-03T00:01:00.000Z',
          active: true,
        },
        messages: [{ role: 'assistant', text: 'welcome back' }],
        snapshot: {
          sessionId: 'chat:one',
          kind: 'studio',
          timeline: [{
            id: 'message:0:assistant',
            type: 'message',
            role: 'assistant',
            text: 'welcome back',
            status: 'completed',
            source: 'checkpoint',
          }],
          runs: [],
        },
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
  assert.deepEqual((await client.readHistory()).map((item) => item.text), ['restored', 'notice']);
  const snapshot = await client.readSessionSnapshot({ sessionId: 'chat:pet', kind: 'chat' });
  assert.deepEqual(snapshot.timeline.map((entry) => [entry.type, entry.type === 'message' ? entry.text : '']), [
    ['message', 'restored from snapshot'],
  ]);
  assert.equal(snapshot.activeRunId, 'req-review');
  assert.equal(snapshot.runs[0]?.pendingReview?.review?.id, 'review-1');
  assert.equal(snapshot.runs[0]?.pendingReview?.petId, 'pet-a');
  assert.deepEqual((await client.listResumeSessions()).map((item) => item.id), ['chat:one']);
  const resumed = await client.resumeSession('chat:one');

  assert.equal(resumed.session.active, true);
  assert.equal(resumed.session.kind, 'studio');
  assert.equal(resumed.snapshot.kind, 'studio');
  assert.deepEqual(resumed.snapshot.timeline.map((entry) => [entry.type, entry.type === 'message' ? entry.text : '']), [
    ['message', 'welcome back'],
  ]);
  assert.deepEqual(seenUrls, [
    'http://127.0.0.1:3210/health',
    'http://127.0.0.1:3210/history',
    'http://127.0.0.1:3210/snapshot',
    'http://127.0.0.1:3210/runtime',
    'http://127.0.0.1:3210/sessions',
    'http://127.0.0.1:3210/sessions/resume?sessionId=chat%3Aone',
  ]);
  assert.deepEqual(seenAuth, [
    'Bearer secret',
    'Bearer secret',
    'Bearer secret',
    'Bearer secret',
    'Bearer secret',
    'Bearer secret',
  ]);
});

test('TuiLocalServerClient does not synthesize snapshots when history restore fails', async () => {
  const client = new TuiLocalServerClient({
    port: 3210,
    fetchImpl: (async (url: RequestInfo | URL) => {
      const href = String(url);
      if (href.endsWith('/history')) {
        return new Response('{}', { status: 503 });
      }
      if (href.endsWith('/snapshot')) {
        return new Response('{}', { status: 404 });
      }
      if (href.endsWith('/runtime')) {
        return jsonResponse({ model: 'gpt-test' });
      }
      return jsonResponse({});
    }) as typeof fetch,
  });

  await assert.rejects(
    () => client.readSessionSnapshot({ sessionId: 'chat:pet', kind: 'chat' }),
    /HTTP 503/,
  );
});

test('TuiLocalServerClient adapts recognized legacy snapshot payloads at the compatibility boundary', async () => {
  const client = new TuiLocalServerClient({
    port: 3210,
    fetchImpl: (async (url: RequestInfo | URL) => {
      const href = String(url);
      if (href.endsWith('/snapshot')) {
        return jsonResponse({
          session: { id: 'chat:legacy', kind: 'chat' },
          messages: [
            { role: 'user', text: 'legacy prompt' },
            { role: 'assistant', text: 'legacy answer' },
          ],
          pendingReview: {
            requestId: 'req-review',
            reviewId: 'review-1',
            actor: { petId: 'pet-a' },
            review: {
              id: 'review-1',
              schemaVersion: 1,
              view: { kind: 'plain', body: 'Approve?' },
              options: [],
            },
          },
        });
      }
      if (href.endsWith('/runtime')) {
        return jsonResponse({ model: 'gpt-test' });
      }
      return jsonResponse({});
    }) as typeof fetch,
  });

  const snapshot = await client.readSessionSnapshot({ sessionId: 'chat:pet', kind: 'studio' });

  assert.equal(snapshot.sessionId, 'chat:legacy');
  assert.equal(snapshot.kind, 'chat');
  assert.deepEqual(snapshot.timeline.map((entry) => [entry.type, entry.type === 'message' ? entry.text : '']), [
    ['message', 'legacy prompt'],
    ['message', 'legacy answer'],
  ]);
  assert.equal(snapshot.activeRunId, 'req-review');
  assert.equal(snapshot.runs[0]?.pendingReview?.review?.id, 'review-1');
  assert.equal(snapshot.runs[0]?.pendingReview?.petId, 'pet-a');
});

test('TuiLocalServerClient rejects malformed snapshot payloads instead of synthesizing empty snapshots', async () => {
  const seenUrls: string[] = [];
  const client = new TuiLocalServerClient({
    port: 3210,
    fetchImpl: (async (url: RequestInfo | URL) => {
      const href = String(url);
      seenUrls.push(href);
      if (href.endsWith('/snapshot')) {
        return jsonResponse({
          sessionId: 'chat:pet',
          kind: 'chat',
          timeline: 'not-a-timeline',
          runs: [],
        });
      }
      if (href.endsWith('/runtime')) {
        return jsonResponse({ model: 'gpt-test' });
      }
      if (href.endsWith('/history')) {
        return jsonResponse({
          messages: [{ role: 'assistant', text: 'should not be used' }],
        });
      }
      return jsonResponse({});
    }) as typeof fetch,
  });

  await assert.rejects(
    () => client.readSessionSnapshot({ sessionId: 'chat:pet', kind: 'chat' }),
    /invalid local server snapshot payload/,
  );
  assert.equal(seenUrls.includes('http://127.0.0.1:3210/history'), false);
});

test('TuiLocalServerClient rejects subagent snapshot messages without requestId', async () => {
  const client = new TuiLocalServerClient({
    port: 3210,
    fetchImpl: (async (url: RequestInfo | URL) => {
      if (String(url).endsWith('/snapshot')) {
        return jsonResponse({
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
          runs: [],
        });
      }
      return jsonResponse({});
    }) as typeof fetch,
  });

  await assert.rejects(
    () => client.readSessionSnapshot({ sessionId: 'chat:pet', kind: 'chat' }),
    /invalid local server snapshot payload/,
  );
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

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json',
    },
  });
}
