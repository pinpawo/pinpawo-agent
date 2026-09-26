import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ResultReferenceFiles } from './resultReferenceFiles';

test('reference links open private local files, reuse identical evidence, and escape active content', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'result-reference-test-'));
  try {
    const files = new ResultReferenceFiles(root);
    const ref = { id: '../../escape', title: 'Task <script>', text: '<script>alert(1)</script>\nEvidence & data' };
    const url = files.url(ref);
    assert.equal(files.url({ ...ref }), url);
    const filePath = fileURLToPath(url);
    assert.equal(path.relative(root, filePath).startsWith('..'), false);
    const html = readFileSync(filePath, 'utf8');
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /default-src 'none'/);
    assert.equal(statSync(filePath).mode & 0o777, 0o600);
    assert.equal(readdirSync(path.dirname(filePath)).length, 1);
    assert.notEqual(files.url({ ...ref, text: 'changed evidence' }), url);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
