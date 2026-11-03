import assert from 'node:assert/strict';
import test from 'node:test';
import { assertArtifactRef, createArtifactUri, parseArtifactUri } from './artifact';

test('stable artifact keys round-trip without treating encoded names as URL query data', () => {
  const key = 'local-workspace/dGhyZWFkLzE/id/' + encodeURIComponent('结果 #1?.txt');
  assert.deepEqual(parseArtifactUri(createArtifactUri(key)), { key });
  const ref = { uri: createArtifactUri(key), name: '结果 #1?.txt', mimeType: 'text/plain',
    size: 0, sha256: 'a'.repeat(64), createdAt: new Date(0).toISOString() };
  assert.doesNotThrow(() => assertArtifactRef(JSON.parse(JSON.stringify(ref))));
});

test('artifact keys reject path escapes and ambiguous URI components', () => {
  for (const uri of ['https://example.test/file', 'artifact://', 'artifact://a//b', 'artifact://a/../b',
    'artifact://a/%2e%2e/b', 'artifact://a/%2f/b', 'artifact://a/%5c/b', 'artifact://a/%00/b',
    'artifact://a/%/b', 'artifact://a/file?query=1', 'artifact://a/file#fragment', 'artifact://a/raw name']) {
    assert.throws(() => parseArtifactUri(uri), TypeError, uri);
  }
});

test('persisted artifact metadata validates byte count and checksum', () => {
  const ref = { uri: 'artifact://space/thread/id/file', name: 'file', mimeType: 'application/octet-stream',
    size: 2, sha256: 'a'.repeat(64), createdAt: new Date(0).toISOString() };
  for (const change of [{ size: -1 }, { size: 0.5 }, { sha256: 'bad' }, { name: '' }, { title: 1 }]) {
    assert.throws(() => assertArtifactRef({ ...ref, ...change }), TypeError);
  }
});
