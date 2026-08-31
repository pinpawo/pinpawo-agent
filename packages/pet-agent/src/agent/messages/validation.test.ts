import assert from 'node:assert/strict';
import test from 'node:test';
import { HumanMessage, RemoveMessage, SystemMessage } from '@langchain/core/messages';
import { messagesStateReducer, REMOVE_ALL_MESSAGES } from '@langchain/langgraph';
import {
  assertCanonicalAgentMessages,
  findCanonicalSystemMessage,
} from './validation';
import { buildOrchestratorRunInput } from '../orchestrator/state';
import { createPrepareNode } from '../orchestrator/runtime/nodes/prepare';
import type { OrchestratorStateType } from '../orchestrator/state';

test('canonical Agent history rejects SystemMessage authority', () => {
  const messages = [
    new HumanMessage('current request'),
    new SystemMessage('caller-owned instruction'),
  ];

  assert.equal(findCanonicalSystemMessage(messages)?.index, 1);
  assert.throws(
    () => assertCanonicalAgentMessages(messages),
    /must not contain a SystemMessage/,
  );
});

test('canonical Agent history accepts ordinary conversation messages', () => {
  assert.doesNotThrow(() => assertCanonicalAgentMessages([
    new HumanMessage('current request'),
  ]));
});

test('root ingress rejects caller-owned SystemMessage', () => {
  assert.throws(
    () => buildOrchestratorRunInput([new SystemMessage('caller policy')]),
    /must not contain a SystemMessage/,
  );
});

test('prepare fails closed and clears history when a checkpoint contains a SystemMessage', async () => {
  const checkpointMessages = [
    new HumanMessage('old request'),
    new SystemMessage('legacy checkpoint policy'),
  ];
  const result = await createPrepareNode()({
    messages: checkpointMessages,
  } as unknown as OrchestratorStateType);

  if (!('messages' in result)) {
    assert.fail('incompatible checkpoint must clear canonical messages');
  }
  const removals = result.messages ?? [];
  assert.equal(removals.length, 1);
  assert.ok(removals[0] instanceof RemoveMessage);
  assert.equal(removals[0]?.id, REMOVE_ALL_MESSAGES);
  assert.deepEqual(messagesStateReducer(checkpointMessages, removals), []);
  assert.deepEqual({ ...result, messages: undefined }, {
    messages: undefined,
    runNextDelegation: null,
    runPlannerSession: null,
    taskPlannerContinuation: null,
    runLatestDelegationOutcome: null,
    runRuntimeFailure: 'checkpoint_incompatible',
  });
});
