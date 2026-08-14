import assert from 'node:assert/strict';
import test from 'node:test';
import {
  studioAcceptedMessage,
  studioErrorMessage,
  studioUserMessage,
} from './studioProjection';

test('Studio projection renders the user row and the submission receipt', () => {
  assert.equal(studioUserMessage('ship it'), '[studio] ship it');

  // 提交即返回:回执不渲染 pet 的答复 —— 那时还没有产出。
  assert.deepEqual(studioAcceptedMessage({
    requestId: 'studio-1',
    outcome: 'done',
  }), [{
    role: 'system',
    requestId: 'studio-1',
    text: '[studio] 已提交',
  }]);
});

test('a stopped submission reports its reason', () => {
  assert.deepEqual(studioAcceptedMessage({
    requestId: 'studio-1',
    outcome: 'stopped',
    reason: 'budget reached',
  }), [{
    role: 'system',
    requestId: 'studio-1',
    text: '[studio] stopped: budget reached',
  }]);

  assert.deepEqual(studioAcceptedMessage({
    requestId: 'studio-1',
    outcome: 'stopped',
  }), [{
    role: 'system',
    requestId: 'studio-1',
    text: '[studio] stopped',
  }]);
});

test('Studio errors keep a readable fallback', () => {
  assert.deepEqual(studioErrorMessage('studio-2', ''), {
    role: 'system',
    requestId: 'studio-2',
    text: '[studio error] unknown Studio error',
  });
});
