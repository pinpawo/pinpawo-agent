import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import test from 'node:test';
import { receive } from './protocol';

test('fragmented multibyte frames and adjacent frames are decoded once each', () => {
  const messages: Array<Record<string, unknown>> = [];
  const socket = new EventEmitter() as unknown as Socket;
  receive(socket, message => messages.push(message));
  const frame = Buffer.from(JSON.stringify({ text: '中文'.repeat(100_000) }) + '\n');
  for (let offset = 0; offset < frame.length; offset += 4096) {
    socket.emit('data', frame.subarray(offset, offset + 4096));
  }
  socket.emit('data', Buffer.from('{"second":true}\n{"third":true}\n'));
  assert.equal(messages.length, 3);
  assert.equal(messages[0]?.text, '中文'.repeat(100_000));
  assert.deepEqual(messages.slice(1), [{ second: true }, { third: true }]);
});
