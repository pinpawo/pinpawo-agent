import assert from 'node:assert/strict';
import test from 'node:test';
import {
  agentErrorEvent,
  agentNoticeToText,
  agentSystemNoticeEvent,
  parseAgentNotice,
  parseAgentServerMessage,
  parseAgentSessionSnapshot,
  createAgentSessionSnapshot,
  reduceSession,
  renderAgentNotice,
  type AgentSession,
} from './index';

function runningSession(): AgentSession {
  return {
    sessionId: 'chat:pet',
    kind: 'chat',
    timeline: [],
    activeRun: { requestId: 'req-1', state: 'running', activity: 'thinking', startedAt: 0, updatedAt: 0 },
    pendingInterrupt: null,
  };
}

test('a notice event sends its code and params with the default text as message', () => {
  assert.deepEqual(agentErrorEvent('req-1', { code: 'client_message_unsupported', params: { messageType: 'x' } }), {
    type: 'error',
    requestId: 'req-1',
    message: 'Message type "x" is not supported by this Host transport.',
    code: 'client_message_unsupported',
    params: { messageType: 'x' },
  });
  assert.deepEqual(agentSystemNoticeEvent('req-1', { code: 'review_pending_input_not_sent' }), {
    type: 'system.notice',
    requestId: 'req-1',
    message: agentNoticeToText({ code: 'review_pending_input_not_sent' }),
    code: 'review_pending_input_not_sent',
  });
});

test('received notices keep known codes and fall back to the message otherwise', () => {
  const event = agentErrorEvent('req-1', {
    code: 'agent_unavailable',
    params: { cause: 'model_quota', retryAt: '08-20 23:43 UTC', detail: 'quota exhausted' },
  });
  assert.deepEqual(parseAgentServerMessage({ type: 'event', requestId: 'req-1', event }), {
    type: 'event', requestId: 'req-1', event,
  });

  // A newer Host's code, or params that do not match a known code, leave the
  // default text alone.
  for (const unknown of [
    { code: 'from_a_newer_host' },
    { code: 'agent_unavailable', params: { cause: 'tired', detail: 'x' } },
    { code: 'interrupt_closed', params: { extra: 'x' } },
    // A system notice code is not an error code.
    { code: 'review_pending_input_not_sent' },
  ]) {
    assert.deepEqual(parseAgentServerMessage({
      type: 'event',
      requestId: 'req-1',
      event: { type: 'error', requestId: 'req-1', message: 'default text', ...unknown },
    }), {
      type: 'event',
      requestId: 'req-1',
      event: { type: 'error', requestId: 'req-1', message: 'default text' },
    });
  }
  assert.equal(parseAgentNotice({ code: 'tool_authorized_for_session', params: {} })?.code, 'tool_authorized_for_session');
});

test('session and runtime config errors carry notices too', () => {
  assert.deepEqual(parseAgentServerMessage({
    type: 'session.error', requestId: 'r', operation: 'new', message: 'wait', code: 'run_in_flight',
  }), { type: 'session.error', requestId: 'r', operation: 'new', message: 'wait', code: 'run_in_flight' });
  assert.deepEqual(parseAgentServerMessage({
    type: 'runtime_config.error', requestId: 'r', message: 'bad', code: 'client_message_invalid',
  }), { type: 'runtime_config.error', requestId: 'r', message: 'bad', code: 'client_message_invalid' });
});

test('the timeline keeps a notice beside its default text and snapshots carry it', () => {
  const event = agentSystemNoticeEvent('req-1', { code: 'tool_authorized_for_session', params: { toolName: 'run_shell' } });
  const session = reduceSession(runningSession(), { type: 'runtime.event', event }, { observedAt: 1 });
  const entry = session.timeline[0];
  assert.equal(entry?.type === 'message' ? entry.text : null, 'Authorized run_shell for this session.');
  assert.deepEqual(entry?.type === 'message' ? entry.notice : null, {
    code: 'tool_authorized_for_session',
    params: { toolName: 'run_shell' },
  });

  const parsed = parseAgentSessionSnapshot(JSON.parse(JSON.stringify(createAgentSessionSnapshot(session))));
  const restored = parsed?.session.timeline[0];
  assert.deepEqual(restored?.type === 'message' ? restored.notice : null, {
    code: 'tool_authorized_for_session',
    params: { toolName: 'run_shell' },
  });

  const failed = reduceSession(runningSession(), {
    type: 'runtime.event',
    event: agentErrorEvent('req-1', { code: 'interrupt_closed' }),
  }, { observedAt: 1 });
  const error = failed.timeline[0];
  assert.deepEqual(error?.type === 'message' ? error.notice : null, { code: 'interrupt_closed' });
});

test('renderAgentNotice uses a client renderer and falls back to the default text', () => {
  const renderers = { interrupt_closed: () => 'closed!' };
  assert.equal(renderAgentNotice({ code: 'interrupt_closed' }, renderers, (text) => text), 'closed!');
  assert.equal(
    renderAgentNotice({ code: 'run_in_flight' }, renderers, (text) => `fallback: ${text}`),
    'fallback: Wait for the current response to finish.',
  );
});
