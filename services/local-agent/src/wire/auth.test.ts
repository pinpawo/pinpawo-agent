import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  buildLocalServerAuthHeaders,
  createLocalServerAuthToken,
  ensureLocalServerAuthToken,
  isAllowedLocalServerOrigin,
  isAuthorizedLocalServerRequest,
  readLocalServerAuthToken,
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
    isAuthorizedLocalServerRequest(makeReq({ authorization: 'Bearer secret' }), 'secret'),
    true,
  );
  assert.equal(
    isAuthorizedLocalServerRequest(makeReq({ url: '/?token=secret' }), 'secret'),
    false,
  );
  assert.equal(
    isAuthorizedLocalServerRequest(makeReq({ protocol: 'chat, pinpawo-token.secret' }), 'secret'),
    false,
  );
  assert.equal(
    isAuthorizedLocalServerRequest(makeReq({ authorization: 'Bearer wrong' }), 'secret'),
    false,
  );
  assert.equal(isAuthorizedLocalServerRequest(makeReq(), 'secret'), false);
});

test('local server origin check permits only same-port loopback origins', () => {
  assert.equal(isAllowedLocalServerOrigin(makeReq(), 3210), true);
  assert.equal(
    isAllowedLocalServerOrigin(makeReq({ origin: 'http://127.0.0.1:3210' }), 3210),
    true,
  );
  assert.equal(
    isAllowedLocalServerOrigin(makeReq({ origin: 'http://localhost:3210' }), 3210),
    true,
  );
  assert.equal(
    isAllowedLocalServerOrigin(makeReq({ origin: 'https://evil.example' }), 3210),
    false,
  );
  assert.equal(
    isAllowedLocalServerOrigin(makeReq({ origin: 'http://127.0.0.1:9999' }), 3210),
    false,
  );
  assert.equal(
    isAllowedLocalServerOrigin(makeReq({ origin: 'null' }), 3210),
    false,
  );
});

test('local server client auth helper formats bearer headers', () => {
  assert.deepEqual(buildLocalServerAuthHeaders('secret'), {
    Authorization: 'Bearer secret',
  });
  assert.deepEqual(buildLocalServerAuthHeaders(null), {});
});

test('a second Host serves the token the first one published', () => {
  withTokenFile((path) => {
    // Hosts share this file by default, and it is how a Host tells the user
    // which credential to present. Minting per start left the earlier Host
    // serving a token nobody could look up.
    const first = ensureLocalServerAuthToken(path);
    const second = ensureLocalServerAuthToken(path);

    assert.equal(second, first);
    assert.equal(readLocalServerAuthToken(path), first);
    assert.equal(
      isAuthorizedLocalServerRequest(makeReq({ authorization: `Bearer ${first}` }), second),
      true,
    );
  });
});

test('a restart keeps the credential the user already has', () => {
  withTokenFile((path) => {
    const before = ensureLocalServerAuthToken(path);
    const after = ensureLocalServerAuthToken(path);
    assert.equal(after, before);
  });
});

test('a token file with surrounding whitespace is reused, not rotated', () => {
  withTokenFile((path) => {
    const token = createLocalServerAuthToken();
    writeFileSync(path, `  ${token}\n\n`, 'utf-8');
    assert.equal(ensureLocalServerAuthToken(path), token);
    assert.equal(readFileSync(path, 'utf-8').trim(), token);
  });
});
