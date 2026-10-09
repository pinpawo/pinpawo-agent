import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { binaryDependencyStatus, dependencyPath, installBinaryDependency, type BinaryDependency } from './binaryDependency';
import { officeDependency } from './office/dependency';

const bytes = Buffer.from('local dependency fixture, never executed');
const dependency: BinaryDependency = {
  toolkit: 'office', version: 'test', filename: 'officecli',
  url: 'https://example.invalid/officecli', sha256: createHash('sha256').update(bytes).digest('hex'),
};

test('explicit install verifies bytes, status and idempotency in a path with spaces', async () => {
  const root = await mkdtemp(join(tmpdir(), 'office install '));
  let downloads = 0;
  const download = (async () => { downloads += 1; return new Response(bytes); }) as typeof fetch;
  try {
    assert.equal((await binaryDependencyStatus(dependency, root)).state, 'missing');
    const installed = await installBinaryDependency(dependency, { root, fetch: download });
    assert.equal(installed.state, 'installed');
    assert.equal(installed.alreadyInstalled, false);
    assert.deepEqual(await readFile(installed.path), bytes);
    assert.equal((await installBinaryDependency(dependency, { root, fetch: download })).alreadyInstalled, true);
    assert.equal(downloads, 1);
    await writeFile(installed.path, 'corrupt');
    assert.equal((await binaryDependencyStatus(dependency, root)).state, 'invalid');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('HTTP and checksum failures never install or report success', async () => {
  const root = await mkdtemp(join(tmpdir(), 'office install failure '));
  try {
    await assert.rejects(installBinaryDependency(dependency, { root, fetch: (async () => new Response('failed', { status: 503 })) as typeof fetch }), /HTTP 503/);
    await assert.rejects(installBinaryDependency(dependency, { root, fetch: (async () => new Response('wrong bytes')) as typeof fetch }), /checksum mismatch/);
    assert.equal((await binaryDependencyStatus(dependency, root)).state, 'missing');
    await assert.rejects(readFile(dependencyPath(dependency, root)), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Office declares immutable release assets and rejects unsupported platforms', () => {
  assert.match(officeDependency('darwin', 'arm64').url, /iOfficeAI\/OfficeCLI\/releases\/download\/v1\.0\.156\/officecli-mac-arm64$/);
  assert.match(officeDependency('darwin', 'x64').sha256, /^[a-f0-9]{64}$/);
  assert.throws(() => officeDependency('linux', 'arm64'), /unsupported: linux\/arm64/);
});
