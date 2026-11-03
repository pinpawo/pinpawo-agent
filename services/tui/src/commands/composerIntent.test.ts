import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveComposerIntent } from './composerIntent';

test('composer intent routes chat and slash commands', () => {
  assert.deepEqual(resolveComposerIntent({
    text: 'hello',
    attachmentCount: 0,
    mode: 'chat',
  }), {
    type: 'submit-chat',
    text: 'hello',
  });
  assert.deepEqual(resolveComposerIntent({
    text: '/model',
    attachmentCount: 0,
    mode: 'chat',
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

test('composer intent routes manual context compaction', () => {
  assert.deepEqual(resolveComposerIntent({
    text: '/compact',
    attachmentCount: 0,
    mode: 'chat',
  }), { type: 'compact-session' });
});

test('composer intent routes a session snapshot refresh', () => {
  assert.deepEqual(resolveComposerIntent({
    text: '/refresh',
    attachmentCount: 0,
    mode: 'chat',
  }), { type: 'refresh-session' });
});

test('composer intent copies the latest completed assistant reply', () => {
  assert.deepEqual(resolveComposerIntent({
    text: '/copy',
    attachmentCount: 0,
    mode: 'chat',
  }), { type: 'copy-latest-reply' });
  assert.deepEqual(resolveComposerIntent({
    text: '/copy extra',
    attachmentCount: 0,
    mode: 'chat',
  }), { type: 'notice', message: 'usage: /copy' });
});

test('artifact downloads are explicit client actions and malformed requests never become chat', () => {
  const uri = 'artifact://workspace/session/object/report.txt';
  assert.deepEqual(resolveComposerIntent({ text: `/download ${uri}`, attachmentCount: 0, mode: 'chat' }),
    { type: 'download-artifact', uri });
  // Keys remain opaque; the download client does not invent a stricter key schema.
  assert.deepEqual(resolveComposerIntent({ text: '/download artifact://opaque-key', attachmentCount: 0, mode: 'chat' }),
    { type: 'download-artifact', uri: 'artifact://opaque-key' });
  for (const text of ['/download', '/download https://example.test/file', '/download artifact://a/../file', `/download ${uri} extra`]) {
    assert.equal(resolveComposerIntent({ text, attachmentCount: 0, mode: 'chat' }).type, 'notice');
  }
  assert.equal(resolveComposerIntent({ text: `/download ${uri}`, attachmentCount: 1, mode: 'chat' }).type, 'notice');
});

test('composer intent treats the removed continuation command as unknown', () => {
  assert.deepEqual(resolveComposerIntent({
    text: '/continue',
    attachmentCount: 0,
    mode: 'chat',
  }), {
    type: 'notice',
    message: 'unknown command: /continue · use /help',
  });
  assert.deepEqual(resolveComposerIntent({
    text: '/continue keep the exact patch',
    attachmentCount: 0,
    mode: 'chat',
  }), {
    type: 'notice',
    message: 'unknown command: /continue keep the exact patch · use /help',
  });
});
