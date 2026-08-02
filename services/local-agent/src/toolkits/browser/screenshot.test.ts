import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { convertMessagesToResponsesInput } from '@langchain/openai';
import { getLocalToolsWorkdir, setLocalToolsWorkdir } from '../local/pathUtils';
import {
  createBrowserScreenshotArtifact,
  buildBrowserScreenshotToolMessage,
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

  const message = await buildBrowserScreenshotToolMessage(serialized, 'screenshot-1');
  assert.equal(message._getType(), 'tool');
  assert.equal(message.tool_call_id, 'screenshot-1');
  assert.match(JSON.stringify(message.content), /"type":"input_text"/);
  assert.match(JSON.stringify(message.content), /"type":"input_image"/);
  assert.match(JSON.stringify(message.content), /data:image\/png;base64,/);
  assert.match(JSON.stringify(message.toDict()), /data:image\/png;base64,/);

  assert.deepEqual(
    convertMessagesToResponsesInput({
      messages: [message],
      zdrEnabled: false,
      model: 'gpt-5.5',
    }),
    [{
      type: 'function_call_output',
      call_id: 'screenshot-1',
      id: undefined,
      output: message.content,
    }],
  );
});
