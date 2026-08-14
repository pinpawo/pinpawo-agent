import assert from 'node:assert/strict';
import test from 'node:test';
import { convertMessagesToCompletionsMessageParams } from '@langchain/openai';
import type { AgentLocalAttachment } from '@pinpawo/agent-session';
import {
  createAdmittedLocalChatHumanMessage,
  createLocalChatHumanMessage,
  formatLocalChatModelText,
  readLocalChatDisplayText,
} from './localChatAttachments';

const attachments: AgentLocalAttachment[] = [{
  id: 'attachment-1',
  source: 'local-path',
  kind: 'file',
  path: '/Users/example/secret project/spec.md',
  name: 'spec.md',
}];

test('local attachment message exposes full paths to the model but not the transcript', () => {
  const modelText = formatLocalChatModelText('review this', attachments);
  assert.match(modelText, /\/Users\/example\/secret project\/spec\.md/);
  assert.match(modelText, /Use local tools to inspect them/);

  const message = createLocalChatHumanMessage('review this', attachments);
  assert.equal(message.content, modelText);
  assert.equal(
    readLocalChatDisplayText(message),
    'review this\n\nAttachments:\n- file: spec.md',
  );
  assert.doesNotMatch(readLocalChatDisplayText(message) ?? '', /Users\/example/);
});

test('plain local chat messages keep their original model and transcript text', () => {
  const message = createLocalChatHumanMessage('hello');
  assert.equal(message.content, 'hello');
  assert.equal(readLocalChatDisplayText(message), null);
});

test('admitted images use durable content blocks and filename-only transcript text', () => {
  const imageData = Buffer.from('image-bytes').toString('base64');
  const message = createAdmittedLocalChatHumanMessage('describe it', [{
    id: 'image-1',
    source: 'local-image',
    kind: 'image',
    data: imageData,
    name: 'private-photo.png',
    mimeType: 'image/png',
    byteSize: 128,
    sha256: 'a'.repeat(64),
  }]);

  assert.equal(Array.isArray(message.content), true);
  const imageBlock = message.contentBlocks.find((block) => block.type === 'image');
  assert.equal(
    (message.response_metadata as { output_version?: string }).output_version,
    'v1',
  );
  assert.equal(imageBlock?.mimeType, 'image/png');
  assert.equal(imageBlock?.data, imageData);
  assert.doesNotMatch(
    JSON.stringify(message.additional_kwargs),
    new RegExp(imageData),
  );
  assert.deepEqual(
    (message.additional_kwargs.pinpawo as {
      localImageReferences: unknown[];
    }).localImageReferences,
    [{
      name: 'private-photo.png',
      mimeType: 'image/png',
      byteSize: 128,
      sha256: 'a'.repeat(64),
    }],
  );
  assert.equal(
    readLocalChatDisplayText(message),
    'describe it\n\nAttachments:\n- image: private-photo.png',
  );

  const [providerMessage] = convertMessagesToCompletionsMessageParams({
    messages: [message],
  });
  assert.match(JSON.stringify(providerMessage), /data:image\/png;base64,/);
  assert.doesNotMatch(JSON.stringify(providerMessage), /"type":"image"/);
});
