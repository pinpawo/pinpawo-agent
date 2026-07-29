import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  startLocalServer,
  type LocalServerDeps,
} from './localServer';
import { buildLocalAgentRuntimeConfig } from './runtimeConfig';
import { createTestModelServerDeps } from './testing/modelProfiles';

test('local server close is idempotent and releases its listening port', async () => {
  const workdir = mkdtempSync(join(tmpdir(), 'pinpawo-local-server-'));
  const deps = createDeps(workdir);
  const first = await startLocalServer(0, deps, {
    authToken: 'local-server-lifecycle-token',
  });

  try {
    assert.ok(first.port > 0);
    first.close();
    first.close();
    await first.closed;

    const restarted = await startLocalServer(first.port, deps, {
      authToken: 'local-server-lifecycle-token',
    });
    try {
      assert.equal(restarted.port, first.port);
    } finally {
      restarted.close();
      await restarted.closed;
    }
  } finally {
    first.close();
    await first.closed;
    rmSync(workdir, { recursive: true, force: true });
  }
});

function createDeps(workdir: string): LocalServerDeps {
  return {
    actorId: 'pet-local-server-lifecycle',
    workdir,
    runtimeConfig: buildLocalAgentRuntimeConfig(workdir),
    ...createTestModelServerDeps({
      model: 'offline-lifecycle-model',
      apiKey: 'offline-lifecycle-key',
      baseUrl: 'http://127.0.0.1:1/v1',
    }),
  };
}
