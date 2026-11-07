import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createAgentSessionSnapshot, parseAgentServerMessage, parseAgentSessionSnapshot, reduceSession,
  type AgentSession,
} from './index';

const initial = (): AgentSession => ({ sessionId: 'test', kind: 'chat', timeline: [],
  activeRun: { requestId: 'run', state: 'running', activity: 'streaming' }, pendingInterrupt: null });

const completed = (deliverables: unknown) => ({ type: 'event', requestId: 'run', event: {
  type: 'message.completed', requestId: 'run', messageId: 'reply', role: 'assistant', text: 'Done', deliverables,
} });

test('declared deliverables survive the wire, reducer and snapshot independently of reply text', () => {
  const deliverables = [{ uri: 'artifact://workspace/session/report/report.pdf', title: 'Report' },
    { uri: 'https://github.com/example/project/pull/1' }];
  const wire = completed(deliverables);
  const parsed = parseAgentServerMessage(JSON.parse(JSON.stringify(wire)));
  assert.deepEqual(parsed, wire);
  if (parsed?.type !== 'event') throw new Error('missing event');
  const session = reduceSession(initial(), { type: 'runtime.event', event: parsed.event }, { observedAt: 1 });
  const reply = session.timeline.at(-1);
  if (reply?.type !== 'message') throw new Error('missing reply');
  assert.equal(reply.text, 'Done');
  assert.deepEqual(reply.deliverables, deliverables);
  if (parsed.event.type !== 'message.completed') throw new Error('missing completion');
  parsed.event.deliverables![0]!.title = 'Changed source event';
  assert.equal(reply.deliverables![0]!.title, 'Report');
  const snapshot = createAgentSessionSnapshot(session);
  assert.deepEqual(parseAgentSessionSnapshot(JSON.parse(JSON.stringify(snapshot))), snapshot);
});

test('malformed declarations reject wire messages and snapshots instead of silently dropping references', () => {
  for (const deliverables of [null, {}, [{ uri: '' }], [{ uri: 5 }], [{ uri: 'https://example.com', title: 5 }]]) {
    assert.equal(parseAgentServerMessage(completed(deliverables)), null);
    const session = initial();
    const snapshot = { version: createAgentSessionSnapshot(session).version, session: { ...session, timeline: [
      { id: 'reply', type: 'message', role: 'assistant', text: 'Done', status: 'completed', deliverables },
    ] } };
    assert.equal(parseAgentSessionSnapshot(snapshot), null);
  }
});
