import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { setAgentMessageDelegationScope, setAgentMessageMetadata } from './metadata';
import { queryAgentMessages } from './query';

const scope = {
  lane: 'capability:general' as const,
  runId: 'run-1',
  delegationId: 'delegation-1',
};

test('query chains main and an exact delegation while preserving chronology', () => {
  const mainBefore = new HumanMessage({ id: 'main-before', content: 'goal' });
  const delegation = setAgentMessageDelegationScope(
    new AIMessage({ id: 'delegation', content: 'result' }),
    scope,
  );
  const mainAfter = new HumanMessage({ id: 'main-after', content: 'continue' });

  const selection = queryAgentMessages([mainBefore, delegation, mainAfter])
    .main()
    .delegation(scope)
    .select();

  assert.deepEqual(selection.messages, [mainBefore, delegation, mainAfter]);
  assert.deepEqual(selection.diagnostics.selectedMessageIds, [
    'main-before',
    'delegation',
    'main-after',
  ]);
});

test('query is immutable and only selects explicitly requested sources', () => {
  const main = new HumanMessage({ id: 'main', content: 'goal' });
  const delegation = setAgentMessageDelegationScope(
    new AIMessage({ id: 'delegation', content: 'result' }),
    scope,
  );
  const base = queryAgentMessages([main, delegation]);
  const mainQuery = base.main();

  assert.deepEqual(base.select().messages, []);
  assert.deepEqual(mainQuery.select().messages, [main]);
  assert.deepEqual(
    mainQuery.delegation(scope).select().messages,
    [main, delegation],
  );
});

test('query is bound to the canonical snapshot captured at creation', () => {
  const first = new HumanMessage({ id: 'first', content: 'first' });
  const later = new HumanMessage({ id: 'later', content: 'later' });
  const canonical = [first];
  const query = queryAgentMessages(canonical).main();

  canonical.push(later);

  assert.deepEqual(query.select().messages, [first]);
});

test('query appends invocation-only messages without changing canonical selection diagnostics', () => {
  const main = new HumanMessage({ id: 'main', content: 'goal' });
  const current = new HumanMessage({ id: 'current', content: 'current input' });
  const query = queryAgentMessages([main]).main();

  const selection = query.append(current).select();

  assert.deepEqual(selection.messages, [main, current]);
  assert.deepEqual(selection.diagnostics.selectedMessageIds, ['main']);
  assert.deepEqual(query.select().messages, [main]);
});

test('query explains exclusions without copying message content', () => {
  const current = setAgentMessageDelegationScope(
    new AIMessage({ id: 'current', content: 'current private message' }),
    scope,
  );
  const other = setAgentMessageDelegationScope(
    new AIMessage({ id: 'other', content: 'other private message' }),
    { ...scope, delegationId: 'delegation-2' },
  );
  const unsupported = setAgentMessageMetadata(
    new AIMessage({ id: 'unsupported', content: 'legacy internal' }),
    { lane: 'orchestrator' },
  );

  const selection = queryAgentMessages([current, other, unsupported])
    .delegation(scope)
    .select();

  assert.deepEqual(selection.messages, [current]);
  assert.deepEqual(selection.diagnostics.excluded, [
    { messageId: 'other', reason: 'scope_mismatch' },
    { messageId: 'unsupported', reason: 'unsupported_lane' },
  ]);
});

test('query rejects a capability lane message with an incomplete scope', () => {
  const invalid = setAgentMessageMetadata(
    new AIMessage({ id: 'invalid', content: 'result' }),
    { lane: scope.lane },
  );

  assert.throws(
    () => queryAgentMessages([invalid]).delegation(scope).select(),
    /missing delegationId or another part of its complete scope/,
  );
});

test('Supervisor working history is run-scoped without changing main or Capability ownership', () => {
  const main = new HumanMessage({ id: 'user', content: 'request' });
  const control = setAgentMessageMetadata(new AIMessage({ id: 'control', content: '',
    tool_calls: [{ id: 'c1', name: 'submit_plan', args: {} }],
  }), { lane: 'supervisor', runId: 'run-1' });
  const confirmation = setAgentMessageMetadata(new ToolMessage({ id: 'confirmation',
    content: 'submitted', tool_call_id: 'c1', name: 'submit_plan',
  }), { lane: 'supervisor', runId: 'run-1' });
  const nextRun = setAgentMessageMetadata(new AIMessage({ id: 'next-run', content: 'working' }),
    { lane: 'supervisor', runId: 'run-2' });
  const privateMessage = setAgentMessageDelegationScope(new AIMessage({ id: 'private', content: 'private' }), scope);
  const canonical = [main, control, confirmation, privateMessage, nextRun];
  const query = queryAgentMessages(canonical);
  assert.deepEqual(query.main().select().messages, [main]);
  assert.deepEqual(query.main().delegation(scope).select().messages, [main, privateMessage]);
  assert.deepEqual(query.main().supervisor('run-1').select().messages, [main, control, confirmation]);
  assert.deepEqual(query.main().supervisor('run-2').select().messages, [main, nextRun]);
  assert.deepEqual(query.select().messages, []);
  assert.equal(canonical.length, 5, 'resetting the work view must not delete canonical history');
  assert.throws(() => query.supervisor(''), /run id/);
});

test('Supervisor messages cannot fall back to main when their run identity is missing', () => {
  const message = setAgentMessageMetadata(new AIMessage({ content: 'private' }), { lane: 'supervisor' });
  assert.throws(() => queryAgentMessages([message]).main().select(), /missing its run id/);
});
