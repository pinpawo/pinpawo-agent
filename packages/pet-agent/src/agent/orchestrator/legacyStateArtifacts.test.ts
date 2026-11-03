import assert from 'node:assert/strict';
import test from 'node:test';
import { HumanMessage } from '@langchain/core/messages';
import { END, MemorySaver, START, StateGraph } from '@langchain/langgraph';
import type { CapabilityArtifactRef } from '../../types/artifact';
import { OrchestratorState, type OrchestratorStateType } from './state';

test('legacy session refs survive graph reconstruction and subsequent checkpoints without a new artifact write', async () => {
  const checkpointer = new MemorySaver();
  const config = { configurable: { thread_id: 'legacy-artifact-checkpoint' } };
  const ref: CapabilityArtifactRef = { id: 'legacy-ref', threadId: config.configurable.thread_id,
    capabilityId: 'general', delegationId: 'legacy-delegation', runId: 'legacy-run', kind: 'report',
    mimeType: 'text/plain', uri: 'capability-artifact://thread/legacy/delegation/old/artifact/report',
    sizeBytes: 5, createdAt: '2026-01-01T00:00:00Z' };
  const graph = () => new StateGraph(OrchestratorState)
    .addNode('advance', (state: OrchestratorStateType) => ({ runIterationCount: state.runIterationCount + 1 }))
    .addEdge(START, 'advance').addEdge('advance', END).compile({ checkpointer });

  await graph().invoke({ messages: [new HumanMessage('Legacy task.')], sessionCapabilityArtifacts: [ref] }, config);
  const before = await checkpointer.getTuple(config);
  assert.deepEqual(before?.checkpoint.channel_values.sessionCapabilityArtifacts, [ref]);
  const rebuilt = graph();
  await rebuilt.invoke({ messages: [new HumanMessage('Continue without publishing.')] }, config);
  const after = await checkpointer.getTuple(config);
  assert.notEqual(after?.checkpoint.id, before?.checkpoint.id);
  assert.deepEqual(after?.checkpoint.channel_values.sessionCapabilityArtifacts, [ref]);
  assert.deepEqual((await rebuilt.getState(config)).values.sessionCapabilityArtifacts, [ref]);
});
