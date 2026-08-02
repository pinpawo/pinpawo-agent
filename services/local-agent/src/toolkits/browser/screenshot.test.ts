import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { getLocalToolsWorkdir, setLocalToolsWorkdir } from '../local/pathUtils';
import {
  createBrowserScreenshotArtifact,
  buildBrowserScreenshotMessages,
  persistBrowserScreenshot,
  readBrowserScreenshotDataUrl,
} from './screenshot';

test('browser screenshots are persisted inside the workdir with private permissions', async (t) => {
  const previous = getLocalToolsWorkdir();
  const workdir = await mkdtemp(resolve(tmpdir(), 'pinpawo-screenshot-'));
  setLocalToolsWorkdir(workdir);
  t.after(() => setLocalToolsWorkdir(previous));

  const serialized = await persistBrowserScreenshot({
    mimeType: 'image/png',
    data: Buffer.from('image-bytes').toString('base64'),
  });
  const payload = JSON.parse(serialized) as {
    path: string;
    byteLength: number;
    sha256: string;
  };

  assert.equal(payload.byteLength, 11);
  assert.match(payload.sha256, /^[a-f0-9]{64}$/);
  assert.ok(payload.path.startsWith(resolve(workdir, '.pinpawo', 'browser', 'screenshots')));
  assert.equal(await readFile(payload.path, 'utf8'), 'image-bytes');
  assert.equal((await stat(resolve(payload.path, '..'))).mode & 0o777, 0o700);
  assert.equal((await stat(payload.path)).mode & 0o777, 0o600);
  await assert.rejects(
    persistBrowserScreenshot({ mimeType: 'image/jpeg', data: 'not base64!' }),
    /must be base64/,
  );

  const artifact = createBrowserScreenshotArtifact(serialized);
  assert.equal(
    await readBrowserScreenshotDataUrl(artifact.screenshot),
    `data:image/png;base64,${Buffer.from('image-bytes').toString('base64')}`,
  );

  const messages = await buildBrowserScreenshotMessages(serialized, 'screenshot-1');
  assert.equal(messages.length, 2);
  assert.equal(messages[0]._getType(), 'tool');
  assert.equal(messages[1]._getType(), 'human');
  assert.doesNotMatch(JSON.stringify(messages[0].content), /data:image\/png;base64,/);
  assert.match(JSON.stringify(messages[1].content), /data:image\/png;base64,/);
  assert.match(JSON.stringify(messages.map((message) => message.toDict())), /data:image\/png;base64,/);
});
