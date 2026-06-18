import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveComposerHistoryRoute } from './composerHistoryRouting';

test('resolveComposerHistoryRoute requires both visual boundary and history availability', () => {
  assert.equal(
    resolveComposerHistoryRoute(
      { type: 'cursor.up' },
      {
        boundary: { previous: true, next: true },
        available: { previous: true, next: false },
      },
    ),
    'previous',
  );
  assert.equal(
    resolveComposerHistoryRoute(
      { type: 'cursor.up' },
      {
        boundary: { previous: false, next: true },
        available: { previous: true, next: false },
      },
    ),
    null,
  );
  assert.equal(
    resolveComposerHistoryRoute(
      { type: 'cursor.down' },
      {
        boundary: { previous: true, next: true },
        available: { previous: false, next: true },
      },
    ),
    'next',
  );
  assert.equal(
    resolveComposerHistoryRoute(
      { type: 'cursor.down' },
      {
        boundary: { previous: true, next: true },
        available: { previous: false, next: false },
      },
    ),
    null,
  );
});

test('resolveComposerHistoryRoute ignores non-vertical input', () => {
  assert.equal(
    resolveComposerHistoryRoute(
      { type: 'text.insert', text: 'x' },
      {
        boundary: { previous: true, next: true },
        available: { previous: true, next: true },
      },
    ),
    null,
  );
  assert.equal(resolveComposerHistoryRoute({ type: 'cursor.up' }, null), null);
});
