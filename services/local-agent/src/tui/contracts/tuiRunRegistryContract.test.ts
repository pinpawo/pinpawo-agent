import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TUI_RUN_PHASES,
  TUI_RUN_REGISTRY_CONTRACT_VERSION,
  TUI_RUN_TERMINAL_PHASES,
  isRunTerminal,
  sessionIdFromRunId,
  type TuiRunRegistryModel,
  type TuiRunRegistryState,
} from './tuiRunRegistryContract';

test('TUI run registry contract is explicit and deterministic', () => {
  assert.equal(TUI_RUN_REGISTRY_CONTRACT_VERSION, 1);
  assert.deepEqual(
    [...TUI_RUN_PHASES],
    ['starting', 'thinking', 'using_tool', 'streaming', 'waiting_human', 'interrupting', 'completed', 'failed', 'interrupted'],
  );
  assert.deepEqual([...TUI_RUN_TERMINAL_PHASES], ['completed', 'failed', 'interrupted']);

  const runs: Record<string, TuiRunRegistryModel> = {
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
  const state: TuiRunRegistryState = {
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
