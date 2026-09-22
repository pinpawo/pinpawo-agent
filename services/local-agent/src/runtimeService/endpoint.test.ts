import assert from 'node:assert/strict';
import { chmod, lstat, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { RuntimeClient } from './client';
import { runtimeServicePaths } from './config';
import { ensureRuntimeEndpointDirectory, validateRuntimeEndpoint } from './endpoint';
import { startRuntimeService } from './server';

const unix = { skip: process.platform === 'win32' };
async function fixture(t: TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ppr-path-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('the Unix endpoint has a stable, short, private namespace outside the config path', unix, async (t) => {
  const root = await fixture(t);
  const paths = runtimeServicePaths(join(root, 'a-long-config-directory-'.repeat(8)));
  const socketDirectory = dirname(paths.endpoint);
  t.after(() => rm(socketDirectory, { recursive: true, force: true }));
  assert.notEqual(socketDirectory, tmpdir());
  assert.equal(paths.endpoint, runtimeServicePaths(paths.root).endpoint);
  assert.notEqual(paths.endpoint, runtimeServicePaths(join(root, 'other')).endpoint);
  assert.ok(Buffer.byteLength(paths.endpoint) < 104, 'Fits macOS Unix socket path limit.');
  await Promise.all([
    ensureRuntimeEndpointDirectory(paths.endpoint),
    ensureRuntimeEndpointDirectory(paths.endpoint),
  ]);
  const stat = await lstat(socketDirectory);
  assert.equal(stat.uid, process.getuid!());
  assert.equal(stat.mode & 0o777, 0o700);
  await assert.rejects(validateRuntimeEndpoint(paths.endpoint), { code: 'ENOENT' });
});

test('permissive endpoint directories are rejected before connecting or listening', unix, async (t) => {
  const directory = await fixture(t);
  const endpoint = join(directory, 's');
  await chmod(directory, 0o755);
  await assert.rejects(ensureRuntimeEndpointDirectory(endpoint), { code: 'invalid_endpoint' });
  await assert.rejects(RuntimeClient.connect({ endpoint, token: 'unused-test-token', toolkits: {} }), { code: 'invalid_endpoint' });
  await assert.rejects(startRuntimeService({ endpoint, token: 'unused-test-token',
    config: { instances: {}, toolkitBindings: {} }, factories: {},
  }), { code: 'invalid_endpoint' });
  assert.equal((await lstat(directory)).mode & 0o777, 0o755, 'Do not silently repair an untrusted directory.');
  await assert.rejects(lstat(endpoint), { code: 'ENOENT' });
});

test('linked directories, linked endpoints and regular files cannot be Runtime sockets', unix, async (t) => {
  const directory = await fixture(t);
  const alias = join(directory, 'alias');
  await symlink(directory, alias);
  await assert.rejects(ensureRuntimeEndpointDirectory(join(alias, 's')), { code: 'invalid_endpoint' });
  await assert.rejects(validateRuntimeEndpoint(join(alias, 's')), { code: 'invalid_endpoint' });
  const file = join(directory, 'file');
  await writeFile(file, 'fixture');
  await assert.rejects(validateRuntimeEndpoint(file), { code: 'invalid_endpoint' });
  const link = join(directory, 's');
  await symlink(file, link);
  await assert.rejects(RuntimeClient.connect({ endpoint: link, token: 'unused-test-token', toolkits: {} }), { code: 'invalid_endpoint' });
});
