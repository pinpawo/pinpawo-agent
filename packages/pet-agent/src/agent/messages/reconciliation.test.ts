import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { messagesStateReducer } from '@langchain/langgraph';
import { queryAgentMessages, reconcileDelegationMessages, setAgentMessageDelegationScope } from './index';

const scope = { lane: 'capability:general' as const, runId: 'run-1', delegationId: 'task-1' };

test('private summary replacement removes only superseded messages in its exact scope', () => {
  const main = new HumanMessage({ id: 'main', content: 'Original request' });
  const own = setAgentMessageDelegationScope(new AIMessage({ id: 'own', content: 'Long private history' }), scope);
  const foreign = setAgentMessageDelegationScope(new AIMessage({ id: 'foreign', content: 'Other task' }), { ...scope, delegationId: 'task-2' });
  const older = setAgentMessageDelegationScope(new AIMessage({ id: 'older', content: 'Older run' }), { ...scope, runId: 'run-0' });
  const summary = new HumanMessage({ id: 'summary', content: 'Private summary' });
  const answer = new AIMessage({ id: 'answer', content: 'Result' });
  const stored = [main, own, foreign, older];
  const patch = reconcileDelegationMessages({
    inputMessages: [main, own], canonicalInputMessages: stored, resultMessages: [summary, answer], scope,
  });
  assert.deepEqual(patch.removed.map(({ id }) => id), ['own']);
  const next = messagesStateReducer(stored, [...patch.removed, ...patch.added]);
  assert.deepEqual(queryAgentMessages(next).main().select().messages, [main]);
  assert.ok(next.includes(foreign));
  assert.ok(next.includes(older));
  assert.deepEqual(queryAgentMessages(next).delegation(scope).select().messages, [summary, answer]);
});

test('private reconciliation retains completed tool pairs and excludes an unanswered new call', () => {
  const input = new HumanMessage({ id: 'main', content: 'Do the work' });
  const call = new AIMessage({ id: 'call', content: '', tool_calls: [{ id: 'completed', name: 'check', args: {} }] });
  const result = new ToolMessage({ id: 'result', tool_call_id: 'completed', content: 'Verified' });
  const pending = new AIMessage({ id: 'pending', content: '', tool_calls: [{ id: 'unanswered', name: 'check', args: {} }] });
  const patch = reconcileDelegationMessages({ inputMessages: [input], resultMessages: [input, call, result, pending], scope });
  assert.deepEqual(patch.removed, []);
  assert.deepEqual(patch.added, [call, result]);
  assert.deepEqual(queryAgentMessages(patch.added).main().select().messages, []);
});
