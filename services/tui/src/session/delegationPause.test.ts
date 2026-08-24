import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentSession } from '@pinpawo/agent-session';
import {
  leaveDelegationPauseMode,
  resumesPausedDelegationOnEmptySubmit,
  syncDelegationPauseMode,
} from './delegationPause';

const idleSession = {
  sessionId: 'chat:one',
  kind: 'chat',
  timeline: [],
  activeRun: null,
  pendingInterrupt: null,
} satisfies AgentSession;

test('an interrupted event is what enters paused composer mode', () => {
  assert.equal(syncDelegationPauseMode('ordinary', idleSession), 'ordinary');
  assert.equal(syncDelegationPauseMode('paused', idleSession), 'paused');
});

test('a second escape leaves paused mode until the next server state change', () => {
  const leaving = leaveDelegationPauseMode('paused');
  assert.equal(leaving, 'leaving');
  assert.equal(syncDelegationPauseMode(leaving, idleSession), 'leaving');
});

test('an empty Enter resumes only while the delegation remains paused', () => {
  assert.equal(resumesPausedDelegationOnEmptySubmit('paused', '', 0), true);
  assert.equal(resumesPausedDelegationOnEmptySubmit('paused', '', 1), true);
  assert.equal(resumesPausedDelegationOnEmptySubmit('paused', 'continue', 0), false);
  assert.equal(resumesPausedDelegationOnEmptySubmit('leaving', '', 0), false);
});

test('new activity or an absent delegation returns to ordinary chat', () => {
  assert.equal(syncDelegationPauseMode('paused', {
    ...idleSession,
    activeRun: { requestId: 'run', state: 'running', activity: 'thinking' },
  }), 'ordinary');
  assert.equal(syncDelegationPauseMode('leaving', {
    ...idleSession,
    pendingInterrupt: {
      interruptId: 'interrupt',
      payload: { kind: 'human_review', interactions: [] },
    },
  }), 'ordinary');
});
