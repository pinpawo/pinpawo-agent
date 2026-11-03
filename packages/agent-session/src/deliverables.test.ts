import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentSessionSnapshot, parseAgentServerMessage, parseAgentSessionSnapshot, parseDeliverables, reduceSession, type AgentSession } from './index';

test('public deliverables survive wire, session projection, copy, and snapshot without altering prose', () => {
  const references = [{ uri: 'artifact://workspace/report', title: 'Report' }, { uri: 'https://example.com/pull/1' }];
  const wire = { type: 'event', requestId: 'run', event: { type: 'message.completed',
    requestId: 'run', messageId: 'reply', role: 'assistant', text: 'Done.', deliverables: references } };
  const parsed = parseAgentServerMessage(JSON.parse(JSON.stringify(wire)));
  assert.deepEqual(parsed, wire);
  assert.equal(parsed?.type, 'event');
  if (parsed?.type !== 'event') assert.fail('Missing completion event.');
  const session: AgentSession = { sessionId: 'test', kind: 'chat', timeline: [],
    activeRun: { requestId: 'run', state: 'running', activity: 'streaming' }, pendingInterrupt: null };
  const completed = reduceSession(session, { type: 'runtime.event', event: parsed.event }, { observedAt: 1 });
  const reply = completed.timeline.at(-1);
  assert.equal(reply?.type, 'message');
  if (reply?.type !== 'message') assert.fail('Missing reply.');
  assert.equal(reply.text, 'Done.');
  assert.deepEqual(reply.deliverables, references);
  references[0]!.title = 'Changed';
  assert.equal(reply.deliverables?.[0]?.title, 'Report');
  const snapshot = createAgentSessionSnapshot(completed);
  assert.deepEqual(parseAgentSessionSnapshot(JSON.parse(JSON.stringify(snapshot))), snapshot);
});

test('public deliverable parser preserves empty lists and rejects malformed references', () => {
  assert.deepEqual(parseDeliverables([]), []);
  for (const value of [undefined, null, {}, [null], [{ uri: '' }], [{ uri: 'https://example.com', title: 1 }]]) {
    assert.equal(parseDeliverables(value), undefined);
  }
});
