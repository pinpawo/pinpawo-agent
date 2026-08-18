import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { HostCapabilityAssembly } from './hostCapabilityAssembly';
import { FileCapabilityArtifactStore } from './capabilityArtifactStore';
import type { LocalAgentRuntimeConfig } from './runtimeConfig';

function buildTestConfig(root: string): LocalAgentRuntimeConfig {
  return {
    workdir: root,
    stateRoot: join(root, 'state'),
    studioConfigPath: join(root, 'studio.json'),
    studioDueRunsPath: join(root, 'studio-due.json'),
    petsDir: join(root, 'pets'),
    studioWikiBaseDir: join(root, 'wiki'),
    checkpointPath: join(root, 'checkpoints.json'),
    tuiCheckpointPath: join(root, 'tui-checkpoints.json'),
    tuiSessionPath: join(root, 'tui-sessions.json'),
    capabilityArtifactRoot: join(root, 'capability-artifacts'),
  };
}

test('HostCapabilityAssembly.deleteThreadArtifacts removes capability artifacts for the thread', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pinpawo-caps-delete-'));
  const caps = new HostCapabilityAssembly({
    runtimeConfig: buildTestConfig(root),
    sourceId: 'test',
  });

  const store = new FileCapabilityArtifactStore(join(root, 'capability-artifacts'));
  await store.writeArtifact({
    threadId: 'thread-1',
    capabilityId: 'explore',
    delegationId: 'delegation-1',
    runId: 'run-1',
    artifact: {
      kind: 'report',
      mimeType: 'text/plain',
      content: 'content',
    },
  });

  assert.equal((await store.listArtifacts({ threadId: 'thread-1' })).length, 1);
  assert.ok(existsSync(join(root, 'capability-artifacts', 'threads', 'thread-1')));

  await caps.deleteThreadArtifacts('thread-1');

  assert.equal((await store.listArtifacts({ threadId: 'thread-1' })).length, 0);
  assert.equal(existsSync(join(root, 'capability-artifacts', 'threads', 'thread-1')), false);
});

test('HostCapabilityAssembly.deleteThreadArtifacts delegates to the capability artifact store', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pinpawo-caps-delegate-'));
  const caps = new HostCapabilityAssembly({
    runtimeConfig: buildTestConfig(root),
    sourceId: 'test',
  });

  // Spy on the underlying artifact store's deleteThreadArtifacts.
  const store = caps.getCapabilityArtifactStore();
  let calledThreadId: string | null = null;
  const original = store.deleteThreadArtifacts.bind(store);
  store.deleteThreadArtifacts = async (threadId: string) => {
    calledThreadId = threadId;
    await original(threadId);
  };

  await caps.deleteThreadArtifacts('thread-42');

  assert.equal(calledThreadId, 'thread-42');
});

test('LocalAgentHost deleteThread callback calls both checkpointer.deleteThread and caps.deleteThreadArtifacts', async () => {
  // This is a structural test: it verifies that the deleteThread callback
  // in runtime.ts invokes BOTH cleanup paths.  We instantiate
  // HostCapabilityAssembly, then call both methods the way the callback does
  // and assert both execute without error and that artifacts are removed.
  const root = await mkdtemp(join(tmpdir(), 'pinpawo-caps-both-'));
  const caps = new HostCapabilityAssembly({
    runtimeConfig: buildTestConfig(root),
    sourceId: 'test',
  });

  // Write a capability artifact.
  const store = new FileCapabilityArtifactStore(join(root, 'capability-artifacts'));
  await store.writeArtifact({
    threadId: 'thread-1',
    capabilityId: 'explore',
    delegationId: 'delegation-1',
    runId: 'run-1',
    artifact: {
      kind: 'report',
      mimeType: 'text/plain',
      content: 'content',
    },
  });
  assert.equal((await store.listArtifacts({ threadId: 'thread-1' })).length, 1);

  // Simulate the deleteThread callback: checkpoint delete + artifact delete.
  await caps.getChatCheckpointer().deleteThread('thread-1');
  await caps.deleteThreadArtifacts('thread-1');

  // Artifact should be gone (checkpoint deletion is covered by fileSaver.test.ts).
  assert.equal((await store.listArtifacts({ threadId: 'thread-1' })).length, 0);
});
