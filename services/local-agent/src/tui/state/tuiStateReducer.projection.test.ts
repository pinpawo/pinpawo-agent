import assert from 'node:assert/strict';
import test from 'node:test';
import { reduceSession } from '@pinpawo/agent-session';
import { createInitialTuiState, createSession } from './tuiState';
import { tuiStateReducer } from './tuiStateReducer';

test('TUI actions preserve the shared session reducer projection', () => {
  const tuiInitial = createInitialTuiState(createSession({ id: 'chat:pet' }));
  let tuiState = tuiStateReducer(tuiInitial, {
    type: 'run.start',
    requestId: 'req-1',
    kind: 'chat',
    message: {
      id: 'message:user-1',
      role: 'user',
      text: 'hello',
      requestId: 'req-1',
      createdAt: new Date(1_000).toISOString(),
    },
    now: 1_000,
  });
  let shared = reduceSession(tuiInitial.sessions['chat:pet'], {
    type: 'user.accepted',
    requestId: 'req-1',
    kind: 'chat',
    text: 'hello',
    message: { id: 'message:user-1', createdAt: new Date(1_000).toISOString() },
  }, { observedAt: 1_000 });

  const delta = {
    type: 'message.delta' as const,
    requestId: 'req-1',
    role: 'assistant' as const,
    text: 'hi',
  };
  tuiState = tuiStateReducer(tuiState, {
    type: 'event.received',
    event: delta,
    now: 1_100,
  });
  shared = reduceSession(shared, {
    type: 'runtime.event',
    event: delta,
    message: {
      role: 'assistant',
      requestId: 'req-1',
      text: 'hi',
      createdAt: new Date(1_100).toISOString(),
    },
  }, { observedAt: 1_100 });

  const completed = {
    type: 'message.completed' as const,
    requestId: 'req-1',
    role: 'assistant' as const,
    text: 'hi there',
  };
  tuiState = tuiStateReducer(tuiState, {
    type: 'event.received',
    event: completed,
    now: 1_200,
  });
  shared = reduceSession(shared, {
    type: 'runtime.event',
    event: completed,
    message: {
      role: 'assistant',
      requestId: 'req-1',
      text: 'hi there',
      createdAt: new Date(1_200).toISOString(),
    },
  }, { observedAt: 1_200 });

  assert.deepEqual(tuiState.sessions['chat:pet'], shared);
});
