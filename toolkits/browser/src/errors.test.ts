import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BrowserOperationError,
  formatBrowserToolError,
  normalizeBrowserError,
} from './errors';

test('browser errors preserve driver codes, retryability and safe details', () => {
  assert.deepEqual(normalizeBrowserError(new BrowserOperationError(
    'origin_changed',
    'Origin changed',
    false,
    { approvedOrigin: 'https://example.com', actualOrigin: 'https://login.example.com' },
  )), {
    code: 'origin_changed',
    message: 'Origin changed',
    retryable: false,
    details: {
      approvedOrigin: 'https://example.com',
      actualOrigin: 'https://login.example.com',
    },
  });
});

test('browser errors classify common Playwright failures', () => {
  assert.equal(
    normalizeBrowserError(new Error('Stale browser element reference. Take a new snapshot.')).code,
    'stale_element_reference',
  );
  assert.equal(
    normalizeBrowserError(new Error('Browser target closed before the operation completed.')).code,
    'target_closed',
  );
  assert.equal(
    normalizeBrowserError(Object.assign(new Error('locator.click: Timeout 15000ms exceeded'), {
      name: 'TimeoutError',
    })).code,
    'browser_timeout',
  );
});

test('browser tool errors use a stable JSON envelope', () => {
  const payload = JSON.parse(formatBrowserToolError(
    new BrowserOperationError('target_closed', 'Target closed', true),
  )) as { ok: boolean; error: { code: string; retryable: boolean } };

  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, 'target_closed');
  assert.equal(payload.error.retryable, true);
});
