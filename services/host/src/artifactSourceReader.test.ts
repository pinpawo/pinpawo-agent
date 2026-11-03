import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readlink, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { promisify } from 'node:util';
import test from 'node:test';
import { readLocalArtifactSource } from './artifactSourceReader';

async function fixture(t: { after: (run: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'pinpawo-artifact-source-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function bytes(body: ReadableStream<Uint8Array>) {
  const chunks: Uint8Array[] = [];
  for await (const chunk of body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

test('source reader resolves a relative file against the call workdir', async (t) => {
  const workdir = await fixture(t);
  await writeFile(join(workdir, 'report.md'), '# Report\n');
  const source = await readLocalArtifactSource({ path: 'report.md', workdir });
  assert.equal(source.name, 'report.md');
  assert.equal(source.mimeType, 'text/markdown');
  assert.equal((await bytes(source.body)).toString(), '# Report\n');
});

test('source reader preserves absolute paths independently of workdir', async (t) => {
  const root = await fixture(t);
  const file = join(root, 'data.bin');
  const content = Buffer.from([0, 255, 17, 128]);
  await writeFile(file, content);
  const source = await readLocalArtifactSource({ path: file, workdir: join(root, 'unused') });
  assert.equal(source.name, 'data.bin');
  assert.equal(source.mimeType, 'application/octet-stream');
  assert.deepEqual(await bytes(source.body), content);
});

test('source reader supports empty files and common document MIME types', async (t) => {
  const root = await fixture(t);
  const cases = [
    ['empty.PDF', 'application/pdf'],
    ['sheet.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['document.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['slide.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
    ['image.png', 'image/png'], ['data.json', 'application/json'],
  ];
  for (const [name, mimeType] of cases) {
    await writeFile(join(root, name), '');
    const source = await readLocalArtifactSource({ path: join(root, name), workdir: null });
    assert.equal(source.mimeType, mimeType);
    assert.equal((await bytes(source.body)).length, 0);
  }
});

test('source reader follows file symlinks using ordinary Files read semantics', async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, 'actual.txt'), 'shared source');
  await symlink('actual.txt', join(root, 'linked.txt'));
  const source = await readLocalArtifactSource({ path: 'linked.txt', workdir: root });
  assert.equal(source.name, 'linked.txt');
  assert.equal((await bytes(source.body)).toString(), 'shared source');
});

test('source reader rejects a directory, missing file, empty path and unscoped relative file', async (t) => {
  const root = await fixture(t);
  await assert.rejects(readLocalArtifactSource({ path: root, workdir: null }), /regular file/);
  await assert.rejects(readLocalArtifactSource({ path: join(root, 'missing'), workdir: null }), { code: 'ENOENT' });
  await assert.rejects(readLocalArtifactSource({ path: '', workdir: root }), /file path/);
  await assert.rejects(readLocalArtifactSource({ path: 'relative.txt', workdir: null }), /workdir/);
});

test('source reader rejects a FIFO without waiting for a writer', { skip: process.platform === 'win32' }, async (t) => {
  const root = await fixture(t);
  const fifo = join(root, 'fifo');
  await promisify(execFile)('mkfifo', [fifo]);
  await assert.rejects(readLocalArtifactSource({ path: fifo, workdir: null }), /regular file/);
});

async function sourceIsOpen(file: string) {
  const paths = await readdir('/proc/self/fd');
  const links = await Promise.all(paths.map(fd => readlink(`/proc/self/fd/${fd}`).catch(() => '')));
  return links.includes(file);
}

test('canceling the source stream closes its file descriptor', { skip: process.platform !== 'linux' }, async (t) => {
  const root = await fixture(t);
  const file = join(root, 'stream.bin');
  await writeFile(file, Buffer.alloc(1024 * 1024, 7));
  const source = await readLocalArtifactSource({ path: file, workdir: null });
  const reader = source.body.getReader();
  const first = await reader.read();
  assert.equal(first.done, false);
  assert.ok(first.value && first.value.byteLength <= 64 * 1024);
  assert.equal(await sourceIsOpen(file), true);
  await reader.cancel();
  for (let attempt = 0; attempt < 20 && await sourceIsOpen(file); attempt += 1) await setImmediate();
  assert.equal(await sourceIsOpen(file), false);
});
