import assert from 'node:assert/strict';
import test from 'node:test';
import { createTuiMessage } from './tuiMessage';

test('createTuiMessage creates canonical message ids and ISO timestamps', () => {
  const message = createTuiMessage({
    role: 'system',
    text: 'ready',
  }, 1_700_000_000_000);

  assert.match(message.id, /^message:/);
  assert.equal(message.createdAt, '2023-11-14T22:13:20.000Z');
  assert.equal(message.role, 'system');
  assert.equal(message.text, 'ready');
  assert.equal('source' in message, false);
});
