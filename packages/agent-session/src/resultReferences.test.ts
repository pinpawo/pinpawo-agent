import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAgentServerMessage, parseAgentSessionSnapshot, createAgentSessionSnapshot, reduceSession, type AgentSession } from './index';

test('completed reply evidence round-trips over the wire, reducer, and checkpoint snapshot', () => {
  const refs = [{ id: 'delivery', title: 'Read files', text: 'Detailed evidence' }];
  const wire = { type: 'event', requestId: 'run', event: { type: 'message.completed',
    requestId: 'run', messageId: 'reply', role: 'assistant', text: 'Done', resultReferences: refs } };
  const parsed = parseAgentServerMessage(JSON.parse(JSON.stringify(wire)));
  assert.deepEqual(parsed, wire);
  assert.equal(parsed?.type, 'event');
  if (parsed?.type !== 'event') throw new Error('missing event');
  const initial: AgentSession = { sessionId: 'test', kind: 'chat', timeline: [],
    activeRun: { requestId: 'run', state: 'running', activity: 'streaming' }, pendingInterrupt: null };
  const completed = reduceSession(initial, { type: 'runtime.event', event: parsed.event }, { observedAt: 1 });
  const reply = completed.timeline.at(-1);
  assert.equal(reply?.type, 'message');
  if (reply?.type !== 'message') throw new Error('missing reply');
  assert.equal(reply.text, 'Done');
  assert.deepEqual(reply.resultReferences, refs);
  refs[0]!.text = 'mutated';
  assert.equal(reply.resultReferences?.[0]?.text, 'Detailed evidence');
  const snapshot = createAgentSessionSnapshot(completed);
  assert.deepEqual(parseAgentSessionSnapshot(JSON.parse(JSON.stringify(snapshot))), snapshot);
});
