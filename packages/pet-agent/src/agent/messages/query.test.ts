import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import { setAgentMessageDelegationScope, setAgentMessageMetadata } from './metadata';
import { queryAgentMessages } from './query';

const scope = {
  lane: 'capability:general' as const,
  transcriptRunId: 'run-1',
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

test('query explains exclusions without copying message content', () => {
  const current = setAgentMessageDelegationScope(
    new AIMessage({ id: 'current', content: 'private transcript' }),
    scope,
  );
  const other = setAgentMessageDelegationScope(
    new AIMessage({ id: 'other', content: 'other transcript' }),
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
