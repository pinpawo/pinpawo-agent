import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import {
  createAgentSessionSnapshot,
  parseAgentServerMessage,
  reduceSession,
  type AgentMessageEntry,
  type AgentRuntimeEvent,
  type AgentSession,
} from '../../../packages/agent-session/src/index';
import { compactOrchestratorMessages } from '../../../packages/pet-agent/src/agent/orchestrator/contextCompaction';
import { assignToolCallIds } from '../../../packages/pet-agent/src/agent/orchestrator/modelInvocation';
import { reconcileCompletionSnapshot } from '../../../services/tui/src/session/completionSnapshot';

test('compacted history can reuse a call id without settling retained TUI history', async () => {
  const oldCall = new AIMessage({
    id: 'old-call', content: '',
    tool_calls: [{ id: 'c', name: 'lookup', args: {} }],
  });
  const compacted = await compactOrchestratorMessages({
    messages: [oldCall, new ToolMessage({
      tool_call_id: 'c', name: 'lookup', content: 'old result',
    }), new HumanMessage('next request')],
    model: { invoke: async () => new AIMessage('Summary') } as unknown as Parameters<typeof compactOrchestratorMessages>[0]['model'],
    options: { keepMessages: 1 },
  });
  assert.ok(compacted.compacted);
  assert.ok(!compacted.messages.includes(oldCall));
  const response = assignToolCallIds(new AIMessage({
    id: 'new-call', content: '',
    tool_calls: [{ id: 'c', name: 'lookup', args: {} }],
  }), compacted.messages);
  assert.equal(response.tool_calls?.[0]?.id, 'c');

  const oldEntry: AgentMessageEntry = {
    id: 'old-call', type: 'message', role: 'assistant', text: '', status: 'completed',
    requestId: 'old-run',
    toolCalls: [{ id: 'c', name: 'lookup', args: {}, status: 'completed' }],
  };
  const latestUser: AgentMessageEntry = {
    id: 'latest-user', type: 'message', role: 'user', text: 'next request', status: 'completed',
    requestId: 'latest-run',
  };
  const base: AgentSession = {
    sessionId: 'chat:one', kind: 'chat', timeline: [], activeRun: null, pendingInterrupt: null,
  };
  let live = reconcileCompletionSnapshot(
    { ...base, timeline: [oldEntry, latestUser] },
    createAgentSessionSnapshot({ ...base, timeline: [latestUser], timelineWindow: { omitted: 1 } }),
    1_000,
  );
  assert.deepEqual(live.timeline.find(entry => entry.id === 'old-call'), oldEntry);

  const events: AgentRuntimeEvent[] = [
    { type: 'run.started', requestId: 'new-run', initiator: 'client' },
    { type: 'message.tool_calls', requestId: 'new-run', messageId: 'new-call', text: '',
      toolCalls: response.tool_calls!.map(({ id, name, args }) => ({ id: id!, name, args })) },
    { type: 'tool_call.settled', requestId: 'new-run', messageId: 'new-call', callId: 'c',
      status: 'failed', error: 'new failure' },
  ];
  for (const event of events) {
    const parsed = parseAgentServerMessage(JSON.stringify({ type: 'event', requestId: event.requestId, event }));
    assert.ok(parsed?.type === 'event');
    live = reduceSession(live, { type: 'runtime.event', event: parsed.event }, { observedAt: 2_000 });
  }

  assert.deepEqual(live.timeline.find(entry => entry.id === 'old-call'), oldEntry);
  const current = live.timeline.find((entry): entry is AgentMessageEntry => entry.id === 'new-call' && entry.type === 'message');
  assert.deepEqual(current?.toolCalls, [{ id: 'c', name: 'lookup', args: {}, status: 'failed', error: 'new failure' }]);
});
