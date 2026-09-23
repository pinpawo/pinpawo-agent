import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { receive } from './protocol';

test('fragmented multibyte frames and adjacent frames are decoded once each', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ppr-protocol-'));
  const endpoint = process.platform === 'win32'
    ? `\\\\.\\pipe\\ppr-protocol-${process.pid}-${Date.now()}` : join(directory, 's');
  const messages: Array<Record<string, unknown>> = [];
  const server = createServer(socket => receive(socket, message => messages.push(message)));
  try {
    await new Promise<void>(resolve => server.listen(endpoint, resolve));
    const socket = connect(endpoint);
    await new Promise<void>(resolve => socket.once('connect', resolve));
    const frame = Buffer.from(JSON.stringify({ text: '中文'.repeat(100_000) }) + '\n');
    for (let offset = 0; offset < frame.length; offset += 4096) {
      socket.write(frame.subarray(offset, offset + 4096));
    }
    socket.write('{"second":true}\n{"third":true}\n');
    await new Promise<void>(resolve => socket.end(resolve));
    for (let attempt = 0; messages.length < 3 && attempt < 100; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(messages.length, 3);
    assert.equal(messages[0]?.text, '中文'.repeat(100_000));
    assert.deepEqual(messages.slice(1), [{ second: true }, { third: true }]);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
