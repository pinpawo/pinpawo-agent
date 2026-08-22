import assert from 'node:assert/strict';
import test from 'node:test';
import { loadLocalHostMetadata } from './localHostMetadata';

test('local host metadata reads the local-agent version', async () => {
  const requests: Array<{
    url: string;
    authorization: string | null;
  }> = [];
  const metadata = await loadLocalHostMetadata({
    port: 4321,
    tokenProvider: () => 'secret',
    fetcher: async (input, init) => {
      const url = String(input);
      requests.push({
        url,
        authorization: new Headers(init?.headers).get('authorization'),
      });
      return Response.json({
        local_agent_version: '0.2.0',
      });
    },
  });

  assert.deepEqual(metadata, {
    localAgentVersion: '0.2.0',
  });
  assert.deepEqual(requests, [{
    url: 'http://127.0.0.1:4321/runtime',
    authorization: 'Bearer secret',
  }]);
});

test('local host metadata degrades when runtime metadata is unavailable', async () => {
  const metadata = await loadLocalHostMetadata({
    tokenProvider: () => 'secret',
    fetcher: async () => {
      throw new Error('runtime unavailable');
    },
  });

  assert.deepEqual(metadata, {
    localAgentVersion: null,
  });
});

test('local host metadata skips requests when auth is unavailable', async () => {
  let requested = false;
  const metadata = await loadLocalHostMetadata({
    tokenProvider: () => null,
    fetcher: async () => {
      requested = true;
      return Response.json({});
    },
  });

  assert.equal(requested, false);
  assert.deepEqual(metadata, {
    localAgentVersion: null,
  });
});
