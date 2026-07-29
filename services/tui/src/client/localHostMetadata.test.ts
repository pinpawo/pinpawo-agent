import assert from 'node:assert/strict';
import test from 'node:test';
import { loadLocalHostMetadata } from './localHostMetadata';

test('local host metadata reads version and enabled loaded capabilities', async () => {
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
      if (url.endsWith('/runtime')) {
        return Response.json({
          local_agent_version: '0.2.0',
        });
      }
      return Response.json({
        builtIns: [{
          id: 'explore',
          enabled: true,
          loaded: true,
          routability: { status: 'requires_scope' },
        }, {
          id: 'browser',
          enabled: true,
          loaded: true,
          routability: { status: 'unavailable' },
        }, {
          id: 'daily_post',
          enabled: false,
          loaded: true,
        }],
        userCapabilities: [{
          id: 'custom_writer',
          enabled: true,
          loaded: true,
        }, {
          id: 'draft_only',
          enabled: true,
          loaded: false,
        }],
      });
    },
  });

  assert.deepEqual(metadata, {
    localAgentVersion: '0.2.0',
    capabilities: ['general', 'explore', 'browser', 'custom_writer'],
  });
  assert.deepEqual(requests, [{
    url: 'http://127.0.0.1:4321/runtime',
    authorization: 'Bearer secret',
  }, {
    url: 'http://127.0.0.1:4321/capabilities',
    authorization: 'Bearer secret',
  }]);
});

test('local host metadata degrades each endpoint independently', async () => {
  const metadata = await loadLocalHostMetadata({
    tokenProvider: () => 'secret',
    fetcher: async (input) => {
      if (String(input).endsWith('/runtime')) {
        throw new Error('runtime unavailable');
      }
      return Response.json({
        builtIns: [{
          id: 'explore',
          enabled: true,
          loaded: true,
        }],
        userCapabilities: [],
      });
    },
  });

  assert.deepEqual(metadata, {
    localAgentVersion: null,
    capabilities: ['general', 'explore'],
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
    capabilities: [],
  });
});
