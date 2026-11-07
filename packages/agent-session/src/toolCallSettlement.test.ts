import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseAgentServerMessage,
  reduceSession,
  type AgentMessageEntry,
  type AgentRuntimeEvent,
  type AgentSession,
} from './index';

function toolMessage(id: string, requestId: string): AgentMessageEntry {
  return {
    id,
    type: 'message',
    role: 'assistant',
    text: '',
    status: 'completed',
    requestId,
    toolCalls: [{ id: 'reused-call', name: 'lookup', args: {}, status: 'running' }],
  };
}

function session(timeline: AgentMessageEntry[]): AgentSession {
  return { sessionId: 'chat:one', kind: 'chat', timeline, activeRun: null, pendingInterrupt: null };
}

function settle(live: AgentSession, messageId: string, callId = 'reused-call') {
  const event: AgentRuntimeEvent = {
    type: 'tool_call.settled', requestId: 'resumed-run', messageId, callId,
    status: 'failed', error: 'new failure',
  };
  const parsed = parseAgentServerMessage(JSON.stringify({ type: 'event', requestId: event.requestId, event }));
  assert.ok(parsed?.type === 'event');
  return reduceSession(live, { type: 'runtime.event', event: parsed.event }, { observedAt: 1_000 });
}

test('settlement scopes a reused call id to its owning message', () => {
  const old = toolMessage('old-call', 'old-run');
  old.toolCalls![0]!.status = 'completed';
  const current = toolMessage('new-call', 'current-run');

  const settled = settle(session([old, current]), 'new-call');

  assert.equal(settled.timeline[0], old);
  assert.deepEqual((settled.timeline[1] as AgentMessageEntry).toolCalls, [{
    id: 'reused-call', name: 'lookup', args: {}, status: 'failed', error: 'new failure',
  }]);
});

test('settlement can target a message from the run preceding review resume', () => {
  const pending = toolMessage('reviewed-call', 'original-run');
  const settled = settle(session([pending]), 'reviewed-call');

  assert.equal(settled.timeline[0]?.requestId, 'original-run');
  assert.equal((settled.timeline[0] as AgentMessageEntry).toolCalls?.[0]?.status, 'failed');
});

test('unknown or mismatched settlement identity leaves other calls unchanged', () => {
  const live = session([
    toolMessage('known-call', 'original-run'),
    { ...toolMessage('no-calls', 'original-run'), toolCalls: undefined },
  ]);

  for (const [messageId, callId] of [
    ['unknown-message', 'reused-call'],
    ['no-calls', 'reused-call'],
    ['known-call', 'unknown-call'],
  ]) {
    assert.equal(settle(live, messageId!, callId!), live);
  }
});
