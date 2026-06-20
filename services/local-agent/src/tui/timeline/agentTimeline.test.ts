import assert from 'node:assert/strict';
import test from 'node:test';
import type { LocalAgentOperationEvent } from '../../events/localAgentEvent';
import {
  isAgentTimelineMessage,
  operationTimelineEntryFromEvent,
  timelineEntriesFromHistory,
  timelineEntryFromHistoryCell,
  timelineEntryIdFromOperationEvent,
  timelineMessagesFromEntries,
  timelineMessagesFromHistory,
} from './agentTimeline';
import {
  findTimelineOperationEntry,
  selectActiveOperationsFromTimeline,
  selectRunningOperationEntries,
  splitTimelineForStaticRender,
} from './agentTimelineSelectors';
import { buildOperationPresentation, getOperationPresentationKey } from './operationPresentation';
import type { AgentTimelineEntry } from './agentTimeline';

test('timelineEntriesFromHistory maps legacy history cells to stable timeline entries', () => {
  const entries = timelineEntriesFromHistory([
    {
      id: 'user-1',
      kind: 'user',
      text: '打开 example.com',
      timestamp: '2026-06-19T00:00:00.000Z',
    },
    {
      id: 'assistant-1',
      kind: 'assistant',
      text: '我来打开页面',
    },
    {
      id: 'system-1',
      kind: 'system',
      text: '打开网页：https://example.com',
    },
  ]);

  assert.deepEqual(entries, [
    {
      id: 'history:user-1',
      type: 'message',
      role: 'user',
      text: '打开 example.com',
      status: 'completed',
      createdAt: '2026-06-19T00:00:00.000Z',
    },
    {
      id: 'history:assistant-1',
      type: 'message',
      role: 'assistant',
      text: '我来打开页面',
      status: 'completed',
    },
    {
      id: 'history:system-1',
      type: 'notice',
      text: '打开网页：https://example.com',
    },
  ]);
});

test('timelineEntryFromHistoryCell keeps system history typed as notice', () => {
  assert.deepEqual(
    timelineEntryFromHistoryCell({
      id: 'operation-1',
      kind: 'system',
      text: '执行命令：npm test',
    }),
    {
      id: 'history:operation-1',
      type: 'notice',
      text: '执行命令：npm test',
    },
  );
});

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

  const startedEntry = operationTimelineEntryFromEvent(started, 1000);
  const completedEntry = operationTimelineEntryFromEvent(completed, 2500, startedEntry);

  assert.equal(timelineEntryIdFromOperationEvent(started), 'req-1:operation:call-browser');
  assert.equal(startedEntry.id, 'req-1:operation:call-browser');
  assert.equal(completedEntry.id, startedEntry.id);
  assert.equal(completedEntry.startedAt, 1000);
  assert.equal(completedEntry.updatedAt, 2500);
  assert.equal(completedEntry.completedAt, 2500);
  assert.equal(completedEntry.phase, 'completed');
  assert.equal(completedEntry.target, 'https://example.com/');
  assert.equal(completedEntry.summary, '页面：Example Domain');
});

test('operation presentation derives stable keys from operation event fields', () => {
  const event = operationEvent({
    id: null,
    callId: 'source-call',
    phase: 'started',
    target: 'README.md',
    summary: undefined,
  });

  assert.equal(getOperationPresentationKey(event), 'source-call');
  assert.deepEqual(buildOperationPresentation(event), {
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
  const running = operationTimelineEntryFromEvent(operationEvent({
    phase: 'started',
    target: '.login-btn',
    summary: '点击 .login-btn',
  }), 1000);
  const otherRun = operationTimelineEntryFromEvent(operationEvent({
    requestId: 'req-2',
    id: 'call-other',
    phase: 'updated',
    target: 'README.md',
    summary: 'read',
  }), 1200);
  const completed = operationTimelineEntryFromEvent(operationEvent({
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

test('splitTimelineForStaticRender keeps only the settled prefix static', () => {
  const userEntry: AgentTimelineEntry = {
    id: 'req-1:user',
    type: 'message',
    role: 'user',
    requestId: 'req-1',
    text: 'hello',
    status: 'completed',
  };
  const subagentEntry: AgentTimelineEntry = {
    id: 'req-1:subagent-output',
    type: 'message',
    role: 'subagent',
    requestId: 'req-1',
    text: 'working',
    status: 'streaming',
  };
  const operationEntry = operationTimelineEntryFromEvent(operationEvent({
    phase: 'completed',
    target: 'README.md',
    summary: 'read',
  }), 1200);
  const assistantEntry: AgentTimelineEntry = {
    id: 'req-1:assistant',
    type: 'message',
    role: 'assistant',
    requestId: 'req-1',
    text: 'done',
    status: 'completed',
  };

  assert.deepEqual(
    splitTimelineForStaticRender([
      userEntry,
      subagentEntry,
      operationEntry,
      assistantEntry,
    ]),
    {
      staticEntries: [userEntry],
      dynamicEntries: [subagentEntry, operationEntry, assistantEntry],
    },
  );

  const completedSubagent = {
    ...subagentEntry,
    status: 'completed' as const,
  };
  assert.deepEqual(
    splitTimelineForStaticRender([
      userEntry,
      completedSubagent,
      operationEntry,
      assistantEntry,
    ]),
    {
      staticEntries: [userEntry, completedSubagent, operationEntry, assistantEntry],
      dynamicEntries: [],
    },
  );
});

function operationEvent(params: {
  requestId?: string;
  id?: string | null;
  callId?: string;
  phase: LocalAgentOperationEvent['phase'];
  target?: string;
  summary?: string;
}): LocalAgentOperationEvent {
  const eventId = params.id === null ? undefined : params.id ?? 'call-browser';
  const callId = params.callId ?? eventId ?? 'call-browser';
  return {
    type: 'operation',
    requestId: params.requestId ?? 'req-1',
    phase: params.phase,
    operation: {
      id: eventId,
      kind: 'browser.browser_open',
      title: '打开网页',
      target: params.target,
      summary: params.summary,
      details: { headless: true },
      source: {
        provider: 'toolkit',
        name: 'browser',
        toolName: 'browser_open',
        callId,
      },
    },
    raw: {
      input: '{"url":"should-not-be-read"}',
    },
  };
}

test('CORE-2 timeline messages include only checkpoint-backed message and operation entries', () => {
  const operationEntry = operationTimelineEntryFromEvent(operationEvent({
    phase: 'started',
    target: 'pwd',
    summary: 'pwd',
  }), 1);
  const entries: AgentTimelineEntry[] = [
    {
      id: 'user-1',
      type: 'message',
      role: 'user',
      text: 'hello',
      status: 'completed',
    },
    {
      id: 'assistant-1',
      type: 'message',
      role: 'assistant',
      text: 'hi',
      status: 'streaming',
    },
    operationEntry,
    {
      id: 'subagent-1',
      type: 'message',
      role: 'subagent',
      text: 'internal progress',
      status: 'streaming',
    },
    {
      id: 'review-1',
      type: 'review',
      requestId: 'req-1',
      reviewId: 'approval-1',
      status: 'waiting',
    },
    {
      id: 'notice-1',
      type: 'notice',
      text: 'connected',
    },
    {
      id: 'studio-1',
      type: 'studio.progress',
      requestId: 'req-1',
      text: 'writing file',
    },
  ];

  assert.deepEqual(timelineMessagesFromEntries(entries).map((entry) => entry.id), [
    'user-1',
    'assistant-1',
    operationEntry.id,
  ]);
  assert.equal(isAgentTimelineMessage(entries[3]!), false);
  assert.equal(isAgentTimelineMessage(entries[4]!), false);
  assert.equal(isAgentTimelineMessage(entries[5]!), false);
  assert.equal(isAgentTimelineMessage(entries[6]!), false);
});

test('CORE-2 history import maps only user and assistant cells into timeline messages', () => {
  const messages = timelineMessagesFromHistory([
    {
      id: 'user-cell',
      kind: 'user',
      text: 'hello',
      timestamp: '10:00:00',
    },
    {
      id: 'system-cell',
      kind: 'system',
      text: 'connected',
      timestamp: '10:00:01',
    },
    {
      id: 'assistant-cell',
      kind: 'assistant',
      text: 'hi',
      timestamp: '10:00:02',
    },
  ]);

  assert.deepEqual(messages.map((entry) => [entry.id, entry.type, entry.role, entry.text]), [
    ['history:user-cell', 'message', 'user', 'hello'],
    ['history:assistant-cell', 'message', 'assistant', 'hi'],
  ]);
});
