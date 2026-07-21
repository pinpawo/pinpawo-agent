import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeNativeMessage, NativeMessageDecoder } from './framing';

test('native messaging decoder handles split and combined Chrome frames', () => {
  const first = encodeNativeMessage({ id: 1 });
  const second = encodeNativeMessage({ id: 2 });
  const decoder = new NativeMessageDecoder();

  assert.deepEqual(decoder.push(first.subarray(0, 3)), []);
  assert.deepEqual(decoder.push(Buffer.concat([first.subarray(3), second])), [
    { id: 1 },
    { id: 2 },
  ]);
});

test('native messaging rejects oversized frames before buffering their bodies', () => {
  const header = Buffer.alloc(4);
  header.writeUInt32LE(101, 0);
  assert.throws(() => new NativeMessageDecoder(100).push(header), /exceeds 100 bytes/);
  assert.throws(() => encodeNativeMessage({ text: 'large' }, 1), /exceeds 1 bytes/);
});
