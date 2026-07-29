import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveComposerIntent } from './composerIntent';

test('composer intent routes chat, Studio, and slash commands', () => {
  assert.deepEqual(resolveComposerIntent({
    text: 'hello',
    attachmentCount: 0,
    mode: 'chat',
    canContinueActiveDelegation: false,
  }), {
    type: 'submit-chat',
    text: 'hello',
  });
  assert.deepEqual(resolveComposerIntent({
    text: 'build it',
    attachmentCount: 0,
    mode: 'studio',
    canContinueActiveDelegation: false,
  }), {
    type: 'submit-studio',
    text: 'build it',
    enterMode: false,
  });
  assert.deepEqual(resolveComposerIntent({
    text: '/studio inspect',
    attachmentCount: 0,
    mode: 'chat',
    canContinueActiveDelegation: false,
  }), {
    type: 'submit-studio',
    text: 'inspect',
    enterMode: true,
  });
  assert.deepEqual(resolveComposerIntent({
    text: '/studio',
    attachmentCount: 0,
    mode: 'studio',
    canContinueActiveDelegation: false,
  }), {
    type: 'enter-chat',
  });
});

test('composer intent keeps slash text literal when attachments are selected', () => {
  assert.deepEqual(resolveComposerIntent({
    text: '/new',
    attachmentCount: 1,
    mode: 'chat',
    canContinueActiveDelegation: false,
  }), {
    type: 'submit-chat',
    text: '/new',
  });
});

test('composer intent validates delegation continuation before execution', () => {
  assert.deepEqual(resolveComposerIntent({
    text: '/continue',
    attachmentCount: 0,
    mode: 'chat',
    canContinueActiveDelegation: true,
  }), {
    type: 'notice',
    message: 'provide guidance: /continue <guidance>',
  });
  assert.deepEqual(resolveComposerIntent({
    text: '/continue keep the exact patch',
    attachmentCount: 0,
    mode: 'chat',
    canContinueActiveDelegation: false,
  }), {
    type: 'notice',
    message: 'no suspended delegation is available for this session',
  });
  assert.deepEqual(resolveComposerIntent({
    text: '/continue keep the exact patch',
    attachmentCount: 0,
    mode: 'chat',
    canContinueActiveDelegation: true,
  }), {
    type: 'continue-delegation',
    guidance: 'keep the exact patch',
  });
});
