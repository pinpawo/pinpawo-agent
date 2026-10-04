import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Annotation, END, START, StateGraph, interrupt } from '@langchain/langgraph';
import { createOrchestratorGraph, UnknownInterruptPayloadError } from '@pinpawo/pet-agent';
import { FakeToolCallingModel } from 'langchain';
import { FileSaver } from 'pinpawo/host-runtime';

test('an unknown stored interrupt is rejected before graph reconstruction without changing its checkpoint', async () => {
  const root = await mkdtemp(join(tmpdir(), 'unsupported-interrupt-'));
  const checkpointer = new FileSaver(join(root, 'checkpoints'));
  const config = { configurable: { thread_id: 'unknown-interrupt' } };
  try {
    const source = new StateGraph(Annotation.Root({ note: Annotation<string>() }))
      .addNode('unknownGate', () => { interrupt({ kind: 'unsupported_review' }); return {}; })
      .addEdge(START, 'unknownGate').addEdge('unknownGate', END).compile({ checkpointer });
    await source.invoke({ note: 'Unexecuted reviewed action.' }, config);
    const original = await checkpointer.getTuple(config);
    const model = new FakeToolCallingModel({ toolCalls: [] });
    const graph = createOrchestratorGraph({ models: { act: model }, checkpoint: checkpointer });
    await assert.rejects(graph.getState(config), UnknownInterruptPayloadError);
    await assert.rejects(graph.invoke({}, config), UnknownInterruptPayloadError);
    assert.deepEqual(await checkpointer.getTuple(config), original);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
