import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createAgentSessionSnapshot,
  type AgentMessageEntry,
  type AgentSession,
  type AgentTimelineEntry,
} from '@pinpawo/agent-session';
import { reconcileCompletionSnapshot } from './completionSnapshot';

test('a full completion snapshot replaces messages and drops omitted live details', () => {
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
    { ...message('live-system', 'assistant', 'Live notice.'), role: 'system' },
    message('live-assistant', 'assistant', 'Live reply.'),
  ]);
  const snapshot = createAgentSessionSnapshot(session([
    message('snapshot-user', 'user', 'Inspect it.'),
    message('snapshot-assistant', 'assistant', 'Canonical reply.'),
  ]));

  const reconciled = reconcileCompletionSnapshot(live, snapshot, 1_000);

  assert.deepEqual(
    reconciled.timeline.map((entry) => entry.id),
    ['snapshot-user', 'snapshot-assistant'],
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

test('completion snapshot trusts the full canonical timeline including operations', () => {
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

test('a full completion snapshot drops an omitted partial reply without inferring request ids', () => {
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

  assert.deepEqual(reconciled.timeline, snapshot.session.timeline);
});

test('repeated completion snapshots do not restore omitted live progress', () => {
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
    'snapshot-user', 'snapshot-assistant',
  ]);
  assert.deepEqual(repeated.timeline, reconciled.timeline);
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

for (const windowed of [false, true]) {
  test(`completion snapshot aligns repeated text by canonical ids${windowed ? ' in a tail window' : ''}`, () => {
    const live = session([
      { ...message('u1', 'user', 'Continue.'), requestId: 'r1' },
      { ...message('a1', 'assistant', 'First reply.'), requestId: 'r1' },
      { ...message('u2', 'user', 'Continue.'), requestId: 'r2' },
      { ...message('a2', 'assistant', 'Second reply.'), requestId: 'r2' },
    ]);
    const snapshot = createAgentSessionSnapshot({
      ...session([
        message('u2', 'user', 'Continue.'),
        message('a2', 'assistant', 'Second reply.'),
      ]),
      ...(windowed ? { timelineWindow: { omitted: 2 } } : {}),
    });

    const reconciled = reconcileCompletionSnapshot(live, snapshot, 1_000);
    const repeated = reconcileCompletionSnapshot(reconciled, snapshot, 2_000);

    assert.deepEqual(reconciled.timeline.map((entry) => entry.id), windowed
      ? ['u1', 'a1', 'u2', 'a2'] : ['u2', 'a2']);
    assert.deepEqual(reconciled.timeline.map((entry) => entry.requestId), windowed
      ? ['r1', 'r1', undefined, undefined] : [undefined, undefined]);
    assert.deepEqual(repeated.timeline, reconciled.timeline);
  });
}

test('completion snapshot uses canonical identity even when message text changes', () => {
  const live = session([
    { ...message('u1', 'user', 'Continue.'), requestId: 'r1' },
    { ...message('a1', 'assistant', 'Same reply.'), requestId: 'r1' },
    { ...message('u2', 'user', 'Continue.'), requestId: 'r2' },
    { ...message('a2', 'assistant', 'Partial reply.'), requestId: 'r2' },
  ]);
  const snapshot = createAgentSessionSnapshot(session([
    message('u2', 'user', 'Continue.'),
    message('a2', 'assistant', 'Same reply.'),
  ]));

  const reconciled = reconcileCompletionSnapshot(live, snapshot, 1_000);

  assert.deepEqual(reconciled.timeline.map((entry) => entry.id), ['u2', 'a2']);
  assert.deepEqual(reconciled.timeline.map((entry) => entry.requestId), [undefined, undefined]);
  const finalEntry = reconciled.timeline.at(-1);
  assert.equal(finalEntry?.type === 'message' ? finalEntry.text : null, 'Same reply.');
});

test('completion snapshots do not infer request ownership from repeated optimistic text', () => {
  const live = session([
    { ...message('known-user', 'user', 'Continue.'), requestId: 'known-run' },
    { ...message('optimistic-user', 'user', 'Continue.'), requestId: 'new-run' },
  ]);
  const snapshot = createAgentSessionSnapshot(session([
    message('earlier-user', 'user', 'Continue.'),
    message('known-user', 'user', 'Continue.'),
    message('new-user', 'user', 'Continue.'),
  ]));

  const reconciled = reconcileCompletionSnapshot(live, snapshot, 1_000);

  assert.deepEqual(reconciled.timeline.map((entry) => entry.id), [
    'earlier-user', 'known-user', 'new-user',
  ]);
  assert.deepEqual(reconciled.timeline.map((entry) => entry.requestId), [
    undefined, undefined, undefined,
  ]);
});

test('a completion window keeps only the held prefix and replaces all covered live details', () => {
  const prefixOperation: AgentTimelineEntry = {
    id: 'prefix-operation', type: 'operation', requestId: 'old-run',
    operationKey: 'old', kind: 'shell', title: 'Old operation', phase: 'completed',
  };
  const coveredOperation: AgentTimelineEntry = {
    ...prefixOperation, id: 'covered-operation', requestId: 'run', operationKey: 'covered',
  };
  const live = session([
    message('prefix-user', 'user', 'Earlier prompt.'),
    prefixOperation,
    message('window-user', 'user', 'Continue.'),
    coveredOperation,
    { ...message('covered-subagent', 'assistant', 'Progress.'), role: 'subagent' },
    message('partial', 'assistant', 'Partial reply.'),
  ]);
  const snapshot = createAgentSessionSnapshot({
    ...session([
      message('window-user', 'user', 'Continue.'),
      message('canonical-reply', 'assistant', 'Canonical reply.'),
    ]),
    timelineWindow: { omitted: 2 },
  });

  const reconciled = reconcileCompletionSnapshot(live, snapshot, 1_000);

  assert.deepEqual(reconciled.timeline, [
    live.timeline[0], prefixOperation, ...snapshot.session.timeline,
  ]);
});

test('an older completion window cannot erase a newer active run', () => {
  const live: AgentSession = {
    ...session([
      message('older-user', 'user', 'Earlier prompt.'),
      message('newer-user', 'user', 'New prompt.'),
      message('newer-reply', 'assistant', 'Streaming reply.'),
    ]),
    activeRun: { requestId: 'newer-run', state: 'running', activity: 'streaming' },
  };
  const snapshot = createAgentSessionSnapshot({
    ...session([message('older-user', 'user', 'Earlier prompt.')]),
    timelineWindow: { omitted: 1 },
  });

  const reconciled = reconcileCompletionSnapshot(live, snapshot, 1_000);

  assert.equal(reconciled.timeline, live.timeline);
  assert.equal(reconciled.activeRun, live.activeRun);
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
): AgentMessageEntry {
  return {
    id,
    type: 'message',
    role,
    text,
    status: 'completed',
  };
}
