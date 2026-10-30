import assert from 'node:assert/strict';
import test from 'node:test';
import { readMessageText } from './utils';

test('public message text excludes reasoning and thinking blocks with text fields', () => {
  assert.equal(readMessageText({ content: [
    { type: 'reasoning', text: 'private reasoning' },
    { type: 'thinking', text: 'private thought' },
    { type: 'redacted_thinking', text: 'private redaction' },
    { type: 'analysis', text: 'private analysis' },
    { type: 'reasoning_content', text: 'private provider reasoning' },
    { type: 'text', text: 'visible response' },
  ] }), 'visible response');
});
