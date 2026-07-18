import assert from 'node:assert/strict';
import test from 'node:test';
import type { LocalAgentOperationEvent } from '../../events/localAgentRuntimeEvent';
import {
  localAgentOperationEntryId,
  localAgentOperationEntryFromEvent,
  localAgentOperationKey,
} from '../../localAgentTimeline';
import {
  buildTimelineViewportModel,
  findTimelineOperationEntry,
  selectActiveOperationsFromTimeline,
  selectRunningOperationEntries,
  splitTimelineForViewport,
} from './agentTimelineSelectors';
import type { LocalAgentTimelineEntry } from '../../localAgentSession';

test('operation timeline entries keep stable ids across lifecycle phases', () => {
  const started = operationEvent({
    phase: 'started',
    target: 'https://example.com',
    summary: '打开网页',
  });
  const completed = operationEvent({
    phase: 'completed',
    target: 'https://example.com/',
    summary: '页面：Example Domain',
  });

  const startedEntry = localAgentOperationEntryFromEvent(started, 1000);
  const completedEntry = localAgentOperationEntryFromEvent(completed, 2500, startedEntry);

  assert.equal(localAgentOperationEntryId(started), 'req-1:operation:call-browser');
  assert.equal(startedEntry.id, 'req-1:operation:call-browser');
  assert.equal(completedEntry.id, startedEntry.id);
  assert.equal(completedEntry.startedAt, 1000);
  assert.equal(completedEntry.updatedAt, 2500);
  assert.equal(completedEntry.completedAt, 2500);
  assert.equal(completedEntry.phase, 'completed');
  assert.equal(completedEntry.target, 'https://example.com/');
  assert.equal(completedEntry.summary, '页面：Example Domain');
});

test('operation timeline terminal events preserve previous display fields when payload is sparse', () => {
  const started = operationEvent({
    phase: 'started',
    target: 'npm test',
    summary: '执行测试',
    details: { cwd: '/repo' },
  });
  const completed = operationEvent({
    phase: 'completed',
    title: null,
    target: undefined,
    summary: undefined,
    details: null,
    source: null,
  });

  const startedEntry = localAgentOperationEntryFromEvent(started, 1000);
  const completedEntry = localAgentOperationEntryFromEvent(completed, 2500, startedEntry);

  assert.equal(completedEntry.id, startedEntry.id);
  assert.equal(completedEntry.phase, 'completed');
  assert.equal(completedEntry.title, '打开网页');
  assert.equal(completedEntry.target, 'npm test');
  assert.equal(completedEntry.summary, '执行测试');
  assert.deepEqual(completedEntry.details, { cwd: '/repo' });
});

test('operation timeline terminal events merge completed details with previous details', () => {
  const started = operationEvent({
    phase: 'started',
    target: 'README.md',
    summary: 'write',
    details: {
      before: 'old',
      afterPreview: 'new',
    },
  });
  const completed = operationEvent({
    phase: 'completed',
    target: 'README.md',
    summary: 'write',
    details: {
      after: 'new',
      mode: 'write',
    },
  });

  const startedEntry = localAgentOperationEntryFromEvent(started, 1000);
  const completedEntry = localAgentOperationEntryFromEvent(completed, 2500, startedEntry);

  assert.deepEqual(completedEntry.details, {
    before: 'old',
    afterPreview: 'new',
    after: 'new',
    mode: 'write',
  });
});

test('operation timeline terminal events keep raw input for payload renderers', () => {
  const started = operationEvent({
    phase: 'started',
    target: 'README.md',
    summary: 'update',
    raw: {
      input: { patch: '*** Begin Patch\n*** Update File: README.md\n-old\n+new\n*** End Patch' },
    },
  });
  const completed = operationEvent({
    phase: 'completed',
    target: 'README.md',
    summary: 'update',
    raw: {
      output: '{"ok":true}',
    },
  });

  const startedEntry = localAgentOperationEntryFromEvent(started, 1000);
  const completedEntry = localAgentOperationEntryFromEvent(completed, 2500, startedEntry);

  assert.deepEqual(completedEntry.raw, {
    input: { patch: '*** Begin Patch\n*** Update File: README.md\n-old\n+new\n*** End Patch' },
    output: '{"ok":true}',
  });
});

test('shared operation projection derives stable keys from operation event fields', () => {
  const event = operationEvent({
    id: null,
    callId: 'source-call',
    phase: 'started',
    target: 'README.md',
    summary: undefined,
  });

  assert.equal(localAgentOperationKey(event), 'source-call');
  const entry = localAgentOperationEntryFromEvent(event, 1000);
  assert.deepEqual({
    operationKey: entry.operationKey,
    kind: entry.kind,
    title: entry.title,
    phase: entry.phase,
    target: entry.target,
    summary: entry.summary,
    details: entry.details,
    source: entry.operationSource,
  }, {
    operationKey: 'source-call',
    kind: 'browser.browser_open',
    title: '打开网页',
    phase: 'started',
    target: 'README.md',
    summary: undefined,
    details: { headless: true },
    source: {
      provider: 'toolkit',
      name: 'browser',
      toolName: 'browser_open',
      callId: 'source-call',
    },
  });
});

test('timeline selectors derive active operations from running operation entries', () => {
  const running = localAgentOperationEntryFromEvent(operationEvent({
    phase: 'started',
    target: '.login-btn',
    summary: '点击 .login-btn',
  }), 1000);
  const otherRun = localAgentOperationEntryFromEvent(operationEvent({
    requestId: 'req-2',
    id: 'call-other',
    phase: 'updated',
    target: 'README.md',
    summary: 'read',
  }), 1200);
  const completed = localAgentOperationEntryFromEvent(operationEvent({
    id: 'call-done',
    phase: 'completed',
    target: 'https://example.com',
    summary: '页面：Example',
  }), 1500);

  const entries = [running, otherRun, completed];

  assert.deepEqual(
    selectRunningOperationEntries(entries, 'req-1').map((entry) => entry.operationKey),
    ['call-browser'],
  );
  assert.deepEqual(
    selectActiveOperationsFromTimeline(entries, 'req-1'),
    [{
      name: 'call-browser',
      label: '打开网页',
      detail: '.login-btn · 点击 .login-btn · headless=true',
      startedAt: 1000,
    }],
  );
  assert.equal(findTimelineOperationEntry(entries, 'call-done')?.phase, 'completed');
});

test('timeline active operation detail keeps payload fields out of status summaries', () => {
  const running = localAgentOperationEntryFromEvent(operationEvent({
    phase: 'started',
    target: 'README.md',
    summary: 'update',
    details: {
      patch: '*** Begin Patch\n-old\n+new\n*** End Patch',
      mode: 'patch',
    },
  }), 1000);

  assert.deepEqual(selectActiveOperationsFromTimeline([running], 'req-1'), [{
    name: 'call-browser',
    label: '打开网页',
    detail: 'README.md · update · mode=patch',
    startedAt: 1000,
  }]);
});

test('splitTimelineForViewport keeps only the settled prefix static', () => {
  const userEntry: LocalAgentTimelineEntry = {
    id: 'req-1:user',
    type: 'message',
    role: 'user',
    requestId: 'req-1',
    text: 'hello',
    status: 'completed',
  };
  const streamingAssistantEntry: LocalAgentTimelineEntry = {
    id: 'req-1:assistant:0',
    type: 'message',
    role: 'assistant',
    requestId: 'req-1',
    text: 'working',
    status: 'streaming',
  };
  const operationEntry = localAgentOperationEntryFromEvent(operationEvent({
    phase: 'completed',
    target: 'README.md',
    summary: 'read',
  }), 1200);
  const assistantEntry: LocalAgentTimelineEntry = {
    id: 'req-1:assistant',
    type: 'message',
    role: 'assistant',
    requestId: 'req-1',
    text: 'done',
    status: 'completed',
  };

  const streamingEntries = [userEntry, streamingAssistantEntry, operationEntry, assistantEntry];

  assert.deepEqual(splitTimelineForViewport(streamingEntries), {
    staticEntries: [streamingEntries[0]],
    dynamicEntries: streamingEntries.slice(1),
  });

  const completedAssistant = {
    ...streamingAssistantEntry,
    status: 'completed' as const,
  };
  const completedEntries = [userEntry, completedAssistant, operationEntry, assistantEntry];
  assert.deepEqual(splitTimelineForViewport(completedEntries), {
    staticEntries: completedEntries,
    dynamicEntries: [],
  });
});

test('timeline viewport keeps system and subagent messages in canonical order', () => {
  const timeline: LocalAgentTimelineEntry[] = [
    {
      id: 'message:user-1',
      type: 'message',
      role: 'user',
      text: 'hello',
      status: 'completed',
    },
    {
      id: 'notice-1',
      type: 'message',
      role: 'system',
      text: 'after user',
      status: 'completed',
    },
    {
      id: 'req-1:operation:tool',
      type: 'operation',
      requestId: 'req-1',
      operationKey: 'tool',
      kind: 'tool',
      title: 'Tool',
      phase: 'completed',
      startedAt: 1000,
      updatedAt: 1100,
    },
    {
      id: 'req-1:subagent-output',
      type: 'message',
      role: 'subagent',
      requestId: 'req-1',
      text: 'working',
      status: 'streaming',
    },
    {
      id: 'req-1:assistant:0',
      type: 'message',
      role: 'assistant',
      text: 'done',
      status: 'streaming',
    },
  ];
  assert.deepEqual(timeline.map((entry) => entry.id), [
    'message:user-1',
    'notice-1',
    'req-1:operation:tool',
    'req-1:subagent-output',
    'req-1:assistant:0',
  ]);

  const split = splitTimelineForViewport(timeline);
  assert.deepEqual(split.staticEntries.map((entry) => entry.id), [
    'message:user-1',
    'notice-1',
    'req-1:operation:tool',
  ]);
  assert.deepEqual(split.dynamicEntries.map((entry) => entry.id), [
    'req-1:subagent-output',
    'req-1:assistant:0',
  ]);
});

test('buildTimelineViewportModel derives display entries and viewport split together', () => {
  const timeline: LocalAgentTimelineEntry[] = [
    {
      id: 'message:user-1',
      type: 'message',
      role: 'user',
      text: 'hello',
      status: 'completed',
    },
    {
      id: 'notice-1',
      type: 'message',
      role: 'system',
      text: 'after user',
      status: 'completed',
    },
    {
      id: 'req-1:assistant:0',
      type: 'message',
      role: 'assistant',
      text: 'working',
      status: 'streaming',
    },
  ];

  const viewport = buildTimelineViewportModel(timeline);

  assert.deepEqual(viewport.entries.map((entry) => entry.id), [
    'message:user-1',
    'notice-1',
    'req-1:assistant:0',
  ]);
  assert.deepEqual(viewport.staticEntries.map((entry) => entry.id), [
    'message:user-1',
    'notice-1',
  ]);
  assert.deepEqual(viewport.dynamicEntries.map((entry) => entry.id), [
    'req-1:assistant:0',
  ]);
});

function operationEvent(params: {
  requestId?: string;
  id?: string | null;
  callId?: string;
  phase: LocalAgentOperationEvent['phase'];
  title?: string | null;
  target?: string;
  summary?: string;
  details?: Record<string, unknown> | null;
  source?: LocalAgentOperationEvent['operation']['source'] | null;
  raw?: LocalAgentOperationEvent['raw'];
}): LocalAgentOperationEvent {
  const eventId = params.id === null ? undefined : params.id ?? 'call-browser';
  const callId = params.callId ?? eventId ?? 'call-browser';
  const source = params.source === null
    ? undefined
    : params.source ?? {
      provider: 'toolkit' as const,
      name: 'browser',
      toolName: 'browser_open',
      callId,
    };
  return {
    type: 'operation',
    requestId: params.requestId ?? 'req-1',
    phase: params.phase,
    operation: {
      id: eventId,
      kind: 'browser.browser_open',
      ...(params.title !== null ? { title: params.title ?? '打开网页' } : {}),
      target: params.target,
      summary: params.summary,
      ...(params.details !== null ? { details: params.details ?? { headless: true } } : {}),
      ...(source ? { source } : {}),
    },
    raw: params.raw ?? {
      input: '{"url":"should-not-be-read"}',
    },
  };
}
