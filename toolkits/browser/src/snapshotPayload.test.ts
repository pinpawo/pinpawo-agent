import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildBrowserExtractPayloadFromRaw,
  buildBrowserSnapshotPayload,
  parseBrowserRawExtract,
  parseBrowserRawSnapshot,
} from './snapshotPayload';

test('raw browser snapshots are validated and normalized before payload building', () => {
  const raw = parseBrowserRawSnapshot({
    title: 'Example',
    url: 'https://example.com/',
    text: 'body',
    textSource: 'Runtime.evaluate',
    interactive: [{
      index: 1,
      ref: 'snapshot:1',
      tag: 'button',
      text: 'Go',
      type: 'submit',
      placeholder: null,
      hint: '[1] button "Go"',
      backendNodeId: 12,
    }],
    interactiveCount: 1,
  });

  assert.equal(raw.interactive[0]?.backendNodeId, 12);
  assert.equal(raw.interactive[0]?.ref, 'snapshot:1');
  assert.equal(buildBrowserSnapshotPayload(raw).textSource, 'Runtime.evaluate');
});

test('raw extension extract windows are validated and normalized locally', () => {
  const raw = parseBrowserRawExtract({
    title: 'Example',
    url: 'https://example.com/',
    text: 'world',
    textLength: 11,
    offset: 6,
    limit: 5,
    textSource: 'document.body.innerText',
  });
  const payload = buildBrowserExtractPayloadFromRaw(raw);
  assert.equal(payload.text, 'world');
  assert.equal(payload.textEndOffset, 11);
  assert.equal(payload.hasMore, false);
  assert.equal(payload.truncated, true);
  assert.throws(() => parseBrowserRawExtract({
    ...raw,
    offset: 9,
  }), /fit within textLength/);
});

test('snapshot builder applies the canonical interactive preview cap', () => {
  const interactive = Array.from({ length: 25 }, (_, index) => ({
    index: index + 1,
    tag: 'button',
    text: String(index + 1),
    type: null,
    placeholder: null,
    hint: `[${index + 1}] button`,
  }));
  const payload = buildBrowserSnapshotPayload({
    title: 'Many controls',
    url: 'https://example.com/',
    text: '',
    interactive,
  });

  assert.equal(payload.interactive.length, 20);
  assert.equal(payload.interactive[0]?.hint, '[1] button');
  assert.equal(payload.interactiveCount, 25);
  assert.equal(payload.returnedInteractiveCount, 20);
  assert.equal(payload.interactiveTruncated, true);
});

test('snapshot builder replaces an untrusted hint prefix with the canonical index', () => {
  const payload = buildBrowserSnapshotPayload({
    title: 'Example',
    url: 'https://example.com',
    text: '',
    interactive: [{
      index: 7,
      tag: 'button',
      text: 'Continue',
      type: null,
      placeholder: null,
      hint: '[99] text=Continue',
    }],
  });

  assert.equal(payload.interactive[0]?.hint, '[7] text=Continue');
});

test('snapshot builder preserves full text length when raw IPC text is bounded', () => {
  const payload = buildBrowserSnapshotPayload(parseBrowserRawSnapshot({
    title: 'Bounded backend result',
    url: 'https://example.com/',
    text: 'x'.repeat(60_000),
    textLength: 3_000_000,
    interactive: [],
  }));

  assert.equal(payload.text.length, 50_000);
  assert.equal(payload.textLength, 3_000_000);
  assert.equal(payload.hasMore, true);
  assert.equal(payload.nextTextOffset, 50_000);
});

test('raw snapshot parser rejects malformed and oversized backend data', () => {
  assert.throws(
    () => parseBrowserRawSnapshot({
      title: 'Bad',
      url: 'https://example.com/',
      text: '',
      interactive: [{ index: 0, tag: 'a', text: '', hint: 'a' }],
    }),
    /positive integer/,
  );
  assert.throws(
    () => parseBrowserRawSnapshot({
      title: 'Bad',
      url: 'https://example.com/',
      text: '',
      interactive: Array.from({ length: 201 }, () => ({})),
    }),
    /at most 200/,
  );
  assert.throws(
    () => parseBrowserRawSnapshot({
      title: 'Bad',
      url: 'https://example.com/',
      text: '',
      interactive: [
        { index: 1, tag: 'a', text: '', type: null, placeholder: null, hint: 'a' },
        { index: 1, tag: 'button', text: '', type: null, placeholder: null, hint: 'button' },
      ],
    }),
    /indexes must be unique/,
  );
});
