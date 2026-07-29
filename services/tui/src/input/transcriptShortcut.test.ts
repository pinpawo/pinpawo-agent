import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldOpenTranscriptPager } from './transcriptShortcut';

test('PageUp opens transcript only from an empty attachment-free composer', () => {
  assert.equal(shouldOpenTranscriptPager({
    key: { name: 'pageup' },
    composerText: '',
    attachmentCount: 0,
  }), true);
  assert.equal(shouldOpenTranscriptPager({
    key: { name: 'pageup', shift: true },
    composerText: '',
    attachmentCount: 0,
  }), false);
  assert.equal(shouldOpenTranscriptPager({
    key: { name: 'pageup' },
    composerText: 'draft',
    attachmentCount: 0,
  }), false);
  assert.equal(shouldOpenTranscriptPager({
    key: { name: 'pageup' },
    composerText: '',
    attachmentCount: 1,
  }), false);
});
