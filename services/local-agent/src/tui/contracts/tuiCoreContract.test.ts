import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TUI_CORE_CONTRACT_RULES,
  TUI_CORE_CONTRACT_VERSION,
  TUI_CORE_DEFERRED_CONTRACT_GAPS,
  TUI_CORE_DEFERRED_REDUCER_GAPS,
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

test('TUI CORE-1 tracks deferred reducer terminalization gaps without skipped tests', () => {
  assert.deepEqual(TUI_CORE_DEFERRED_REDUCER_GAPS.map((gap) => gap.id), [
    'completed-event-missing-active-pointer',
  ]);

  const [gap] = TUI_CORE_DEFERRED_REDUCER_GAPS;
  assert.equal(gap?.currentArea, 'tuiStateReducer event.received(message.completed)');
  assert.equal(gap?.currentLegacyPaths.includes('session.activeRun pointer gate'), true);
  assert.equal(gap?.followUp.some((item) => item.startsWith('CORE-3')), true);
  assert.equal(gap?.followUp.some((item) => item.startsWith('CORE-5')), true);
});

test('TUI CORE-1 tracks deferred runtime snapshot migrations without skipped tests', () => {
  assert.deepEqual(TUI_CORE_DEFERRED_CONTRACT_GAPS.map((gap) => gap.id), [
    'reconnect-server-completed-run',
    'reconnect-pending-review',
    'resume-session-snapshot',
  ]);

  for (const gap of TUI_CORE_DEFERRED_CONTRACT_GAPS) {
    assert.equal(gap.targetAction, TUI_CORE_TARGET_ACTIONS.sessionSnapshotLoaded);
    assert.equal(gap.followUp.some((item) => item.startsWith('CORE-4')), true);
    assert.equal(gap.followUp.some((item) => item.startsWith('CORE-5')), true);
  }

  assert.deepEqual(
    TUI_CORE_DEFERRED_CONTRACT_GAPS
      .flatMap((gap) => [...gap.currentLegacyActions])
      .filter((action) => action === 'session.clear' || action === 'session.replace_history')
      .sort(),
    ['session.clear', 'session.replace_history', 'session.replace_history'],
  );
});
