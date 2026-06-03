import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { buildToolImageRelayMessages } from './createSubagent';

function screenshotToolMessage(dataUrls: string[], toolCallId = 'call-1') {
  return new ToolMessage({
    content: '已截屏并保存到 /tmp/shot.png。',
    tool_call_id: toolCallId,
    artifact: { images: dataUrls.map((dataUrl) => ({ dataUrl })) },
  });
}

function imageBlocks(message: HumanMessage) {
  const content = message.content as Array<{ type: string; image_url?: { url: string } }>;
  return content.filter((block) => block.type === 'image_url').map((block) => block.image_url?.url);
}

test('buildToolImageRelayMessages injects an image HumanMessage for a screenshot tool result', () => {
  const messages = [
    new HumanMessage('打开网页并截图'),
    new AIMessage(''),
    screenshotToolMessage(['data:image/png;base64,AAA']),
  ];

  const injected = buildToolImageRelayMessages(messages);

  assert.equal(injected.length, 1);
  const content = injected[0]!.content as Array<{ type: string }>;
  assert.equal(content[0]!.type, 'text');
  assert.deepEqual(imageBlocks(injected[0]!), ['data:image/png;base64,AAA']);
});

test('buildToolImageRelayMessages does not re-inject once a human message follows the tool result', () => {
  const messages = [
    new HumanMessage('打开网页并截图'),
    new AIMessage(''),
    screenshotToolMessage(['data:image/png;base64,AAA']),
    new HumanMessage({ content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }] }),
  ];

  assert.deepEqual(buildToolImageRelayMessages(messages), []);
});

test('buildToolImageRelayMessages ignores tool results without image artifacts', () => {
  const messages = [
    new HumanMessage('读一下页面文本'),
    new AIMessage(''),
    new ToolMessage({ content: '页面文本…', tool_call_id: 'call-1' }),
  ];

  assert.deepEqual(buildToolImageRelayMessages(messages), []);
});

test('buildToolImageRelayMessages carries every image from a tool result in one message', () => {
  const messages = [
    new HumanMessage('截两张图'),
    screenshotToolMessage(['data:image/png;base64,AAA', 'data:image/png;base64,BBB']),
  ];

  const injected = buildToolImageRelayMessages(messages);

  assert.equal(injected.length, 1);
  assert.deepEqual(imageBlocks(injected[0]!), [
    'data:image/png;base64,AAA',
    'data:image/png;base64,BBB',
  ]);
});
