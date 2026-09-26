import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ResultReferenceFiles } from './resultReferenceFiles';

test('reference links open private local files, reuse identical evidence, and preserve Markdown verbatim', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'result-reference-test-'));
  try {
    const files = new ResultReferenceFiles(root);
    const ref = { id: '../../escape', title: 'Task <script>', text: '# Result\n\n**Evidence** & data\n\n```ts\nconst value = 1;\n```\n\n[Source](https://example.com)\n\n| Key | Value |\n| --- | --- |\n| a | b |\n\n<details>Original markup</details>\n' };
    const url = files.url(ref);
    assert.equal(files.url({ ...ref }), url);
    const filePath = fileURLToPath(url);
    assert.equal(path.relative(root, filePath).startsWith('..'), false);
    assert.equal(path.extname(filePath), '.md');
    assert.equal(readFileSync(filePath, 'utf8'), ref.text);
    assert.equal(statSync(filePath).mode & 0o777, 0o600);
    assert.equal(readdirSync(path.dirname(filePath)).length, 1);
    assert.notEqual(files.url({ ...ref, text: 'changed evidence' }), url);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
