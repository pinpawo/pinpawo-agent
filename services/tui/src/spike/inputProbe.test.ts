import assert from 'node:assert/strict';
import test from 'node:test';
import { formatInputProbe } from './inputProbe';

test('input probe exposes terminal control sequences without executing them', () => {
  assert.equal(
    formatInputProbe('key', '\u001b[200~/Users/mac/My File.txt\n'),
    'key: \\x1b[200~/Users/mac/My File.txt\\n',
  );
});

test('input probe keeps Unicode paths intact and bounds previews', () => {
  assert.equal(
    formatInputProbe('paste', 'file:///Users/mac/下载/猫爪.png'),
    'paste: file:///Users/mac/下载/猫爪.png',
  );
  assert.equal(
    formatInputProbe('paste', 'a'.repeat(121)),
    `paste: ${'a'.repeat(120)}…`,
  );
});
