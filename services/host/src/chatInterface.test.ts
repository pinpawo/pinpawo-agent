import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAppChatThreadId,
  buildHostInterfaceContext,
  buildTuiChatThreadId,
  readHostInterfaceContext,
} from './chatInterface';

test('buildHostInterfaceContext derives capabilities from explicit kind', () => {
  assert.deepEqual(
    buildHostInterfaceContext({
      kind: 'tui',
      threadId: buildTuiChatThreadId({ petId: 'pet-1', sessionSuffix: 'abc12345' }),
    }),
    {
      kind: 'tui',
      threadId: 'petbot:tui:pet:pet-1:abc12345',
      capabilities: {
        humanReview: true,
        sessionAuthorization: true,
      },
    },
  );

  assert.deepEqual(
    buildHostInterfaceContext({
      kind: 'app-chat',
      threadId: buildAppChatThreadId({ petId: 'pet-1', userId: 'user-1' }),
    }),
    {
      kind: 'app-chat',
      threadId: 'petbot:chat:pet:pet-1:user:user-1',
      capabilities: {
        humanReview: true,
        sessionAuthorization: true,
      },
    },
  );
});

test('readHostInterfaceContext does not infer capabilities from thread id naming', () => {
  assert.deepEqual(
    readHostInterfaceContext({
      threadId: buildTuiChatThreadId({ petId: 'pet-1', sessionSuffix: 'abc12345' }),
    }),
    {
      kind: null,
      threadId: 'petbot:tui:pet:pet-1:abc12345',
      capabilities: {
        humanReview: false,
        sessionAuthorization: false,
      },
    },
  );
});

test('readHostInterfaceContext rejects malformed interface context', () => {
  assert.deepEqual(
    readHostInterfaceContext({
      kind: 'unknown',
      threadId: '',
    }),
    {
      kind: null,
      threadId: null,
      capabilities: {
        humanReview: false,
        sessionAuthorization: false,
      },
    },
  );
});
