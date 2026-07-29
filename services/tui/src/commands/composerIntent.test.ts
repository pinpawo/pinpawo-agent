import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveComposerIntent } from './composerIntent';

test('composer intent routes chat, Studio, and slash commands', () => {
  assert.deepEqual(resolveComposerIntent({
    text: 'hello',
    attachmentCount: 0,
    mode: 'chat',
  }), {
    type: 'submit-chat',
    text: 'hello',
  });
  assert.deepEqual(resolveComposerIntent({
    text: 'build it',
    attachmentCount: 0,
    mode: 'studio',
  }), {
    type: 'submit-studio',
    text: 'build it',
    enterMode: false,
  });
  assert.deepEqual(resolveComposerIntent({
    text: '/studio inspect',
    attachmentCount: 0,
    mode: 'chat',
  }), {
    type: 'submit-studio',
    text: 'inspect',
    enterMode: true,
  });
  assert.deepEqual(resolveComposerIntent({
    text: '/studio',
    attachmentCount: 0,
    mode: 'studio',
  }), {
    type: 'enter-chat',
  });
  assert.deepEqual(resolveComposerIntent({
    text: '/model',
    attachmentCount: 0,
    mode: 'studio',
    canContinueActiveDelegation: false,
  }), {
    type: 'open-model',
  });
});

test('composer intent keeps slash text literal when attachments are selected', () => {
  assert.deepEqual(resolveComposerIntent({
    text: '/new',
    attachmentCount: 1,
    mode: 'chat',
  }), {
    type: 'submit-chat',
    text: '/new',
  });
});

test('composer intent requires continuation guidance before execution', () => {
  assert.deepEqual(resolveComposerIntent({
    text: '/continue',
    attachmentCount: 0,
    mode: 'chat',
  }), {
    type: 'notice',
    message: 'provide guidance: /continue <guidance>',
  });
  assert.deepEqual(resolveComposerIntent({
    text: '/continue keep the exact patch',
    attachmentCount: 0,
    mode: 'chat',
  }), {
    type: 'continue-delegation',
    guidance: 'keep the exact patch',
  });
});
