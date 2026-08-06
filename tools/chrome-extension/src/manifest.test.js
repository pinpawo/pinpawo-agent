import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

test('manifest grants browser_open access to ordinary web origins', async () => {
  const manifest = JSON.parse(await readFile(
    resolve(dirname(fileURLToPath(import.meta.url)), '..', 'manifest.json'),
    'utf8',
  ));

  assert.deepEqual(manifest.host_permissions, [
    'http://*/*',
    'https://*/*',
  ]);
});
