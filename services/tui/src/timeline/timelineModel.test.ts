import assert from 'node:assert/strict';
import test from 'node:test';
import stringWidth from 'string-width';
import type {
  AgentSession,
  AgentTimelineEntry,
} from '@pinpawo/agent-session';
import {
  countSettledTimelinePrefix,
  formatLiveActivity,
  formatLiveSession,
  formatTimelineEntry,
  isSettledTimelineEntry,
  isLiveActivityPulseActive,
} from './timelineModel';
import {
  findFirstUncommittedEntry,
  planSettledTimelineCommits,
  reconcileTimelinePrefix,
  timelineFingerprint,
} from './timelineScrollback';

const user: AgentTimelineEntry = {
  id: 'user',
  type: 'message',
  role: 'user',
  text: 'hello\nworld',
  status: 'completed',
};
const operation: AgentTimelineEntry = {
  id: 'operation',
  type: 'operation',
  requestId: 'request',
  operationKey: 'operation',
  kind: 'tool',
  title: 'Read file',
  phase: 'started',
};
const assistant: AgentTimelineEntry = {
  id: 'assistant',
  type: 'message',
  role: 'assistant',
  text: 'done',
  status: 'completed',
};

test('timeline model commits only the settled ordered prefix', () => {
  assert.equal(isSettledTimelineEntry(user), true);
  assert.equal(isSettledTimelineEntry(operation), false);
  assert.equal(countSettledTimelinePrefix([user, operation, assistant]), 1);
  assert.equal(countSettledTimelinePrefix([
    user,
    { ...operation, phase: 'completed' },
    assistant,
  ]), 3);
});

test('timeline formatting keeps multiline messages and operation state readable', () => {
  assert.equal(formatTimelineEntry(user), '你\n> hello\n  world');
  assert.equal(
    formatTimelineEntry({ ...operation, phase: 'completed', summary: 'ok' }),
    '  ● Read file(ok)（完成）',
  );
});

test('timeline formatting includes bounded tool output and errors', () => {
  assert.equal(
    formatTimelineEntry({
      ...operation,
      phase: 'completed',
      raw: {
        output: ['line 1', 'line 2'].join('\n'),
      },
    }),
    [
      '  ● Read file（完成）',
      '  ⎿ line 1',
      '    line 2',
    ].join('\n'),
  );
  assert.equal(
    formatTimelineEntry({
      ...operation,
      phase: 'failed',
      raw: {
        output: 'ignored output',
        error: 'permission\tdenied\x1B',
      },
    }),
    [
      '  × Read file（失败）',
      '  ⎿ permission  denied�',
    ].join('\n'),
  );
  assert.match(
    formatTimelineEntry({
      ...operation,
      phase: 'completed',
      raw: {
        output: Array.from({ length: 10 }, (_, index) => `line ${index}`).join('\n'),
      },
    }),
    /… \+4 lines$/,
  );
});

test('operation lines reserve space for the timeline status prefix', () => {
  const lines = formatTimelineEntry({
    ...operation,
    phase: 'completed',
    target: '很长的目标路径/with-a-long-file-name.txt',
    raw: {
      output: '很长的工具输出内容',
    },
  }, {
    width: 20,
  }).split('\n');
  assert.ok(lines.every((line) => stringWidth(line) <= 20));
  assert.match(lines[0] ?? '', /（完成）$/);
});

test('timeline formatting exposes apply_patch details without wrapper markers', () => {
  assert.equal(
    formatTimelineEntry({
      ...operation,
      kind: 'apply_patch',
      title: 'apply_patch',
      phase: 'completed',
      raw: {
        input: {
          patch: [
            '*** Begin Patch',
            '*** Update File: src/example.ts',
            '@@',
            '-old',
            '+new',
            '*** End Patch',
          ].join('\n'),
        },
      },
    }),
    [
      '  ● apply_patch（完成）',
      '  patch',
      '  *** Update File: src/example.ts',
      '  @@',
      '  -old',
      '  +new',
    ].join('\n'),
  );
});

test('live timeline shows the newest streaming tail within its footer budget', () => {
  const session: AgentSession = {
    sessionId: 'session',
    kind: 'chat',
    timeline: [{
      ...assistant,
      text: 'abcdefghijklmnopqrstuvwxyz',
      status: 'streaming',
    }],
    activeRun: {
      requestId: 'request',
      state: 'running',
      activity: 'streaming',
    },
  };
  assert.equal(formatLiveSession(session, 20), 'PinPawo  …qrstuvwxyz');
  assert.equal(formatLiveActivity(session, 0, 20), '⠋ PinPawo  …stuvwxyz');
  assert.equal(formatLiveActivity(session, 1, 20), '⠙ PinPawo  …stuvwxyz');
  assert.equal(formatLiveActivity(session, 10, 20), '⠋ PinPawo  …stuvwxyz');
  assert.equal(
    formatLiveActivity({
      ...session,
      actor: {
        label: '豆包',
        summary: 'Local helper',
      },
    }, 0, 20),
    '⠋ 豆包  …nopqrstuvwxyz',
  );
});

test('live activity distinguishes progress from paused and stopping runs', () => {
  const session: AgentSession = {
    sessionId: 'session',
    kind: 'chat',
    timeline: [],
    activeRun: {
      requestId: 'request',
      state: 'running',
      activity: 'thinking',
    },
  };
  assert.equal(
    formatLiveActivity(session, 0),
    '⠋ PinPawo is thinking',
  );
  assert.equal(
    formatLiveActivity(session, 10, 80, true),
    '⠋ PinPawo is still thinking',
  );
  assert.equal(
    formatLiveActivity({
      ...session,
      actor: {
        label: '豆包',
        summary: 'Local helper',
      },
    }, 1),
    '⠙ 豆包 is thinking',
  );
  assert.equal(isLiveActivityPulseActive(session, 9), true);
  assert.equal(isLiveActivityPulseActive(session, 10_000), true);
  assert.equal(
    formatLiveActivity({
      ...session,
      activeRun: {
        requestId: 'request',
        state: 'waiting_review',
        reviewAction: {
          actionId: 'review-action',
          reviews: [],
        },
      },
    }),
    '! waiting for review',
  );
  assert.equal(isLiveActivityPulseActive({
    ...session,
    activeRun: {
      requestId: 'request',
      state: 'waiting_review',
      reviewAction: {
        actionId: 'review-action',
        reviews: [],
      },
    },
  }, 0), false);
  assert.equal(
    formatLiveActivity({
      ...session,
      activeRun: {
        requestId: 'request',
        state: 'interrupting',
      },
    }),
    '◌ stopping response',
  );
});

test('scrollback reconciliation tolerates snapshot IDs and omitted live operations', () => {
  const committed = [
    timelineFingerprint(user),
    timelineFingerprint({ ...operation, phase: 'completed' }),
    timelineFingerprint(assistant),
  ];
  const checkpointTimeline: AgentTimelineEntry[] = [{
    ...user,
    id: 'message:0:user',
  }, {
    ...assistant,
    id: 'message:1:assistant',
  }];
  assert.equal(
    findFirstUncommittedEntry(checkpointTimeline, committed),
    checkpointTimeline.length,
  );

  const nextUser: AgentTimelineEntry = {
    ...user,
    id: 'next-user',
    text: 'next',
  };
  assert.equal(
    findFirstUncommittedEntry([...checkpointTimeline, nextUser], committed),
    2,
  );
});

test('delta reconciliation reuses the committed prefix by object identity', () => {
  const streaming: AgentTimelineEntry = {
    id: 'assistant-streaming',
    type: 'message',
    role: 'assistant',
    text: 'one',
    status: 'streaming',
  };
  const committed = [timelineFingerprint(user)];
  const cache = {
    prefixLength: 1,
    tailEntry: user,
  };

  const delta = reconcileTimelinePrefix(
    [user, { ...streaming, text: 'one two' }],
    committed,
    cache,
  );
  assert.equal(delta.firstUncommitted, 1);
  assert.equal(delta.strategy, 'identity');

  const snapshot = reconcileTimelinePrefix(
    [{ ...user, id: 'snapshot-user' }, assistant],
    committed,
    cache,
  );
  assert.equal(snapshot.firstUncommitted, 1);
  assert.equal(snapshot.strategy, 'fingerprint');
});

test('streaming text cannot be mistaken for an already committed message', () => {
  assert.notEqual(
    timelineFingerprint({ ...assistant, status: 'streaming' }),
    timelineFingerprint(assistant),
  );
});

test('large settled prefixes are planned as bounded scrollback commits', () => {
  assert.deepEqual(planSettledTimelineCommits(0, 501), [
    [0, 200],
    [200, 400],
    [400, 501],
  ]);
  assert.deepEqual(planSettledTimelineCommits(3, 3), []);
  assert.throws(
    () => planSettledTimelineCommits(0, 1, 0),
    /positive integer/,
  );
});

test('a pending operation keeps later settled entries in the live ordered tail', () => {
  const subagent: AgentTimelineEntry = {
    id: 'subagent',
    type: 'message',
    role: 'subagent',
    text: 'progress',
    status: 'completed',
  };
  assert.equal(
    countSettledTimelinePrefix([user, operation, subagent, assistant]),
    1,
  );
  assert.deepEqual(
    [user, operation, subagent, assistant].map((entry) => (
      formatTimelineEntry(entry)
    )),
    [
      '你\n> hello\n  world',
      '  ◌ Read file（开始）',
      'subagent\n  progress',
      'assistant\n| done',
    ],
  );
});
