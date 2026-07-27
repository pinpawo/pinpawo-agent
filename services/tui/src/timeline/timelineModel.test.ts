import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentTimelineEntry } from '@pinpawo/agent-session';
import {
  countSettledTimelinePrefix,
  formatTimelineEntry,
  isSettledTimelineEntry,
} from './timelineModel';
import {
  findFirstUncommittedEntry,
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
  assert.equal(formatTimelineEntry(user), 'user       hello\n           world');
  assert.equal(
    formatTimelineEntry({ ...operation, phase: 'completed', summary: 'ok' }),
    '  ● Read file — ok',
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
