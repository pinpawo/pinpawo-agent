import type {
  AgentRuntimeEvent,
  AgentSession,
} from '@pinpawo/agent-session';

const QA_STEP_MS = 700;

export type DemoQaEventStep = {
  delayMs: number;
  event: AgentRuntimeEvent;
};

export function buildDemoQaEventSequence(
  requestId: string,
): DemoQaEventStep[] {
  const operation = {
    id: `qa-operation:${requestId}`,
    kind: 'qa.inspect',
    title: 'Inspect terminal behavior',
    target: 'native scrollback',
  };
  const partial = [
    '## QA response',
    '',
    'Streaming **Markdown** stays editable while history is browsed.',
  ].join('\n');
  return [{
    delayMs: QA_STEP_MS,
    event: {
      type: 'operation',
      requestId,
      phase: 'started',
      operation,
    },
  }, {
    delayMs: QA_STEP_MS * 2,
    event: {
      type: 'operation',
      requestId,
      phase: 'updated',
      operation: {
        ...operation,
        summary: 'checking wide cells and scroll anchoring',
      },
    },
  }, {
    delayMs: QA_STEP_MS * 3,
    event: {
      type: 'operation',
      requestId,
      phase: 'completed',
      operation: {
        ...operation,
        summary: 'terminal cells aligned',
      },
    },
  }, {
    delayMs: QA_STEP_MS * 4,
    event: {
      type: 'subagent.message.completed',
      requestId,
      messageId: `qa-subagent:${requestId}`,
      namespace: ['qa', 'terminal'],
      text: 'Subagent rows remain distinct from tool operations.',
    },
  }, {
    delayMs: QA_STEP_MS * 5,
    event: {
      type: 'message.delta',
      requestId,
      role: 'assistant',
      text: '## QA response\n\n',
    },
  }, {
    delayMs: QA_STEP_MS * 6,
    event: {
      type: 'message.delta',
      requestId,
      role: 'assistant',
      text: 'Streaming **Markdown** stays editable while history is browsed.',
    },
  }, {
    delayMs: QA_STEP_MS * 8,
    event: {
      type: 'message.completed',
      requestId,
      role: 'assistant',
      text: `${partial}\n\n完成 🙂`,
      usage: {
        inputTokens: 20_000,
        outputTokens: 3_000,
        totalTokens: 23_000,
        latestInputTokens: 25_000,
        contextWindow: 128_000,
      },
    },
  }];
}

export function createDemoQaHistory(): AgentSession['timeline'] {
  const timeline: AgentSession['timeline'] = [];
  for (let turn = 1; turn <= 12; turn += 1) {
    timeline.push({
      id: `qa-history-user:${turn}`,
      type: 'message',
      role: 'user',
      text: `QA history turn ${turn}: verify native scrollback.`,
      status: 'completed',
    }, {
      id: `qa-history-assistant:${turn}`,
      type: 'message',
      role: 'assistant',
      text: `Rendered turn ${turn}. 宽字符 🙂 stay aligned.`,
      status: 'completed',
    });
  }
  return timeline;
}
