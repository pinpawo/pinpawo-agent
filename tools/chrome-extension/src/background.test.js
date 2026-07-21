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

test('P1 interactions stay on the CDP allowlist and re-snapshot through the origin guard', async () => {
  const source = await readFile(
    resolve(dirname(fileURLToPath(import.meta.url)), 'background.js'),
    'utf8',
  );

  for (const method of [
    'Input.dispatchMouseEvent',
    'Input.dispatchKeyEvent',
    'Page.captureScreenshot',
  ]) {
    assert.match(source, new RegExp(`'${method.replace('.', '\\.')}'`));
  }
  assert.match(source, /command\.command === 'click'[\s\S]*?dispatchClick[\s\S]*?readSnapshot/);
  assert.match(source, /command\.command === 'type'[\s\S]*?dispatchType[\s\S]*?readSnapshot/);
  assert.match(source, /command\.command === 'scroll'[\s\S]*?dispatchScroll[\s\S]*?readSnapshot/);
  assert.match(source, /async function captureScreenshot[\s\S]*?assertApprovedOrigin[\s\S]*?Page\.captureScreenshot[\s\S]*?assertApprovedOrigin/);
  assert.match(source, /for \(const character of Array\.from\(params\.text\)\)[\s\S]*?assertApprovedOrigin\(tabId, approvedOrigin\)[\s\S]*?dispatchKey/);
});
