import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import {
  createModelRequestPolicyMiddleware,
  prepareModelRequestMessages,
} from './modelRequestPolicy';

test('prepareModelRequestMessages applies host adaptation without mutating input', async () => {
  const original = new HumanMessage('original');
  const prepared = new HumanMessage('prepared');
  const messages = [original];

  const result = await prepareModelRequestMessages({
    prepareMessages: () => [prepared],
  }, messages);

  assert.deepEqual(result, [prepared]);
  assert.deepEqual(messages, [original]);
});

test('model request policy middleware prepares messages and normalizes tool choice', async () => {
  const prepared = new HumanMessage('prepared');
  const middleware = createModelRequestPolicyMiddleware({
    prepareMessages: () => [prepared],
    normalizeToolChoice: () => 'auto',
  });
  assert.ok(middleware);

  const wrapModelCall = middleware.wrapModelCall;
  assert.equal(typeof wrapModelCall, 'function');
  let providerMessages: BaseMessage[] = [];
  let providerToolChoice: unknown;
  if (typeof wrapModelCall === 'function') {
    await wrapModelCall({
      messages: [new HumanMessage('original')],
      toolChoice: 'required',
    } as never, async (request) => {
      providerMessages = [...request.messages];
      providerToolChoice = request.toolChoice;
      return new AIMessage('done');
    });
  }

  assert.deepEqual(providerMessages, [prepared]);
  assert.equal(providerToolChoice, 'auto');
});
