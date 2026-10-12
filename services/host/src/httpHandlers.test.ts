import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import test from 'node:test';
import { handleLocalHttpRequest } from './httpHandlers';

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
      handleLocalHttpRequest(makeReq(pathname, 'Bearer secret'), makeRes(), {
        authToken: 'secret',
      }),
      false,
      `${pathname} must not be served over HTTP`,
    );
  }
});

test('handleLocalHttpRequest rejects requests without a valid local token', async () => {
  const options = {
    authToken: 'secret',
  };

  const missingRes = makeRes();
  assert.equal(handleLocalHttpRequest(makeReq('/runtime'), missingRes, options), true);
  assert.equal(missingRes.statusCode, 401);
  assert.deepEqual(JSON.parse(missingRes.body), { error: 'unauthorized' });

  const wrongRes = makeRes();
  assert.equal(handleLocalHttpRequest(makeReq('/runtime', 'Bearer wrong'), wrongRes, options), true);
  assert.equal(wrongRes.statusCode, 401);
});

test('Capability HTTP routes are not part of the local server contract', () => {
  const options = {
    authToken: 'secret',
  };

  assert.equal(handleLocalHttpRequest(
    makeReq('/capabilities', 'Bearer secret'),
    makeRes(),
    options,
  ), false);
  assert.equal(handleLocalHttpRequest(
    makeReq('/capabilities/rescan', 'Bearer secret'),
    makeRes(),
    options,
  ), false);
});

test('handleLocalHttpRequest answers the runtime probe without runtime details', () => {
  const res = makeRes();
  assert.equal(handleLocalHttpRequest(makeReq('/runtime', 'Bearer secret'), res, {
    authToken: 'secret',
  }), true);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true });
});
