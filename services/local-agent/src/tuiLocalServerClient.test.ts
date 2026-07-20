import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLocalAgentSessionSummary } from './localAgentSessionParser';
import { TuiLocalServerClient } from './tui/tuiLocalServerClient';

test('parseLocalAgentSessionSummary validates resume session payloads', () => {
  assert.deepEqual(parseLocalAgentSessionSummary({
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
  assert.equal(parseLocalAgentSessionSummary({ id: 'missing-title' }), null);
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
    if (url.endsWith('/sessions')) {
      return jsonResponse({
        sessions: [{
          id: 'chat:one',
          kind: 'chat',
          title: 'One',
          messageCount: 0,
          createdAt: '2026-06-03T00:00:00.000Z',
          updatedAt: '2026-06-03T00:01:00.000Z',
          active: false,
        }],
      });
    }
    if (url.includes('/sessions/resume?sessionId=chat%3Aone')) {
      return jsonResponse({
        session: {
          id: 'chat:one',
          kind: 'chat',
          title: 'One',
          messageCount: 0,
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
  assert.equal(loaded.session.activeRun?.state, 'waiting_review');
  if (loaded.session.activeRun?.state !== 'waiting_review') assert.fail('expected waiting review');
  assert.equal(loaded.session.activeRun.reviewAction.actionId, 'interrupt-1');
  assert.equal('status' in loaded.session.activeRun.reviewAction, false);
  assert.equal(loaded.session.timeline[1]?.type, 'operation');
  assert.deepEqual((await client.listResumeSessions()).map((item) => item.id), ['chat:one']);
  const resumed = await client.resumeSession('chat:one');
  assert.equal(resumed.session.active, true);
  assert.equal(resumed.snapshot.session.sessionId, 'chat:one');

  assert.deepEqual(seenUrls, [
    'http://127.0.0.1:3210/health',
    'http://127.0.0.1:3210/snapshot',
    'http://127.0.0.1:3210/sessions',
    'http://127.0.0.1:3210/sessions/resume?sessionId=chat%3Aone',
  ]);
  assert.deepEqual(seenAuth, Array(4).fill('Bearer secret'));
});

test('TuiLocalServerClient rejects non-versioned snapshot payloads without history fallback', async () => {
  const seenUrls: string[] = [];
  const client = new TuiLocalServerClient({
    port: 3210,
    fetchImpl: (async (url: RequestInfo | URL) => {
      const href = String(url);
      seenUrls.push(href);
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
      return jsonResponse({
        version: 3,
        session: {
          sessionId: 'chat:pet',
          kind: 'chat',
          timeline: [{
            id: 'subagent-1',
            type: 'message',
            role: 'subagent',
            text: 'working',
            status: 'streaming',
          }],
          activeRun: null,
        },
      });
    }) as typeof fetch,
  });

  await assert.rejects(() => client.readSessionSnapshot(), /invalid local server snapshot payload/);
});

test('TuiLocalServerClient rejects malformed runtime facts in current snapshots', async () => {
  const invalidRuntimes = [
    { model: 42 },
    { cwd: ['/tmp/work'] },
    { contextWindow: '64000' },
  ];

  for (const runtime of invalidRuntimes) {
    const snapshot = sessionSnapshot('chat:pet');
    const client = new TuiLocalServerClient({
      port: 3210,
      fetchImpl: (async () => jsonResponse({
        ...snapshot,
        session: { ...snapshot.session, runtime },
      })) as typeof fetch,
    });

    await assert.rejects(
      () => client.readSessionSnapshot(),
      /invalid local server snapshot payload/,
    );
  }
});

test('TuiLocalServerClient rejects legacy and structurally invalid active run views', async () => {
  const reviewAction = sessionSnapshot('chat:pet').session.activeRun.reviewAction;
  const invalidRuns = [
    {
      requestId: 'req-review',
      phase: 'waiting_human',
      reviewAction,
    },
    {
      requestId: 'req-review',
      state: 'waiting_review',
    },
    {
      requestId: 'req-running',
      state: 'running',
      activity: 'thinking',
      reviewAction,
    },
    {
      requestId: 'req-interrupting',
      state: 'interrupting',
      activity: 'thinking',
    },
  ];

  for (const activeRun of invalidRuns) {
    const snapshot = sessionSnapshot('chat:pet');
    const client = new TuiLocalServerClient({
      port: 3210,
      fetchImpl: (async () => jsonResponse({
        ...snapshot,
        session: { ...snapshot.session, activeRun },
      })) as typeof fetch,
    });
    await assert.rejects(
      () => client.readSessionSnapshot(),
      /invalid local server snapshot payload/,
    );
  }
});

test('TuiLocalServerClient accepts every legal non-review active run view', async () => {
  const activeRuns = [
    {
      requestId: 'req-running',
      state: 'running',
      activity: 'using_tool',
      startedAt: 1000,
    },
    {
      requestId: 'req-interrupting',
      state: 'interrupting',
      startedAt: 1000,
    },
  ];

  for (const activeRun of activeRuns) {
    const snapshot = sessionSnapshot('chat:pet');
    const client = new TuiLocalServerClient({
      port: 3210,
      fetchImpl: (async () => jsonResponse({
        ...snapshot,
        session: { ...snapshot.session, activeRun },
      })) as typeof fetch,
    });
    const loaded = await client.readSessionSnapshot();
    assert.deepEqual(loaded.session.activeRun, activeRun);
  }
});

test('TuiLocalServerClient rejects the previous snapshot schema version', async () => {
  const snapshot = sessionSnapshot('chat:pet');
  const client = new TuiLocalServerClient({
    port: 3210,
    fetchImpl: (async () => jsonResponse({ ...snapshot, version: 2 })) as typeof fetch,
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
        messageCount: 0,
        createdAt: '2026-06-03T00:00:00.000Z',
        updatedAt: '2026-06-03T00:01:00.000Z',
        active: false,
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
        messageCount: 0,
        createdAt: '2026-06-03T00:00:00.000Z',
        updatedAt: '2026-06-03T00:01:00.000Z',
        active: false,
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
    version: 3,
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
        },
      ],
      activeRun: {
        requestId: 'req-review',
        state: 'waiting_review',
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
