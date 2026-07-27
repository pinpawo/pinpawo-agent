import assert from 'node:assert/strict';
import test from 'node:test';
import {
  studioCompletionMessages,
  studioErrorMessage,
  studioProgressMessage,
  studioUserMessage,
} from './studioProjection';

test('Studio projection formats user, progress, completion, and error rows', () => {
  assert.equal(studioUserMessage('ship it'), '[studio] ship it');
  assert.deepEqual(studioProgressMessage({
    type: 'studio.progress',
    requestId: 'studio-1',
    event: {
      type: 'task_started',
      taskIndex: 2,
      petId: 'planner',
    },
  }), {
    role: 'system',
    requestId: 'studio-1',
    text: '[studio] task 2 started · planner',
  });
  assert.equal(studioProgressMessage({
    type: 'studio.progress',
    requestId: 'studio-1',
    event: { type: 'turn_started' },
  }), null);
  assert.deepEqual(studioCompletionMessages({
    requestId: 'studio-1',
    outcome: 'stopped',
    reply: 'Partial result',
    reason: 'budget reached',
  }), [{
    role: 'assistant',
    requestId: 'studio-1',
    text: 'Partial result',
  }, {
    role: 'system',
    requestId: 'studio-1',
    text: '[studio] stopped: budget reached',
  }]);
  assert.deepEqual(studioErrorMessage('studio-2', ''), {
    role: 'system',
    requestId: 'studio-2',
    text: '[studio error] unknown Studio error',
  });
});
