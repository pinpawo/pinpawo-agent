import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TUI_CORE3_CONTRACT_VERSION,
  TUI_CORE3_RUN_PHASES,
  TUI_CORE3_RUN_TERMINAL_EVENTS,
  isRunTerminal,
  sessionIdFromRunId,
  type TuiCore3State,
  type TuiCore3RunModel,
} from './tuiCore3RunRegistry';

test('CORE-3 run registry contract is explicit and deterministic', () => {
  assert.equal(TUI_CORE3_CONTRACT_VERSION, 3);
  assert.deepEqual(
    [...TUI_CORE3_RUN_PHASES],
    ['starting', 'thinking', 'using_tool', 'streaming', 'waiting_human', 'interrupting', 'completed', 'failed', 'interrupted'],
  );
  assert.deepEqual([...TUI_CORE3_RUN_TERMINAL_EVENTS], ['completed', 'failed', 'interrupted']);

  const runs: Record<string, TuiCore3RunModel> = {
    'req-1': {
      requestId: 'req-1',
      sessionId: 'sess-1',
      kind: 'chat',
      phase: 'completed',
      timelineEntryIds: ['req-1:assistant:0'],
      startedAt: 1000,
      finishedAt: 2000,
    },
    'req-2': {
      requestId: 'req-2',
      sessionId: 'sess-1',
      kind: 'chat',
      phase: 'waiting_human',
      timelineEntryIds: [],
      pendingReview: {
        requestId: 'req-2',
        reviewId: 'review-1',
        status: 'waiting',
      },
      startedAt: 2000,
    },
  };
  const state: TuiCore3State = {
    runs,
    sessions: {
      'sess-1': { activeRunId: 'req-2' },
    },
  };

  assert.equal(sessionIdFromRunId(runs, 'req-1'), 'sess-1');
  assert.equal(sessionIdFromRunId(runs, 'req-missing'), undefined);
  assert.equal(isRunTerminal('completed'), true);
  assert.equal(isRunTerminal('streaming'), false);
  assert.equal(state.sessions['sess-1']?.activeRunId, 'req-2');
  assert.equal(state.runs['req-2']?.pendingReview?.status, 'waiting');
});
