import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import test from 'node:test';
import { handleLocalHttpRequest } from './localHttpHandlers';
import type { LocalServerDeps } from './localServerTypes';

function makeReq(url: string): IncomingMessage {
  return {
    url,
    headers: {
      host: '127.0.0.1:3210',
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

  assert.equal(handleLocalHttpRequest(makeReq('/sessions'), listRes, deps, {
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
  assert.equal(handleLocalHttpRequest(makeReq('/sessions/resume?sessionId=pet-a%3Aone'), resumeRes, deps, {
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
