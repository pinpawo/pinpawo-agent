import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import {
  buildBrowserScreenshotMessages,
  parseBrowserScreenshot,
  persistBrowserScreenshot,
  readBrowserScreenshotDataUrl,
} from './screenshot';

test('browser screenshots are persisted inside the workdir with private permissions', async () => {
  const workdir = await mkdtemp(resolve(tmpdir(), 'pinpawo-screenshot-'));

  const serialized = await persistBrowserScreenshot({
    mimeType: 'image/png',
    data: Buffer.from('image-bytes').toString('base64'),
  }, workdir);
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
    persistBrowserScreenshot({ mimeType: 'image/jpeg', data: 'not base64!' }, workdir),
    /must be base64/,
  );

  assert.equal(
    await readBrowserScreenshotDataUrl(parseBrowserScreenshot(serialized), workdir),
    `data:image/png;base64,${Buffer.from('image-bytes').toString('base64')}`,
  );
});

test('screenshot messages pair a text tool result with a standard image message', async () => {
  const workdir = await mkdtemp(resolve(tmpdir(), 'pinpawo-screenshot-messages-'));

  const serialized = await persistBrowserScreenshot({
    mimeType: 'image/png',
    data: Buffer.from('image-bytes').toString('base64'),
  }, workdir);
  const [toolMessage, imageMessage] = await buildBrowserScreenshotMessages(
    serialized,
    'call-1',
    workdir,
  );

  assert.equal(toolMessage?._getType(), 'tool');
  assert.equal(imageMessage?._getType(), 'human');
  // Providers disagree about images inside a tool result, so the tool message
  // stays text-only and the image rides a user message every provider accepts.
  assert.doesNotMatch(JSON.stringify(toolMessage?.content), /base64/);
  assert.match(JSON.stringify(imageMessage?.content), /data:image\/png;base64,/);
});

test('an unreadable screenshot yields guidance instead of a broken image', async () => {
  const workdir = await mkdtemp(resolve(tmpdir(), 'pinpawo-screenshot-missing-'));

  const serialized = await persistBrowserScreenshot({
    mimeType: 'image/png',
    data: Buffer.from('image-bytes').toString('base64'),
  }, workdir);
  await rm((JSON.parse(serialized) as { path: string }).path);

  const [toolMessage, imageMessage] = await buildBrowserScreenshotMessages(
    serialized,
    'call-1',
    workdir,
  );
  assert.equal(toolMessage?._getType(), 'tool');
  assert.match(String(imageMessage?.content), /could not be loaded/);
  assert.match(String(imageMessage?.content), /call browser_screenshot again/);
});
