import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createAgentSessionSnapshot,
  type AgentSession,
  type AgentTimelineEntry,
} from '@pinpawo/agent-session';
import { reconcileCompletionSnapshot } from './completionSnapshot';

test('completion snapshot replaces messages while retaining settled live details', () => {
  const operation: AgentTimelineEntry = {
    id: 'operation',
    type: 'operation',
    requestId: 'run',
    operationKey: 'runtime.read_fixture:operation',
    kind: 'runtime.read_fixture',
    title: 'Read fixture',
    phase: 'completed',
  };
  const subagent: AgentTimelineEntry = {
    id: 'subagent',
    type: 'message',
    role: 'subagent',
    requestId: 'run',
    text: 'Checked the fixture.',
    status: 'completed',
  };
  const live = session([
    message('live-user', 'user', 'Inspect it.'),
    operation,
    subagent,
    message('live-assistant', 'assistant', 'Live reply.'),
  ]);
  const snapshot = createAgentSessionSnapshot(session([
    message('snapshot-user', 'user', 'Inspect it.'),
    message('snapshot-assistant', 'assistant', 'Canonical reply.'),
  ]));

  const reconciled = reconcileCompletionSnapshot(live, snapshot, 1_000);

  assert.deepEqual(
    reconciled.timeline.map((entry) => entry.id),
    ['snapshot-user', 'operation', 'subagent', 'snapshot-assistant'],
  );
  const finalEntry = reconciled.timeline.at(-1);
  assert.equal(
    finalEntry?.type === 'message' ? finalEntry.text : null,
    'Canonical reply.',
  );
});

test('completion snapshot does not replace a newer active run', () => {
  const live = {
    ...session([message('new-run', 'user', 'New prompt.')]),
    activeRun: {
      requestId: 'new-run',
      state: 'running' as const,
      activity: 'thinking' as const,
      startedAt: 1_000,
      updatedAt: 1_000,
    },
  };
  const snapshot = createAgentSessionSnapshot(session([
    message('old-run', 'assistant', 'Old reply.'),
  ]));

  const reconciled = reconcileCompletionSnapshot(live, snapshot, 1_000);

  assert.equal(reconciled.timeline, live.timeline);
  assert.equal(reconciled.activeRun, live.activeRun);
});

test('completion snapshot applies authoritative pending interrupt state', () => {
  const live: AgentSession = {
    ...session([message('new-run', 'user', 'Needs approval.')]),
    pendingInterrupt: {
      interruptId: 'interrupt-new',
      payload: {
        kind: 'human_review',
        interactions: [{
          interactionId: 'review-new',
          schemaVersion: 2,
          view: {
            kind: 'plain',
            body: 'Approve the operation?',
          },
          options: [{
            id: 'approve',
            label: 'Approve',
            batchSubmission: 'immediate',
          }],
        }],
      },
    },
  };
  const snapshot = createAgentSessionSnapshot(session([
    message('old-run', 'assistant', 'Old reply.'),
  ]));

  const reconciled = reconcileCompletionSnapshot(live, snapshot, 1_000);

  assert.equal(reconciled.pendingInterrupt, null);
});

test('completion snapshot trusts a future full canonical timeline', () => {
  const live = session([
    message('live-user', 'user', 'Inspect it.'),
    {
      id: 'live-operation',
      type: 'operation',
      requestId: 'run',
      operationKey: 'runtime.read_fixture:live-operation',
      kind: 'runtime.read_fixture',
      title: 'Read fixture',
      phase: 'completed',
    },
  ]);
  const canonicalOperation: AgentTimelineEntry = {
    id: 'canonical-operation',
    type: 'operation',
    requestId: 'run',
    operationKey: 'runtime.read_fixture:canonical-operation',
    kind: 'runtime.read_fixture',
    title: 'Read canonical fixture',
    phase: 'completed',
  };
  const snapshot = createAgentSessionSnapshot(session([
    message('snapshot-user', 'user', 'Inspect it.'),
    canonicalOperation,
  ]));

  const reconciled = reconcileCompletionSnapshot(live, snapshot, 1_000);

  assert.deepEqual(
    reconciled.timeline.map((entry) => entry.id),
    ['snapshot-user', 'canonical-operation'],
  );
});

test('completion snapshot retains an omitted live-only reply and aligns later request ids', () => {
  const live = session([
    { ...message('first-user', 'user', 'First prompt.'), requestId: 'first' },
    { ...message('partial', 'assistant', 'Interrupted partial.'), requestId: 'first' },
    { ...message('second-user', 'user', 'Second prompt.'), requestId: 'second' },
    { ...message('second-reply', 'assistant', 'Second reply.'), requestId: 'second' },
  ]);
  const snapshot = createAgentSessionSnapshot(session([
    message('snapshot-first-user', 'user', 'First prompt.'),
    message('snapshot-second-user', 'user', 'Second prompt.'),
    message('snapshot-second-reply', 'assistant', 'Second reply.'),
  ]));

  const reconciled = reconcileCompletionSnapshot(live, snapshot, 1_000);

  assert.deepEqual(
    reconciled.timeline
      .filter((entry) => entry.type === 'message')
      .map((entry) => entry.requestId),
    ['first', 'first', 'second', 'second'],
  );
});

test('completion snapshots preserve live progress without recreating delivery handoffs', () => {
  const progress: AgentTimelineEntry = {
    id: 'live-progress',
    type: 'message',
    role: 'subagent',
    requestId: 'run',
    text: 'Prepared the result.',
    status: 'completed',
  };
  const live = session([
    message('live-user', 'user', 'Delegate it.'),
    progress,
    message('live-assistant', 'assistant', 'Prepared the result.'),
  ]);
  const snapshot = createAgentSessionSnapshot(session([
    message('snapshot-user', 'user', 'Delegate it.'),
    message('snapshot-assistant', 'assistant', 'Prepared the result.'),
  ]));

  const reconciled = reconcileCompletionSnapshot(live, snapshot, 1_000);
  const repeated = reconcileCompletionSnapshot(reconciled, snapshot, 2_000);

  assert.deepEqual(repeated.timeline.map((entry) => entry.id), [
    'snapshot-user', 'live-progress', 'snapshot-assistant',
  ]);
  assert.equal(repeated.timeline[1], progress);
});

test('completion snapshot inserts a missing assistant reply without creating a delivery message', () => {
  const live = session([message('live-user', 'user', 'Delegate it.')]);
  const snapshot = createAgentSessionSnapshot(session([
    message('snapshot-user', 'user', 'Delegate it.'),
    message('snapshot-assistant', 'assistant', 'Done.'),
  ]));

  const reconciled = reconcileCompletionSnapshot(live, snapshot, 1_000);

  assert.deepEqual(reconciled.timeline.map((entry) => entry.id), [
    'snapshot-user', 'snapshot-assistant',
  ]);
});

function session(timeline: AgentTimelineEntry[]): AgentSession {
  return {
    sessionId: 'chat:one',
    kind: 'chat',
    timeline,
    activeRun: null,
    pendingInterrupt: null,
  };
}

function message(
  id: string,
  role: 'user' | 'assistant',
  text: string,
): AgentTimelineEntry {
  return {
    id,
    type: 'message',
    role,
    text,
    status: 'completed',
  };
}
