import assert from 'node:assert/strict';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createStudioCredentialsKey, readStudioCredentialsKey } from './credentialsKey';

test('a created key is owner-only, 32 bytes, and never replaced', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'studio-credentials-key-'));
  const file = path.join(dir, 'credentials.key');
  await createStudioCredentialsKey(file);
  assert.equal((await readStudioCredentialsKey(file)).byteLength, 32);
  await assert.rejects(createStudioCredentialsKey(file), /EEXIST/);
});

test('a relative, missing, readable-by-others or malformed key file is refused', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'studio-credentials-key-'));
  const file = path.join(dir, 'credentials.key');
  await assert.rejects(readStudioCredentialsKey('credentials.key'), /absolute/);
  await assert.rejects(readStudioCredentialsKey(file), /cannot be read/);
  await writeFile(file, `${Buffer.alloc(16).toString('base64')}\n`, { mode: 0o600 });
  await assert.rejects(readStudioCredentialsKey(file), /32 bytes/);
  if (process.platform !== 'win32') {
    await writeFile(file, `${Buffer.alloc(32).toString('base64')}\n`);
    await chmod(file, 0o644);
    await assert.rejects(readStudioCredentialsKey(file), /chmod 600/);
  }
});
