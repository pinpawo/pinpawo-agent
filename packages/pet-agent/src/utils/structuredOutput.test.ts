import assert from 'node:assert/strict';
import test from 'node:test';
import { HumanMessage, type BaseMessage } from '@langchain/core/messages';
import { OutputParserException } from '@langchain/core/output_parsers';
import type { RunnableConfig } from '@langchain/core/runnables';
import { z } from 'zod';
import { invokeStructuredOutput, type StructuredOutputCapableModel, type StructuredOutputMethod } from './structuredOutput';

const schema = z.object({ action: z.literal('finish') });

function modelWith(invoke: (messages: BaseMessage[], config?: RunnableConfig) => Promise<unknown>): StructuredOutputCapableModel {
  return { withStructuredOutput: () => ({ invoke }) };
}

function readFeedback(messages: BaseMessage[]) {
  const content = messages.at(-1)?.content;
  assert.ok(Array.isArray(content));
  const data = content[1];
  assert.ok(typeof data === 'object' && 'text' in data && typeof data.text === 'string');
  return JSON.parse(data.text);
}

for (const method of ['jsonMode', 'jsonSchema', 'functionCalling'] satisfies StructuredOutputMethod[]) {
  test(`schema repair provides validation feedback and preserves ${method} provider options`, async () => {
    const messages = [new HumanMessage('decide')];
    const invokedMessages: BaseMessage[][] = [];
    let capturedOptions: unknown;
    const model: StructuredOutputCapableModel = {
      withStructuredOutput: (_schema, options) => {
        capturedOptions = options;
        return { invoke: async (input) => {
          invokedMessages.push(input);
          if (input.length === messages.length) return { action: 'invalid' };
          assert.deepEqual(readFeedback(input), {
            kind: 'schema_validation', issues: [{ path: ['action'], code: 'invalid_literal' }],
          });
          return { action: 'finish' };
        } };
      },
    };

    assert.deepEqual(await invokeStructuredOutput({
      model, schema, options: { name: 'decision', method, strict: false, autoRepair: true }, messages,
    }), { action: 'finish' });
    assert.equal(invokedMessages.length, 2);
    assert.equal(invokedMessages[0], messages);
    assert.equal(messages.length, 1, 'the caller-owned prompt remains unchanged');
    assert.deepEqual(capturedOptions, { name: 'decision', method, strict: false });
  });
}

test('persistent schema failure is capped at four logical calls without growing the prompt', async () => {
  const inputs: BaseMessage[][] = [];
  await assert.rejects(invokeStructuredOutput({
    model: modelWith(async (messages) => { inputs.push(messages); return { action: 'invalid' }; }),
    schema, options: { name: 'decision', autoRepair: { maxRetries: 1000 } }, messages: [new HumanMessage('decide')],
  }), OutputParserException);
  assert.equal(inputs.length, 4);
  assert.deepEqual(inputs.map(messages => messages.length), [1, 2, 2, 2]);
});

test('disabled or invalid repair limits perform only the initial call', async () => {
  for (const autoRepair of [undefined, false, { maxRetries: 0 }, { maxRetries: -1 }, { maxRetries: NaN }, { maxRetries: Infinity }]) {
    let calls = 0;
    await assert.rejects(invokeStructuredOutput({
      model: modelWith(async () => { calls++; return { action: 'invalid' }; }),
      schema, options: { name: 'decision', autoRepair }, messages: [new HumanMessage('decide')],
    }), /Invalid structured output/);
    assert.equal(calls, 1);
  }
});

test('framework parser failures get bounded feedback without echoing provider output or errors', async () => {
  let calls = 0;
  const failure = new OutputParserException('PRIVATE provider error', 'PRIVATE rejected output');
  assert.deepEqual(await invokeStructuredOutput({
    model: modelWith(async (messages) => {
      if (++calls === 1) throw failure;
      assert.deepEqual(readFeedback(messages), { kind: 'output_parsing' });
      assert.equal(JSON.stringify(messages).includes('PRIVATE'), false);
      return { action: 'finish' };
    }),
    schema, options: { name: 'decision', autoRepair: true }, messages: [new HumanMessage('decide')],
  }), { action: 'finish' });
  assert.equal(calls, 2);
});

test('schema diagnostics bound field paths and omit rejected values', async () => {
  const keys = Array.from({ length: 20 }, (_, index) => `${index}-${'\u0001'.repeat(500)}`);
  const fields = Object.fromEntries(keys.map(key => [key, z.number()]));
  let calls = 0;
  await invokeStructuredOutput({
    model: modelWith(async (messages) => {
      if (++calls === 1) return Object.fromEntries(keys.map(key => [key, 'PRIVATE rejected value']));
      const content = messages.at(-1)!.content;
      assert.ok(Array.isArray(content));
      const feedback = content[1] as { text: string };
      assert.ok(feedback.text.length <= 2000);
      assert.equal(feedback.text.includes('PRIVATE'), false);
      assert.equal(readFeedback(messages).kind, 'schema_validation');
      return Object.fromEntries(keys.map(key => [key, 1]));
    }),
    schema: z.object(fields), options: { name: 'bounded', autoRepair: true }, messages: [new HumanMessage('decide')],
  });
  assert.equal(calls, 2);
});

test('transport, permanent configuration, and abort errors are not schema retries', async () => {
  for (const error of [
    Object.assign(new Error('rate limited after SDK retries'), { status: 429 }),
    Object.assign(new Error('unavailable after SDK retries'), { status: 503 }),
    Object.assign(new Error('bad request'), { status: 400 }),
    Object.assign(new Error('unauthorized'), { status: 401 }),
    new TypeError('unsupported provider configuration'), new SyntaxError('invalid configuration JSON'),
    new DOMException('cancelled', 'AbortError'),
  ]) {
    let calls = 0;
    await assert.rejects(invokeStructuredOutput({
      model: modelWith(async () => { calls++; throw error; }),
      schema, options: { name: 'decision', autoRepair: { maxRetries: 3 } }, messages: [new HumanMessage('decide')],
    }), failure => failure === error);
    assert.equal(calls, 1);
  }
});

test('a structured-output configuration failure is not retried', async () => {
  const failure = new Error('method not supported');
  let constructions = 0;
  await assert.rejects(invokeStructuredOutput({
    model: { withStructuredOutput: () => { constructions++; throw failure; } },
    schema, options: { name: 'decision', autoRepair: true }, messages: [new HumanMessage('decide')],
  }), error => error === failure);
  assert.equal(constructions, 1);
});

test('each repair forwards original callbacks, signal and trace/usage configuration', async () => {
  const config: RunnableConfig = {
    callbacks: [], signal: new AbortController().signal,
    metadata: { usageScope: 'private-review' }, tags: ['review'],
    configurable: { thread_id: 'private-thread' }, runName: 'private-evaluation',
  };
  let calls = 0;
  await invokeStructuredOutput({
    model: modelWith(async (_messages, received) => {
      assert.equal(received, config);
      return { action: ++calls === 1 ? 'invalid' : 'finish' };
    }),
    schema, options: { name: 'decision', autoRepair: true }, messages: [new HumanMessage('decide')], runnableConfig: config,
  });
  assert.equal(calls, 2);
});

test('a pre-aborted call never constructs or invokes the model', async () => {
  const controller = new AbortController();
  const reason = new Error('stop before evaluation');
  controller.abort(reason);
  await assert.rejects(invokeStructuredOutput({
    model: { withStructuredOutput: () => { assert.fail('model must not be constructed'); } },
    schema, options: { name: 'decision', autoRepair: true }, messages: [], runnableConfig: { signal: controller.signal },
  }), error => error === reason);
});

test('abort during framework backoff returns promptly and never starts another model call', async () => {
  const controller = new AbortController();
  const reason = new Error('stop repair');
  let calls = 0;
  let invalidResponse: () => void;
  const firstResponse = new Promise<void>(resolve => { invalidResponse = resolve; });
  const operation = invokeStructuredOutput({
    model: modelWith(async () => { calls++; invalidResponse(); return { action: 'invalid' }; }),
    schema, options: { name: 'decision', autoRepair: true }, messages: [], runnableConfig: { signal: controller.signal },
  });
  const rejected = assert.rejects(operation, error => error === reason);
  await firstResponse;
  await new Promise(resolve => setTimeout(resolve, 20));
  controller.abort(reason);
  await rejected;
  await new Promise(resolve => setTimeout(resolve, 2100));
  assert.equal(calls, 1);
});
