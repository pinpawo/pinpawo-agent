import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TUI_CORE_CONTRACT_RULES,
  TUI_CORE_CONTRACT_VERSION,
  TUI_CORE_FORBIDDEN_SECONDARY_LOGS,
  TUI_CORE_STATE_OWNERS,
  TUI_CORE_TARGET_ACTIONS,
  TUI_CORE_TIMELINE_ENTRY_TYPES,
  type TuiCoreSessionSnapshotLoadedAction,
} from './tuiCoreContract';

test('TUI CORE-1 contract freezes timeline and snapshot ownership', () => {
  assert.equal(TUI_CORE_CONTRACT_VERSION, 1);
  assert.deepEqual([...TUI_CORE_TIMELINE_ENTRY_TYPES], ['message', 'operation']);
  assert.deepEqual([...TUI_CORE_STATE_OWNERS], [
    'activeRun',
    'connection',
    'pendingReview',
    'runtime',
    'studioProgress',
    'tokenUsage',
  ]);
  assert.deepEqual([...TUI_CORE_FORBIDDEN_SECONDARY_LOGS], [
    'transcript',
    'transcriptSnapshot',
  ]);
  assert.equal(TUI_CORE_TARGET_ACTIONS.sessionSnapshotLoaded, 'session.snapshot.loaded');
  assert.equal(TUI_CORE_CONTRACT_RULES.length, 5);
});

test('TUI CORE-1 snapshot action carries the target session model shape', () => {
  const action: TuiCoreSessionSnapshotLoadedAction = {
    type: TUI_CORE_TARGET_ACTIONS.sessionSnapshotLoaded,
    source: 'reconnect',
    snapshot: {
      sessionId: 'chat:pet',
      kind: 'chat',
      timeline: [{
        id: 'assistant-final',
        type: 'message',
        role: 'assistant',
        text: 'final answer',
        status: 'completed',
        source: 'checkpoint',
        requestId: 'req-1',
      }],
      runs: [{
        requestId: 'req-1',
        sessionId: 'chat:pet',
        kind: 'chat',
        phase: 'completed',
        timelineEntryIds: ['assistant-final'],
      }],
      runtime: { model: 'gpt-test' },
      tokenUsage: {
        inputTokens: 10,
        outputTokens: 20,
        totalTokens: 30,
      },
    },
  };

  assert.equal(action.snapshot.timeline[0]?.type, 'message');
  assert.equal(action.snapshot.runs[0]?.phase, 'completed');
});
