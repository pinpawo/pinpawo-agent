import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareArtifactUpload, readArtifactUploadMetadata } from './artifactUpload';
import { HttpRequestError } from './httpRequestError';

const request = (name = '报告 #100%?.png', headers: Record<string, string> = {}) => new Request(
  `http://localhost/artifacts/upload?name=${encodeURIComponent(name)}`,
  { method: 'POST', headers: { 'Content-Type': 'image/png', ...headers }, body: 'image' },
);
const isStatus = (status: number) => (error: unknown) => error instanceof HttpRequestError && error.status === status;
const bytes = (text: string) => new TextEncoder().encode(text);
const streamRequest = (body: ReadableStream<Uint8Array>, options: { signal?: AbortSignal; headers?: Record<string, string> } = {}) =>
  new Request('http://localhost/artifacts/upload?name=file.bin', {
    method: 'POST', body, duplex: 'half', ...options,
  } as RequestInit);

test('upload metadata is a single safe filename and opaque file media type, never a caller-selected path', () => {
  assert.deepEqual(readArtifactUploadMetadata(request()), { name: '报告 #100%?.png', mimeType: 'image/png' });
  assert.deepEqual(readArtifactUploadMetadata(request('data.json', { 'Content-Type': 'application/json; charset=utf-8' })),
    { name: 'data.json', mimeType: 'application/json' });
  for (const name of ['', '.', '..', '../config', '/tmp/file', 'C:\\secret.txt', 'a\rb', 'a\0b', ' padded ', '中'.repeat(81)]) {
    assert.throws(() => readArtifactUploadMetadata(request(name)), isStatus(400), name);
  }
  for (const suffix of ['&name=second', '&threadId=chosen', '&path=chosen', '&uri=artifact://chosen']) {
    const invalid = new Request(request().url + suffix, request());
    assert.throws(() => readArtifactUploadMetadata(invalid), isStatus(400));
  }
  for (const type of ['multipart/form-data; boundary=boundary', 'multipart/mixed', 'text', 'text/*', 'application/a b']) {
    assert.throws(() => readArtifactUploadMetadata(request('file', { 'Content-Type': type })), isStatus(415));
  }
  assert.throws(() => readArtifactUploadMetadata(request('file', { 'Content-Encoding': 'gzip' })), isStatus(415));
  const noType = new Request('http://localhost/artifacts/upload?name=file', {
    method: 'POST', body: new Uint8Array([1]),
  });
  assert.throws(() => readArtifactUploadMetadata(noType), isStatus(415));
});

test('streaming upload accepts the exact limit and validates declared length before reading', async () => {
  assert.throws(() => prepareArtifactUpload(new Request('http://localhost/', { method: 'POST' }),
    { maxBytes: 5, timeoutMs: 500 }), isStatus(400));
  const cancelled = new AbortController();
  cancelled.abort();
  assert.throws(() => prepareArtifactUpload(streamRequest(new ReadableStream(), { signal: cancelled.signal }),
    { maxBytes: 5, timeoutMs: 500 }), isStatus(400));
  const valid = prepareArtifactUpload(request('file', { 'Content-Length': '5' }), { maxBytes: 5, timeoutMs: 500 });
  try { assert.equal(await new Response(valid.body).text(), 'image'); } finally { valid.dispose(); }
  assert.throws(() => prepareArtifactUpload(request('file', { 'Content-Length': '6' }), { maxBytes: 5, timeoutMs: 500 }), isStatus(413));
  for (const length of ['no', '-1', '1.5', '9007199254740992']) {
    assert.throws(() => prepareArtifactUpload(request('file', { 'Content-Length': length }), { maxBytes: 5, timeoutMs: 500 }), isStatus(400));
  }
  const mismatch = prepareArtifactUpload(request('file', { 'Content-Length': '4' }), { maxBytes: 5, timeoutMs: 500 });
  try { await assert.rejects(new Response(mismatch.body).text(), isStatus(400)); } finally { mismatch.dispose(); }
});

test('chunked uploads fail without truncation and cancel their source on overflow', async () => {
  let cancelled = false;
  let sent = 0;
  const input = streamRequest(new ReadableStream({
    pull(controller) { sent++; controller.enqueue(bytes('123')); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 }));
  const upload = prepareArtifactUpload(input, { maxBytes: 5, timeoutMs: 500 });
  try {
    await assert.rejects(new Response(upload.body).text(), isStatus(413));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(cancelled, true);
    assert.ok(sent <= 3, 'the entire upload is not read ahead');
  } finally { upload.dispose(); }
});

test('upload receive deadline errors a stalled stream and cancels its pending read', async () => {
  let cancelled = false;
  const input = streamRequest(new ReadableStream({ cancel() { cancelled = true; } }));
  const upload = prepareArtifactUpload(input, { maxBytes: 5, timeoutMs: 20 });
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(new Response(upload.body).text(), isStatus(408));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(cancelled, true);
  } finally { upload.dispose(); clearTimeout(keepAlive); }
});

test('client abort and storage rejection cancel upload sources', async () => {
  const cancellation = new AbortController();
  let cancelled = false;
  const upload = prepareArtifactUpload(streamRequest(new ReadableStream({ cancel() { cancelled = true; } }), {
    signal: cancellation.signal,
  }), { maxBytes: 5, timeoutMs: 500 });
  const reading = new Response(upload.body).text();
  cancellation.abort();
  try {
    await assert.rejects(reading, isStatus(400));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(cancelled, true);
  } finally { upload.dispose(); }

  let disposed = false;
  const rejected = prepareArtifactUpload(streamRequest(new ReadableStream({ cancel() { disposed = true; } })),
    { maxBytes: 5, timeoutMs: 500 });
  rejected.dispose();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(disposed, true);
});
