import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { getLocalToolsWorkdir, setLocalToolsWorkdir } from '../local/pathUtils';
import { persistBrowserScreenshot } from './screenshot';

test('browser screenshots are persisted inside the workdir with private permissions', async (t) => {
  const previous = getLocalToolsWorkdir();
  const workdir = await mkdtemp(resolve(tmpdir(), 'pinpawo-screenshot-'));
  setLocalToolsWorkdir(workdir);
  t.after(() => setLocalToolsWorkdir(previous));

  const payload = JSON.parse(await persistBrowserScreenshot({
    mimeType: 'image/png',
    data: Buffer.from('image-bytes').toString('base64'),
  })) as { path: string; byteLength: number };

  assert.equal(payload.byteLength, 11);
  assert.ok(payload.path.startsWith(resolve(workdir, '.pinpawo', 'browser', 'screenshots')));
  assert.equal(await readFile(payload.path, 'utf8'), 'image-bytes');
  assert.equal((await stat(resolve(payload.path, '..'))).mode & 0o777, 0o700);
  assert.equal((await stat(payload.path)).mode & 0o777, 0o600);
  await assert.rejects(
    persistBrowserScreenshot({ mimeType: 'image/jpeg', data: 'not base64!' }),
    /must be base64/,
  );
});
