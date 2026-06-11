import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseHistoryMessages,
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
    title: 'Pet chat',
    messageCount: 3,
    createdAt: '2026-06-03T00:00:00.000Z',
    updatedAt: '2026-06-03T00:01:00.000Z',
    active: true,
  }), {
    id: 'chat:pet-a',
    title: 'Pet chat',
    messageCount: 3,
    createdAt: '2026-06-03T00:00:00.000Z',
    updatedAt: '2026-06-03T00:01:00.000Z',
    active: true,
  });
  assert.equal(parseResumeSessionSummary({ id: 'missing-title' }), null);
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
          { role: 'tool', text: 'not visible' },
        ],
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
          title: 'One',
          createdAt: '2026-06-03T00:00:00.000Z',
          updatedAt: '2026-06-03T00:01:00.000Z',
          active: true,
        },
        messages: [{ role: 'assistant', text: 'welcome back' }],
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
  assert.deepEqual((await client.readHistory()).map((item) => item.text), ['restored']);
  assert.deepEqual((await client.listResumeSessions()).map((item) => item.id), ['chat:one']);
  const resumed = await client.resumeSession('chat:one');

  assert.equal(resumed.session.active, true);
  assert.deepEqual(resumed.history.map((item) => item.text), ['welcome back']);
  assert.deepEqual(seenUrls, [
    'http://127.0.0.1:3210/health',
    'http://127.0.0.1:3210/history',
    'http://127.0.0.1:3210/sessions',
    'http://127.0.0.1:3210/sessions/resume?sessionId=chat%3Aone',
  ]);
  assert.deepEqual(seenAuth, [
    'Bearer secret',
    'Bearer secret',
    'Bearer secret',
    'Bearer secret',
  ]);
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
