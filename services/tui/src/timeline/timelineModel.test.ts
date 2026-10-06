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
  latestCompletedAssistantReply,
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

test('a running tool call the agent made names the live activity until the run ends', () => {
  const session: AgentSession = {
    sessionId: 'session', kind: 'chat', pendingInterrupt: null,
    activeRun: { requestId: 'request', state: 'running', activity: 'using_tool' },
    timeline: [{ ...assistant, text: '', toolCalls: [{ id: 'call', name: 'delegate_capability',
      title: 'Verify contract extraction', input: 'Long private execution instructions', status: 'running' }] }],
  };
  assert.equal(formatLiveSession(session), 'Verify contract extraction');
  assert.equal(formatLiveSession({ ...session, activeRun: null }), 'idle');
  assert.equal(formatLiveSession({ ...session, timeline: [...session.timeline, {
    ...operation, id: 'inner', title: 'Read file',
  }] }), 'Read file');
  // The call is work in progress, never the reply.
  assert.equal(latestCompletedAssistantReply(session), null);
});

test('a message\'s tool calls head their work and commit before they return', () => {
  const call = { id: 'call', name: 'delegate_capability', title: '读取 issue #826\n并定位相关代码', input: 'briefing', status: 'running' as const };
  const message: AgentTimelineEntry = { ...assistant, id: 'dispatch', text: '先看 issue。', toolCalls: [call] };
  const lines = formatTimelineEntry(message, { width: 80 }).split('\n');
  assert.deepEqual(lines, ['| 先看 issue。', '▸ 读取 issue #826 并定位相关代码']);
  assert.doesNotMatch(lines.join('\n'), /delegate_capability|briefing/);
  assert.equal(formatTimelineEntry({ ...message, text: '' }), '▸ 读取 issue #826 并定位相关代码');
  assert.match(formatTimelineEntry({ ...message, toolCalls: [{ ...call, status: 'declined' }] }), /（未通过）/);

  // Its calls still run, but their committed form — the titles alone — is
  // final, so the transcript commits it and the finished tools behind it.
  assert.equal(
    countSettledTimelinePrefix([
      user,
      message,
      { ...operation, id: 'done', operationKey: 'done', phase: 'completed' },
      operation,
    ]),
    3,
  );
  // A call settling must not rewrite what was committed.
  assert.equal(
    timelineFingerprint(message),
    timelineFingerprint({ ...message, toolCalls: [{ ...call, status: 'returned' }] }),
  );
});

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

test('timeline model selects the latest completed assistant reply', () => {
  const session: AgentSession = {
    sessionId: 'chat:one',
    kind: 'chat',
    timeline: [
      { id: 'user', type: 'message', role: 'user', text: 'first', status: 'completed' },
      { id: 'reply-one', type: 'message', role: 'assistant', text: 'first reply', status: 'completed' },
      { id: 'tool', type: 'operation', requestId: 'run', operationKey: 'tool', kind: 'tool', title: 'tool', phase: 'completed' },
      { id: 'reply-two', type: 'message', role: 'assistant', text: 'second reply', status: 'completed' },
    ],
    activeRun: null,
    pendingInterrupt: null,
  };
  assert.equal(latestCompletedAssistantReply(session), 'second reply');
});

test('timeline model ignores incomplete and non-user-facing replies', () => {
  const session: AgentSession = {
    sessionId: 'chat:one',
    kind: 'chat',
    timeline: [
      { id: 'reply', type: 'message', role: 'assistant', text: 'stable reply', status: 'completed' },
      { id: 'subagent', type: 'message', role: 'subagent', requestId: 'run', text: 'private detail', status: 'completed' },
      { id: 'system', type: 'message', role: 'system', text: 'notice', status: 'completed' },
      { id: 'streaming', type: 'message', role: 'assistant', text: 'partial', status: 'streaming' },
      { id: 'blank', type: 'message', role: 'assistant', text: '  ', status: 'completed' },
    ],
    activeRun: null,
    pendingInterrupt: null,
  };
  assert.equal(latestCompletedAssistantReply(session), 'stable reply');
  assert.equal(latestCompletedAssistantReply({ ...session, timeline: [] }), null);
});

test('timeline formatting keeps multiline messages and operation state readable', () => {
  assert.equal(formatTimelineEntry(user), '  hello\n  world');
  assert.equal(
    formatTimelineEntry({ ...operation, phase: 'completed', summary: 'ok' }),
    '  ✓ Read file · ok（完成）',
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
    '  ✓ Read file（完成）',
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
    /Read file（完成）$/,
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
      '  ✓ apply_patch（完成）',
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
    pendingInterrupt: null,
  };
  assert.equal(formatLiveSession(session, 20), 'PinPawo  …qrstuvwxyz');
  assert.equal(formatLiveActivity(session, 0, 20), 'PinPawo is resp…');
  assert.equal(formatLiveActivity(session, 1, 20), 'PinPawo is resp…');
  assert.equal(formatLiveActivity(session, 10, 20), 'PinPawo is resp…');
  assert.equal(
    formatLiveActivity({
      ...session,
      actor: {
        label: '豆包',
        summary: 'Local helper',
      },
    }, 0, 20),
    '豆包 is respond…',
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
    pendingInterrupt: null,
  };
  assert.equal(
    formatLiveActivity(session, 0),
    'PinPawo is thinking',
  );
  assert.equal(
    formatLiveActivity(session, 10, 80, true),
    'PinPawo is still thinking',
  );
  assert.equal(
    formatLiveActivity({
      ...session,
      activeRun: {
        ...session.activeRun!,
        startedAt: 1_000,
      },
    }, 0, 80, false, 66_500),
    'PinPawo is thinking · 本轮 1m 5s',
  );
  assert.equal(
    formatLiveActivity({
      ...session,
      activeRun: {
        ...session.activeRun!,
        startedAt: 1_000,
      },
    }, 0, 20, false, 66_500),
    'PinPawo is thin…',
  );
  assert.equal(
    formatLiveActivity({
      ...session,
      actor: {
        label: '豆包',
        summary: 'Local helper',
      },
    }, 1),
    '豆包 is thinking',
  );
  assert.equal(isLiveActivityPulseActive(session, 9), true);
  assert.equal(isLiveActivityPulseActive(session, 10_000), true);
  assert.equal(
    formatLiveActivity({
      ...session,
      activeRun: null,
      pendingInterrupt: {
        interruptId: 'review-action',
        payload: { kind: 'human_review', interactions: [] },
      },
    }),
    '! waiting for review',
  );
  assert.equal(isLiveActivityPulseActive({
    ...session,
    activeRun: null,
    pendingInterrupt: {
      interruptId: 'review-action',
      payload: { kind: 'human_review', interactions: [] },
    },
  }, 0), false);
  assert.equal(
    formatLiveSession({
      ...session,
      activeRun: null,
      pendingInterrupt: null,
    }),
    'idle',
  );
  assert.equal(
    formatLiveActivity({
      ...session,
      activeRun: null,
      pendingInterrupt: null,
    }),
    formatLiveSession({ ...session, activeRun: null, pendingInterrupt: null }),
  );
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

test('live footer respects terminal cells for CJK labels and narrow windows', () => {
  const session: AgentSession = {
    sessionId: 's', kind: 'chat', pendingInterrupt: null,
    actor: { label: '豆包助手', summary: 'helper' },
    activeRun: { requestId: 'r', state: 'running', activity: 'using_tool', startedAt: 0 },
    timeline: [{ ...operation, title: '读取配置与检查实现边界'.repeat(10) }],
  };
  for (const width of [4, 12, 20, 40, 80]) {
    const text = formatLiveActivity(session, 0, width, false, 158_000);
    assert.ok(stringWidth(text) + 4 <= width, `${width}: ${text}`);
    if (width >= 40) assert.match(text, /本轮 2m 38s$/);
  }
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
      '  hello\n  world',
      '  ◌ Read file（进行中）',
      '',
      '| done',
    ],
  );
});
