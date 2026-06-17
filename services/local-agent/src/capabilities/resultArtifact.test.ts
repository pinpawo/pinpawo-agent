import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, ToolMessage } from '@langchain/core/messages';
import { z } from 'zod';
import type {
  CapabilityArtifactRef,
  CapabilityArtifactStore,
  CapabilityArtifactWriteInput,
  CapabilityMiddlewareContext,
  SubagentResult,
} from '@pinpawo/pet-agent';
import { recordLatestToolResultArtifact } from './resultArtifact';

const schema = z.object({ status: z.string(), postId: z.string().nullable() });

function fakeStore(writes: CapabilityArtifactWriteInput[]): CapabilityArtifactStore {
  return {
    writeArtifact: async (input) => {
      writes.push(input);
      return {
        id: `artifact-${writes.length}`,
        threadId: input.threadId,
        capabilityId: input.capabilityId,
        delegationId: input.delegationId,
        turnId: input.turnId,
        kind: input.artifact.kind,
        mimeType: input.artifact.mimeType,
        uri: `capability-artifact://thread/${input.threadId}/delegation/${input.delegationId}/artifact/${writes.length}`,
        sizeBytes: 0,
        createdAt: new Date().toISOString(),
      } satisfies CapabilityArtifactRef;
    },
    readArtifact: async () => ({ ref: {} as CapabilityArtifactRef, content: null }),
    listArtifacts: async () => [],
    deleteThreadArtifacts: async () => {},
    getDownloadUri: async () => '',
  };
}

function ctx(recorded: CapabilityArtifactRef[]): CapabilityMiddlewareContext {
  return {
    recordCapabilityArtifact: (ref) => {
      recorded.push(ref);
    },
    threadId: 'thread-1',
    capabilityId: 'daily_post',
    delegationId: 'dg_1',
    turnId: 'turn_1',
  };
}

test('recordLatestToolResultArtifact persists the latest schema-valid tool artifact deterministically', async () => {
  const writes: CapabilityArtifactWriteInput[] = [];
  const recorded: CapabilityArtifactRef[] = [];
  const finalResult = { status: 'created', postId: 'post-1' };
  const result: SubagentResult = {
    completionReason: 'natural',
    artifacts: [],
    messages: [
      new AIMessage('thinking'),
      new ToolMessage({ content: 'saved', tool_call_id: 't1', artifact: finalResult }),
    ],
  };

  await recordLatestToolResultArtifact(result, ctx(recorded), {
    store: fakeStore(writes),
    schema,
    title: 'Daily post result',
    schemaName: 'DailyPostResult',
  });

  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.artifact.kind, 'result');
  assert.equal(writes[0]?.artifact.mimeType, 'application/json');
  assert.deepEqual(writes[0]?.artifact.content, finalResult);
  assert.equal(recorded.length, 1);
});

test('recordLatestToolResultArtifact no-ops when no tool artifact matches the schema', async () => {
  const writes: CapabilityArtifactWriteInput[] = [];
  const recorded: CapabilityArtifactRef[] = [];
  const result: SubagentResult = {
    completionReason: 'natural',
    artifacts: [],
    messages: [new AIMessage('only free text, model forgot to finalize')],
  };

  await recordLatestToolResultArtifact(result, ctx(recorded), {
    store: fakeStore(writes),
    schema,
    title: 'Daily post result',
    schemaName: 'DailyPostResult',
  });

  assert.equal(writes.length, 0);
  assert.equal(recorded.length, 0);
});

test('recordLatestToolResultArtifact no-ops without a store (degraded runtime)', async () => {
  const recorded: CapabilityArtifactRef[] = [];
  const result: SubagentResult = {
    completionReason: 'natural',
    artifacts: [],
    messages: [
      new ToolMessage({ content: 'saved', tool_call_id: 't1', artifact: { status: 'created', postId: 'post-1' } }),
    ],
  };

  const out = await recordLatestToolResultArtifact(result, ctx(recorded), {
    store: undefined,
    schema,
    title: 'Daily post result',
    schemaName: 'DailyPostResult',
  });

  assert.equal(recorded.length, 0);
  assert.equal(out, result);
});
