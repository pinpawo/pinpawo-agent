import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import test from 'node:test';
import {
  buildLocalServerAuthHeaders,
  isAllowedLocalServerOrigin,
  isAuthorizedLocalServerRequest,
} from './localServerAuth';

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
