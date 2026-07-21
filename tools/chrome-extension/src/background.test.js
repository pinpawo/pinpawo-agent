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

test('snapshot reads enforce snapshot URL and post-read committed origin checks', async () => {
  const source = await readFile(
    resolve(dirname(fileURLToPath(import.meta.url)), 'background.js'),
    'utf8',
  );
  const readSnapshot = source.match(
    /async function readSnapshot\(tabId, approvedOrigin\) \{([\s\S]*?)\n\}/,
  )?.[1] ?? '';

  assert.match(readSnapshot, /validateSnapshotOrigin\(snapshot, approvedOrigin\)/);
  assert.ok(
    (readSnapshot.match(/await assertApprovedOrigin\(tabId, approvedOrigin\)/g) ?? []).length >= 2,
    'readSnapshot must check the committed origin before and after snapshot collection',
  );
});
