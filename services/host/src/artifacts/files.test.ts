import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { readArtifactSource } from './files';

test('artifact source MIME inference recognizes WebP case-insensitively and retains existing fallbacks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'artifact-source-mime-'));
  const bytes = Buffer.from('source bytes');
  try {
    for (const [name, mimeType] of [
      ['image.webp', 'image/webp'],
      ['image.WEBP', 'image/webp'],
      ['image.WeBp', 'image/webp'],
      ['image.png', 'image/png'],
      ['image.jpg', 'image/jpeg'],
      ['image.jpeg', 'image/jpeg'],
      ['notes.txt', 'text/plain'],
      ['unknown.bin', 'application/octet-stream'],
      ['no-extension', 'application/octet-stream'],
    ] as const) {
      await writeFile(join(root, name), bytes);
      const source = await readArtifactSource({ path: name, workdir: root });
      assert.equal(source.name, name);
      assert.deepEqual(Buffer.from(await new Response(source.body).arrayBuffer()), bytes);
      assert.equal(source.mimeType, mimeType, name);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
