import assert from 'node:assert/strict';
import test from 'node:test';
import { formatMessageTimestamp } from './terminalText';

test('formatMessageTimestamp renders UTC ISO strings in the client timezone', () => {
  const timestamp = '2026-06-01T01:00:00.000Z';
  const expected = new Date(timestamp).toLocaleTimeString('zh-CN', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  assert.equal(formatMessageTimestamp(timestamp), expected);
});

test('formatMessageTimestamp keeps already formatted timestamps unchanged', () => {
  assert.equal(formatMessageTimestamp('10:00:00'), '10:00:00');
});
