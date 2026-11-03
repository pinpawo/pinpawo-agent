import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { FileArtifactStore } from './artifactStore';
import { CosArtifactStore } from './cosArtifactStore';
import { createHostArtifactStore } from './artifactStoreFactory';

test('local factory shares the workspaces root while retaining current-workspace inventory', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'pinpawo-artifact-factory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = createHostArtifactStore({ sessionRoot: join(root, 'first') }, { stored: {}, env: {} });
  const second = createHostArtifactStore({ sessionRoot: join(root, 'second') }, { stored: {}, env: {} });
  assert.ok(first instanceof FileArtifactStore);
  const ref = await first.put({ threadId: 'session:one', name: 'a.txt', mimeType: 'text/plain',
    body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('snapshot')); controller.close(); } }) });
  assert.match(ref.uri, /^artifact:\/\/first\//);
  assert.deepEqual(await second.list('session:one'), []);
  const fetched = await second.fetch(ref.uri);
  assert.ok('body' in fetched);
  assert.equal(await new Response(fetched.body).text(), 'snapshot');
});

test('factory chooses COS from global settings or explicit environment without exposing credentials in errors', () => {
  const runtime = { sessionRoot: '/tmp/workspaces/workspace' };
  const cos = { adapter: 'cos' as const, bucket: 'bucket-1', region: 'ap-test', secretId: 'dummy-id', secretKey: 'dummy-key' };
  assert.ok(createHostArtifactStore(runtime, { stored: { artifacts: cos }, env: {} }) instanceof CosArtifactStore);
  assert.ok(createHostArtifactStore(runtime, { stored: { artifacts: cos }, env: { PINPAWO_ARTIFACTS_ADAPTER: 'local' } }) instanceof FileArtifactStore);
  assert.ok(createHostArtifactStore(runtime, { stored: {}, env: {
    PINPAWO_ARTIFACTS_ADAPTER: 'cos', PINPAWO_ARTIFACTS_COS_BUCKET: 'bucket-1', PINPAWO_ARTIFACTS_COS_REGION: 'ap-test',
    PINPAWO_ARTIFACTS_COS_SECRET_ID: 'dummy-id', PINPAWO_ARTIFACTS_COS_SECRET_KEY: 'dummy-key',
  } }) instanceof CosArtifactStore);
  assert.throws(() => createHostArtifactStore(runtime, { stored: {}, env: { PINPAWO_ARTIFACTS_ADAPTER: 'unknown' } }), /local or cos/);
  assert.throws(() => createHostArtifactStore(runtime, { stored: {}, env: { PINPAWO_ARTIFACTS_ADAPTER: 'cos' } }), /require bucket/);
  const malformed = JSON.parse('{"adapter":"cos","bucket":123,"region":"ap-test","secretId":"dummy-id","secretKey":"dummy-key"}');
  assert.throws(() => createHostArtifactStore(runtime, { stored: { artifacts: malformed }, env: {} }),
    error => error instanceof Error && /bucket must be a string/.test(error.message)
      && !/123|dummy/.test(error.message));
});
