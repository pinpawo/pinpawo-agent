import {
  reduceSession,
  type AgentRuntimeEvent,
  type AgentSession,
  type AgentTimelineEntry,
} from '@pinpawo/agent-session';

export function createSpikeSession(turnCount = 120): AgentSession {
  let session: AgentSession = {
    sessionId: 'opentui-spike',
    kind: 'chat',
    timeline: [],
    activeRun: null,
    runtime: {
      model: 'spike-model',
      cwd: '/tmp/pinpawo-opentui-spike',
      contextWindow: 128_000,
    },
  };

  for (let index = 0; index < turnCount; index += 1) {
    const requestId = `spike-${index}`;
    const observedAt = 1_000 + index * 10;
    session = reduceSession(session, {
      type: 'user.accepted',
      requestId,
      kind: 'chat',
      text: `Probe turn ${index + 1}: verify ordered timeline rendering.`,
    }, { observedAt });
    session = reduceSession(session, {
      type: 'runtime.event',
      event: {
        type: 'operation',
        requestId,
        phase: 'started',
        operation: {
          id: `operation-${index}`,
          kind: 'spike.timeline',
          title: 'Render timeline row',
          target: `row-${index + 1}`,
        },
        raw: {
          input: { index },
        },
      },
    }, { observedAt: observedAt + 1 });
    session = reduceSession(session, {
      type: 'runtime.event',
      event: {
        type: 'operation',
        requestId,
        phase: 'completed',
        operation: {
          id: `operation-${index}`,
          kind: 'spike.timeline',
          title: 'Render timeline row',
          summary: 'completed',
        },
        raw: {
          output: { index },
        },
      },
    }, { observedAt: observedAt + 2 });
    session = reduceSession(session, {
      type: 'runtime.event',
      event: {
        type: 'message.completed',
        requestId,
        messageId: `message-${index}`,
        role: 'assistant',
        text: `Rendered turn ${index + 1}. 宽字符 🙂 stay aligned.`,
      },
    }, { observedAt: observedAt + 3 });
  }

  return session;
}

export function beginSpikeRun(
  session: AgentSession,
  requestId: string,
  observedAt: number,
) {
  return reduceSession(session, {
    type: 'user.accepted',
    requestId,
    kind: 'chat',
    text: 'Start a high-frequency delta probe.',
  }, { observedAt });
}

export function applySpikeEvent(
  session: AgentSession,
  event: AgentRuntimeEvent,
  observedAt: number,
) {
  return reduceSession(session, {
    type: 'runtime.event',
    event,
  }, { observedAt });
}

export function formatSpikeTimelineEntry(entry: AgentTimelineEntry) {
  if (entry.type === 'operation') {
    const target = entry.target ? ` ${entry.target}` : '';
    const summary = entry.summary ? ` — ${entry.summary}` : '';
    return `  ${operationMark(entry.phase)} ${entry.title}${target}${summary}`;
  }
  const role = entry.role === 'assistant'
    ? 'assistant'
    : entry.role;
  const streaming = entry.status === 'streaming' ? ' …' : '';
  return `${role.padEnd(10)} ${entry.text}${streaming}`;
}

function operationMark(phase: Extract<AgentTimelineEntry, { type: 'operation' }>['phase']) {
  switch (phase) {
    case 'started':
    case 'updated':
      return '◌';
    case 'completed':
      return '●';
    case 'failed':
      return '×';
    case 'interrupted':
      return '■';
  }
}
