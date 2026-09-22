import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { messagesStateReducer } from '@langchain/langgraph';
import { setAgentMessageMetadata } from '../../messages';
import { removeLegacyCapabilityMessages, restoreCapabilityState } from './state';

const scope = { lane: 'capability:general' as const, runId: 'run', taskId: 'task', delegationId: 'delegation' };

test('legacy migration extracts only the current scope and removes private messages from Root', () => {
  const main = new HumanMessage({ id: 'user', content: 'Inspect' });
  const work = setAgentMessageMetadata(new AIMessage({ id: 'work', content: 'Private work' }), scope);
  const foreign = setAgentMessageMetadata(new AIMessage({ id: 'foreign', content: 'Foreign work' }), { ...scope, delegationId: 'other' });
  const delivery = new ToolMessage({ id: 'delivery', content: 'Result', tool_call_id: 'delegate', name: 'delegate_capability' });
  const supervisor = setAgentMessageMetadata(new AIMessage({ id: 'supervisor', content: 'Plan' }), { lane: 'supervisor' });
  const messages = [main, work, foreign, delivery, supervisor];
  assert.deepEqual(restoreCapabilityState(null, messages, scope).messages, [work]);
  assert.deepEqual(messagesStateReducer(messages, removeLegacyCapabilityMessages(messages)), [main, delivery, supervisor]);
});

test('explicit private state never falls back to legacy messages, including mismatched and empty state', () => {
  const legacy = setAgentMessageMetadata(new AIMessage({ id: 'old', content: 'Stale work' }), scope);
  for (const savedScope of [scope, { ...scope, delegationId: 'other' }]) {
    assert.deepEqual(restoreCapabilityState({ scope: savedScope, messages: [] }, [legacy], scope).messages, []);
  }
});
