import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { getLocalToolsWorkdir, setLocalToolsWorkdir } from './toolkits/local/pathUtils';
import {
  createBrowserScreenshotArtifact,
  persistBrowserScreenshot,
} from './toolkits/browser/screenshot';
import { createAdmittedLocalChatHumanMessage } from './localChatAttachments';
import { LocalChatImageStore } from './localImageAttachments';
import {
  prepareLocalImageModelMessages,
  readRequiredInputModalities,
} from './localImageModelInput';

const PNG_BYTES = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('model-input'),
]);

test('local image messages persist references and rehydrate only for provider invocation', async () => {
  const root = await fs.mkdtemp(join(tmpdir(), 'pinpawo-model-image-'));
  const imagePath = join(root, 'image.png');
  await fs.writeFile(imagePath, PNG_BYTES);
  const store = new LocalChatImageStore(join(root, 'store'));

  try {
    const admitted = await store.admit([{
      id: 'image-1',
      source: 'local-path',
      kind: 'file',
      path: imagePath,
      name: 'image.png',
    }], { allowImages: true });
    const message = createAdmittedLocalChatHumanMessage(
      'What is in this image?',
      admitted,
    );
    const persisted = JSON.stringify(message.toDict());
    assert.match(persisted, /pinpawo-local-image:/);
    assert.doesNotMatch(persisted, /base64/);
    assert.doesNotMatch(persisted, new RegExp(root));

    const admittedModalities: string[][] = [];
    const prepared = await prepareLocalImageModelMessages([message], {
      imageStore: store,
      supportedInputModalities: ['text', 'image'],
      admitInputModalities: (modalities) => {
        admittedModalities.push([...modalities]);
      },
    });
    assert.deepEqual(admittedModalities, [['text', 'image']]);
    assert.notEqual(prepared[0], message);
    assert.match(JSON.stringify(prepared[0]?.content), /data:image\/png;base64,/);
    assert.match(JSON.stringify(message.content), /pinpawo-local-image:/);

    const image = admitted[0];
    assert.equal(image?.source, 'local-image');
    if (image?.source !== 'local-image') return;
    const toolMessage = new ToolMessage({
      tool_call_id: 'tool-local-image',
      content: [{
        type: 'image_url',
        image_url: { url: image.uri },
      }],
    });
    const preparedTool = await prepareLocalImageModelMessages(
      [toolMessage],
      {
        imageStore: store,
        supportedInputModalities: ['text', 'image'],
      },
    );
    assert.equal(preparedTool[0]?._getType(), 'tool');
    assert.equal(
      (preparedTool[0] as ToolMessage | undefined)?.tool_call_id,
      'tool-local-image',
    );
    assert.match(
      JSON.stringify(preparedTool[0]?.content),
      /data:image\/png;base64,/,
    );

    const standardImageMessage = new HumanMessage({
      content: [{
        type: 'image',
        url: image.uri,
      }],
    });
    const preparedStandardImage = await prepareLocalImageModelMessages(
      [standardImageMessage],
      {
        imageStore: store,
        supportedInputModalities: ['text', 'image'],
      },
    );
    const serializedStandardImage = JSON.stringify(
      preparedStandardImage[0]?.content,
    );
    assert.match(serializedStandardImage, /data:image\/png;base64,/);
    assert.doesNotMatch(serializedStandardImage, /pinpawo-local-image:/);
    assert.doesNotMatch(serializedStandardImage, /"image_url"/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('model input guard rejects every image block for text-only profiles', async () => {
  const message = new HumanMessage({
    content: [{
      type: 'image_url',
      image_url: { url: 'https://images.example.test/cat.png' },
    }],
  });
  await assert.rejects(
    () => prepareLocalImageModelMessages([message], {
      supportedInputModalities: ['text'],
    }),
    /cannot invoke image input/,
  );
});

test('tool image blocks use the same modality admission guard', async () => {
  const message = new ToolMessage({
    tool_call_id: 'tool-1',
    content: [{
      type: 'image_url',
      image_url: 'data:image/png;base64,iVBORw0KGgo=',
    }],
  });
  assert.deepEqual(readRequiredInputModalities([message]), ['text', 'image']);

  const admitted: string[][] = [];
  const prepared = await prepareLocalImageModelMessages([message], {
    supportedInputModalities: ['text', 'image'],
    admitInputModalities: (modalities) => {
      admitted.push([...modalities]);
    },
  });
  assert.equal(prepared[0], message);
  assert.deepEqual(admitted, [['text', 'image']]);

  const standardImage = new ToolMessage({
    tool_call_id: 'tool-standard-image',
    content: [{
      type: 'image',
      mimeType: 'image/png',
      data: 'iVBORw0KGgo=',
    }],
  });
  assert.deepEqual(
    readRequiredInputModalities([standardImage]),
    ['text', 'image'],
  );
});

test('browser screenshot artifacts are relayed only to image-capable profiles', async (t) => {
  const previousWorkdir = getLocalToolsWorkdir();
  const workdir = await fs.mkdtemp(join(tmpdir(), 'pinpawo-browser-model-image-'));
  setLocalToolsWorkdir(workdir);
  t.after(() => setLocalToolsWorkdir(previousWorkdir));

  const serialized = await persistBrowserScreenshot({
    mimeType: 'image/jpeg',
    data: Buffer.from('browser-image').toString('base64'),
  });
  const screenshot = new ToolMessage({
    content: serialized,
    name: 'browser_screenshot',
    tool_call_id: 'browser-shot-1',
    artifact: createBrowserScreenshotArtifact(serialized),
  });
  const messages = [
    new HumanMessage('Inspect the page'),
    new AIMessage({
      content: '',
      tool_calls: [{ name: 'browser_screenshot', args: {}, id: 'browser-shot-1' }],
    }),
    screenshot,
  ];

  const vision = await prepareLocalImageModelMessages(messages, {
    supportedInputModalities: ['text', 'image'],
  });
  assert.equal(vision.length, messages.length + 1);
  assert.equal(vision.at(-1)?._getType(), 'human');
  assert.match(
    JSON.stringify(vision.at(-1)?.content),
    /data:image\/jpeg;base64,/,
  );
  assert.equal(vision[2], screenshot);

  const textOnly = await prepareLocalImageModelMessages(messages, {
    supportedInputModalities: ['text'],
  });
  assert.equal(textOnly.length, messages.length);
  assert.equal(textOnly[2], screenshot);
  assert.doesNotMatch(JSON.stringify(textOnly), /data:image\/jpeg;base64,/);

  const alreadyObserved = await prepareLocalImageModelMessages([
    ...messages,
    new AIMessage('I inspected the screenshot.'),
  ], {
    supportedInputModalities: ['text', 'image'],
  });
  assert.equal(alreadyObserved.length, messages.length + 1);
  assert.equal(alreadyObserved.at(-1)?._getType(), 'ai');

  const screenshotPath = (JSON.parse(serialized) as { path: string }).path;
  await fs.unlink(screenshotPath);
  const unavailable = await prepareLocalImageModelMessages(messages, {
    supportedInputModalities: ['text', 'image'],
  });
  assert.equal(unavailable.length, messages.length + 1);
  assert.match(
    JSON.stringify(unavailable.at(-1)?.content),
    /could not be loaded.*call browser_screenshot again/,
  );
  assert.doesNotMatch(
    JSON.stringify(unavailable.at(-1)?.content),
    /data:image\/jpeg;base64,/,
  );
});
