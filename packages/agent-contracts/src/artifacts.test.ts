import assert from 'node:assert/strict';
import test from 'node:test';
import { parseArtifactUri, parseDeliverables, readToolDeliverables } from './artifacts';

test('tool declarations validate independently of tool content and retain exact reference values', () => {
  const declared = [{ uri: 'https://example.com/PR/1?view=all', title: '' }, { uri: 'artifact://Workspace/session/file/report.pdf' }];
  assert.deepEqual(readToolDeliverables({ deliverables: declared, ref: { private: true } }), declared);
  assert.deepEqual(readToolDeliverables({ ref: 'not a declaration' }), []);
  assert.deepEqual(readToolDeliverables(null), []);
  for (const value of [null, {}, 'url', [{ uri: 'relative/path' }], [{ uri: 'https://example.com', title: 1 }], [{ uri: 'https://example.com', extra: true }]]) {
    assert.throws(() => parseDeliverables(value), /Invalid deliverables/);
    assert.throws(() => readToolDeliverables({ deliverables: value }), /Invalid deliverables/);
  }
});

test('stable artifact keys preserve case and reject path escapes and malformed references', () => {
  assert.equal(parseArtifactUri('artifact://Workspace/session/file/My%20Report.pdf'), 'Workspace/session/file/My%20Report.pdf');
  for (const uri of ['https://example.com/a', 'artifact://', 'artifact:///a', 'artifact://a//b', 'artifact://a/../b', 'artifact://a/%2e%2e/b', 'artifact://a/%2Fetc', 'artifact://a/x?query', 'artifact://a/x#hash', 'artifact://a/%00', 'artifact://a/\\x', 'artifact://a/%xx']) {
    assert.throws(() => parseArtifactUri(uri), /Invalid artifact URI/);
  }
});
