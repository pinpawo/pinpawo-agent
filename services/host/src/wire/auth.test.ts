import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  buildWireAuthHeaders,
  createWireAuthToken,
  ensureWireAuthToken,
  isAllowedWireOrigin,
  isAuthorizedWireRequest,
  readWireAuthToken,
} from './auth';

function withTokenFile<T>(run: (path: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'pinpawo-auth-'));
  try {
    return run(join(dir, 'local-server-token'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function makeReq(options: {
  url?: string;
  authorization?: string;
  origin?: string;
  protocol?: string;
} = {}): IncomingMessage {
  return {
    url: options.url ?? '/',
    headers: {
      host: '127.0.0.1:3210',
      ...(options.authorization ? { authorization: options.authorization } : {}),
      ...(options.origin ? { origin: options.origin } : {}),
      ...(options.protocol ? { 'sec-websocket-protocol': options.protocol } : {}),
    },
  } as IncomingMessage;
}

test('local server auth accepts only bearer tokens', () => {
  assert.equal(
    isAuthorizedWireRequest(makeReq({ authorization: 'Bearer secret' }), 'secret'),
    true,
  );
  assert.equal(
    isAuthorizedWireRequest(makeReq({ url: '/?token=secret' }), 'secret'),
    false,
  );
  assert.equal(
    isAuthorizedWireRequest(makeReq({ protocol: 'chat, pinpawo-token.secret' }), 'secret'),
    false,
  );
  assert.equal(
    isAuthorizedWireRequest(makeReq({ authorization: 'Bearer wrong' }), 'secret'),
    false,
  );
  assert.equal(isAuthorizedWireRequest(makeReq(), 'secret'), false);
});

test('local server origin check permits only same-port loopback origins', () => {
  assert.equal(isAllowedWireOrigin(makeReq(), 3210), true);
  assert.equal(
    isAllowedWireOrigin(makeReq({ origin: 'http://127.0.0.1:3210' }), 3210),
    true,
  );
  assert.equal(
    isAllowedWireOrigin(makeReq({ origin: 'http://localhost:3210' }), 3210),
    true,
  );
  assert.equal(
    isAllowedWireOrigin(makeReq({ origin: 'https://evil.example' }), 3210),
    false,
  );
  assert.equal(
    isAllowedWireOrigin(makeReq({ origin: 'http://127.0.0.1:9999' }), 3210),
    false,
  );
  assert.equal(
    isAllowedWireOrigin(makeReq({ origin: 'null' }), 3210),
    false,
  );
});

test('local server client auth helper formats bearer headers', () => {
  assert.deepEqual(buildWireAuthHeaders('secret'), {
    Authorization: 'Bearer secret',
  });
  assert.deepEqual(buildWireAuthHeaders(null), {});
});

test('a second Host serves the token the first one published', () => {
  withTokenFile((path) => {
    // Hosts share this file by default, and it is how a Host tells the user
    // which credential to present. Minting per start left the earlier Host
    // serving a token nobody could look up.
    const first = ensureWireAuthToken(path);
    const second = ensureWireAuthToken(path);

    assert.equal(second, first);
    assert.equal(readWireAuthToken(path), first);
    assert.equal(
      isAuthorizedWireRequest(makeReq({ authorization: `Bearer ${first}` }), second),
      true,
    );
  });
});

test('a restart keeps the credential the user already has', () => {
  withTokenFile((path) => {
    const before = ensureWireAuthToken(path);
    const after = ensureWireAuthToken(path);
    assert.equal(after, before);
  });
});

test('a token file with surrounding whitespace is reused, not rotated', () => {
  withTokenFile((path) => {
    const token = createWireAuthToken();
    writeFileSync(path, `  ${token}\n\n`, 'utf-8');
    assert.equal(ensureWireAuthToken(path), token);
    assert.equal(readFileSync(path, 'utf-8').trim(), token);
  });
});
