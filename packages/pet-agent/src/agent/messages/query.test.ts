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

test('query assigns canonical messages to named sources in original chronology', () => {
  const mainBefore = new HumanMessage({ id: 'main-before', content: 'goal' });
  const delegation = setAgentMessageDelegationScope(
    new AIMessage({ id: 'delegation', content: 'result' }),
    scope,
  );
  const mainAfter = new HumanMessage({ id: 'main-after', content: 'continue' });

  const result = queryAgentMessages([mainBefore, delegation, mainAfter], [
    { id: 'main', kind: 'main' },
    { id: 'current', kind: 'delegation', scope, visibility: 'transcript' },
  ]);

  assert.deepEqual(result.selected.map(({ message }) => message), [
    mainBefore,
    delegation,
    mainAfter,
  ]);
  assert.deepEqual(result.selected.map(({ source }) => source.id), [
    'main',
    'current',
    'main',
  ]);
});

test('query explains every canonical exclusion without copying message content', () => {
  const invocationOnly = setAgentMessageMetadata(
    new AIMessage({ id: 'invocation', content: 'briefing' }),
    { persistence: 'invocation' },
  );
  const rawCurrent = setAgentMessageDelegationScope(
    new AIMessage({ id: 'raw-current', content: 'private transcript' }),
    scope,
  );
  const otherDelegation = setAgentMessageDelegationScope(
    new AIMessage({ id: 'other', content: 'other transcript' }),
    { ...scope, delegationId: 'delegation-2' },
  );
  const legacyInternal = setAgentMessageMetadata(
    new AIMessage({ id: 'legacy', content: 'legacy internal' }),
    { lane: 'orchestrator' },
  );

  const result = queryAgentMessages(
    [invocationOnly, rawCurrent, otherDelegation, legacyInternal],
    [
      { id: 'main', kind: 'main' },
      { id: 'current', kind: 'delegation', scope, visibility: 'announces_only' },
    ],
  );

  assert.deepEqual(result.excluded.map(({ message, reason }) => ({
    messageId: message.id,
    reason,
  })), [
    { messageId: 'invocation', reason: 'invocation_only' },
    { messageId: 'raw-current', reason: 'not_announce' },
    { messageId: 'other', reason: 'scope_mismatch' },
    { messageId: 'legacy', reason: 'unsupported_lane' },
  ]);
});

test('query rejects ambiguous source definitions at its own boundary', () => {
  assert.throws(
    () => queryAgentMessages([], [
      { id: 'main-a', kind: 'main' },
      { id: 'main-b', kind: 'main' },
    ]),
    /at most one main source/,
  );
  assert.throws(
    () => queryAgentMessages([], [
      { id: 'duplicate', kind: 'main' },
      { id: 'duplicate', kind: 'delegation', scope, visibility: 'transcript' },
    ]),
    /source ids must be unique/,
  );
});
