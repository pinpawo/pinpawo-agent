import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('MV3 service worker has no top-level await startup statement', async () => {
  const source = await readFile(
    resolve(dirname(fileURLToPath(import.meta.url)), 'background.js'),
    'utf8',
  );

  assert.doesNotMatch(source, /^await\s/m);
  assert.match(source, /void initialize\(\)\.catch/);
});
