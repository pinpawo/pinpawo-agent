import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AIMessage,
  HumanMessage,
  ToolMessage,
} from '@langchain/core/messages';
import { projectToolResultImages } from './toolResultImageProjection';

function imageToolMessage(toolCallId = 'call-image') {
  return new ToolMessage({
    contentBlocks: [
      { type: 'text', text: 'screenshot captured' },
      {
        type: 'image',
        data: 'aW1hZ2U=',
        mimeType: 'image/png',
        metadata: { detail: 'auto' },
      },
    ],
    tool_call_id: toolCallId,
  });
}

test('native projection converts canonical tool attachments to Responses content', () => {
  const original = imageToolMessage();
  const projected = projectToolResultImages([original], 'native');

  assert.equal(projected.length, 1);
  assert.ok(projected[0] instanceof ToolMessage);
  assert.deepEqual(projected[0].content, [
    { type: 'input_text', text: 'screenshot captured' },
    {
      type: 'input_image',
      image_url: 'data:image/png;base64,aW1hZ2U=',
      detail: 'auto',
    },
  ]);
  assert.deepEqual(original.contentBlocks.map((block) => block.type), ['text', 'image']);
});

test('user-message projection keeps parallel tool results adjacent before media', () => {
  const callingMessage = new AIMessage({
    content: '',
    tool_calls: [
      { id: 'call-image', name: 'screenshot', args: {} },
      { id: 'call-text', name: 'read_text', args: {} },
    ],
  });
  const imageResult = imageToolMessage();
  const textResult = new ToolMessage({
    content: 'page title',
    tool_call_id: 'call-text',
  });

  const projected = projectToolResultImages([
    new HumanMessage('inspect the page'),
    callingMessage,
    imageResult,
    textResult,
  ], 'user_message');

  assert.deepEqual(projected.map((message) => message._getType()), [
    'human',
    'ai',
    'tool',
    'tool',
    'human',
  ]);
  assert.equal(projected[2].content, 'screenshot captured');
  assert.equal(projected[3], textResult);
  assert.deepEqual(projected[4].contentBlocks.map((block) => block.type), ['text', 'image']);
  assert.equal(
    projected[4].additional_kwargs.pinpawo_synthetic_tool_media,
    true,
  );
});

test('user-message projection batches images from all parallel tool results', () => {
  const projected = projectToolResultImages([
    imageToolMessage('call-image-1'),
    imageToolMessage('call-image-2'),
  ], 'user_message');

  assert.deepEqual(projected.map((message) => message._getType()), [
    'tool',
    'tool',
    'human',
  ]);
  assert.equal(
    projected[2].contentBlocks.filter((block) => block.type === 'image').length,
    2,
  );
});
