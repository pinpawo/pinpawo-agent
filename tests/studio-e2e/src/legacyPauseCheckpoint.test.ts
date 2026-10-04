import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Annotation, END, START, StateGraph, interrupt } from '@langchain/langgraph';
import { createOrchestratorGraph } from '@pinpawo/pet-agent';
import { FakeToolCallingModel } from 'langchain';
import { buildHostRuntimeConfig, createResidentPetHost, FileSaver } from 'pinpawo/host-runtime';
import { createTestModelProfiles } from '../../../services/host/src/testing/modelProfiles';
import { HostToolkitInventoryStore } from '../../../services/host/src/toolkits/toolkitInventory';

test('rebuilding the graph refuses a stored legacy pause and preserves its checkpoint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'old-pause-checkpoint-'));
  const checkpointer = new FileSaver(join(root, 'checkpoints'));
  const config = { configurable: { thread_id: 'one:12345678' } };
  try {
    const old = new StateGraph(Annotation.Root({ note: Annotation<string>() }))
      .addNode('pauseGate', () => { interrupt({ kind: 'pause_task' }); return {}; })
      .addEdge(START, 'pauseGate').addEdge('pauseGate', END).compile({ checkpointer });
    await old.invoke({ note: 'Unexecuted reviewed action.' }, config);
    const original = await checkpointer.getTuple(config);
    const model = new FakeToolCallingModel({ toolCalls: [] });
    const rebuilt = createOrchestratorGraph({ models: { act: model }, checkpoint: checkpointer });
    await assert.rejects(rebuilt.getState(config), /Start a new session.*preserved/);
    await assert.rejects(rebuilt.invoke({}, config), /Start a new session.*preserved/);
    assert.deepEqual(await checkpointer.getTuple(config), original);
    const runtimeConfig = buildHostRuntimeConfig(root);
    const host = await createResidentPetHost({ petId: 'one', petName: 'One', runtimeConfig,
      modelProfiles: createTestModelProfiles(), globalReviewPolicyMode: 'require_authorization', autoAuthorizationSafetyLevel: 'strict',
      capabilities: [], toolkitInventory: new HostToolkitInventoryStore(), checkpointer, adoptThreadId: config.configurable.thread_id,
      sessionStatePath: runtimeConfig.tuiSessionPath,
      capabilityArtifactStore: { writeArtifact: async () => { throw Error('unused'); }, readArtifact: async () => { throw Error('unused'); },
        listArtifacts: async () => [], deleteThreadArtifacts: async () => {}, getDownloadUri: async uri => uri },
    });
    try {
      assert.equal(host.resident.dispatch.getQueueSnapshot().state, 'blocked');
      const unsupported = await host.interaction.snapshot();
      assert.equal(unsupported.type, 'session.error');
      assert.ok(JSON.stringify(unsupported).includes('Start a new session'));
      assert.ok(JSON.stringify(unsupported).includes('preserved'));
      await host.interaction.request({ type: 'session.new', requestId: 'new-session' });
      const snapshot = await host.interaction.snapshot();
      if (snapshot.type !== 'session.snapshot.result') throw Error('snapshot');
      assert.notEqual(snapshot.snapshot.session.sessionId, config.configurable.thread_id);
      assert.equal(snapshot.snapshot.session.pendingInterrupt, null);
      assert.deepEqual(await checkpointer.getTuple(config), original);
    } finally { await host.close(); }

  } finally { await rm(root, { recursive: true, force: true }); }
});


test('legacy pause state without a native interrupt is refused without clearing its unexecuted action', async () => {
  const root = await mkdtemp(join(tmpdir(), 'old-pause-state-'));
  const checkpointer = new FileSaver(join(root, 'checkpoints'));
  const config = { configurable: { thread_id: 'old-state' } };
  try {
    const old = new StateGraph(Annotation.Root({ taskPauseInterrupt: Annotation<{ kind: string }>() }))
      .addNode('stop', () => ({ taskPauseInterrupt: { kind: 'pause_task' } }))
      .addEdge(START, 'stop').addEdge('stop', END).compile({ checkpointer });
    await old.invoke({}, config);
    const original = await checkpointer.getTuple(config);
    const model = new FakeToolCallingModel({ toolCalls: [] });
    const rebuilt = createOrchestratorGraph({ models: { act: model }, checkpoint: checkpointer });
    await assert.rejects(rebuilt.getState(config), /Start a new session.*preserved/);
    await assert.rejects(rebuilt.invoke({}, config), /Start a new session.*preserved/);
    assert.deepEqual(await checkpointer.getTuple(config), original);
  } finally { await rm(root, { recursive: true, force: true }); }
});
