import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentSession } from '@pinpawo/agent-session';
import {
  leaveTaskPauseMode,
  resumesPausedTaskOnEmptySubmit,
  syncTaskPauseMode,
} from './taskPause';

const idleSession = {
  sessionId: 'chat:one',
  kind: 'chat',
  timeline: [],
  activeRun: null,
  pendingInterrupt: null,
} satisfies AgentSession;

const pausedSession = {
  ...idleSession,
  pendingInterrupt: { payload: { kind: 'pause_task' } },
} satisfies AgentSession;

test('an authoritative task pause enters paused composer mode', () => {
  assert.equal(syncTaskPauseMode('ordinary', idleSession), 'ordinary');
  assert.equal(syncTaskPauseMode('ordinary', pausedSession), 'paused');
});

test('a second escape leaves paused mode until the next server state change', () => {
  const leaving = leaveTaskPauseMode('paused');
  assert.equal(leaving, 'leaving');
  assert.equal(syncTaskPauseMode(leaving, pausedSession), 'leaving');
});

test('an empty Enter resumes only while the delegation remains paused', () => {
  assert.equal(resumesPausedTaskOnEmptySubmit('paused', '', 0), true);
  assert.equal(resumesPausedTaskOnEmptySubmit('paused', '', 1), true);
  assert.equal(resumesPausedTaskOnEmptySubmit('paused', 'continue', 0), false);
  assert.equal(resumesPausedTaskOnEmptySubmit('leaving', '', 0), false);
});

test('an absent task pause or a Review interrupt returns to ordinary chat', () => {
  assert.equal(syncTaskPauseMode('paused', idleSession), 'ordinary');
  assert.equal(syncTaskPauseMode('leaving', {
    ...idleSession,
    pendingInterrupt: {
      interruptId: 'interrupt',
      payload: { kind: 'human_review', interactions: [] },
    },
  }), 'ordinary');
});
