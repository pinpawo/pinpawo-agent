import assert from 'node:assert/strict';
import test from 'node:test';
import { HumanMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { invokeStructuredOutput, type StructuredOutputCapableModel } from './structuredOutput';

test('invokeStructuredOutput retries the same LLM call when autoRepair is enabled', async () => {
  const schema = z.object({ action: z.literal('finish') });
  const messages = [new HumanMessage('decide')];
  const invokedMessages: unknown[] = [];
  let invokeCount = 0;
  let capturedOptions: unknown;

  const model: StructuredOutputCapableModel = {
    withStructuredOutput: (_schema, options) => {
      capturedOptions = options;
      return {
        invoke: async (inputMessages) => {
          invokeCount += 1;
          invokedMessages.push(inputMessages);
          return invokeCount === 1
            ? { action: 'invalid' }
            : { action: 'finish' };
        },
      };
    },
  };

  const result = await invokeStructuredOutput({
    model,
    schema,
    options: {
      name: 'decision',
      method: 'jsonMode',
      autoRepair: true,
    },
    messages,
  });

  assert.deepEqual(result, { action: 'finish' });
  assert.equal(invokeCount, 2);
  assert.equal(invokedMessages[0], messages);
  assert.equal(invokedMessages[1], messages);
  assert.deepEqual(capturedOptions, {
    name: 'decision',
    method: 'jsonMode',
  });
});

test('invokeStructuredOutput does not retry when autoRepair is disabled', async () => {
  const schema = z.object({ action: z.literal('finish') });
  let invokeCount = 0;
  const model: StructuredOutputCapableModel = {
    withStructuredOutput: () => ({
      invoke: async () => {
        invokeCount += 1;
        return { action: 'invalid' };
      },
    }),
  };

  await assert.rejects(
    () => invokeStructuredOutput({
      model,
      schema,
      options: { name: 'decision', method: 'jsonMode' },
      messages: [new HumanMessage('decide')],
    }),
    /Invalid structured output/,
  );
  assert.equal(invokeCount, 1);
});
