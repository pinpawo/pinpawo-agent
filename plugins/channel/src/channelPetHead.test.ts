import assert from 'node:assert/strict';
import test from 'node:test';
import { OutputParserException } from '@langchain/core/output_parsers';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { z } from 'zod';
import {
  channelPetHeadOptionsSchema, boundedHeadInput, createChannelPetHead, createLlmPetHeadDecider,
  headDecisionSchema, headError, type HeadDecision, type HeadInput, type PetHeadDecider,
} from './channelPetHead';

const input: HeadInput = {
  channel: { channelId: 'release-room', title: 'Release', description: 'Public release planning', prompt: 'Reviewer checks releases.' },
  pet: { participantId: 'pet:reviewer', name: 'Reviewer', description: 'Reviews public changes.' },
  members: [
    { participantId: 'human:owner', kind: 'human', label: 'Owner' },
    { participantId: 'pet:reviewer', kind: 'pet', label: 'Reviewer' },
    { participantId: 'pet:executor', kind: 'pet', label: 'Executor' },
  ],
  messages: [{ sequence: 9, messageId: 'new-message', author: { participantId: 'human:owner', kind: 'human' },
    body: 'Review the release', mentions: [], source: 'member', bodyTruncated: true,
    replyTo: { messageId: 'earlier-message', author: { participantId: 'pet:executor', kind: 'pet' }, body: 'Public summary' } }],
  context: [{ sequence: 8, messageId: 'background-message', author: { participantId: 'pet:executor', kind: 'pet' }, body: 'Background only', mentions: [] }],
  history: [{ sequence: 7, messageId: 'history-message', author: { participantId: 'pet:reviewer', kind: 'pet' }, body: 'Earlier public review', mentions: [], source: 'pet-head' }],
  execution: { state: 'unknown' },
};
const endpoint = { profileId: 'head-profile', baseUrl: 'https://models.test/v1', apiKey: 'PRIVATE_API_KEY', model: 'small' };
const decision: HeadDecision = { action: 'skip', confidence: 0.9, reason: 'No new work', reply: '', focus: '' };
const signal = () => new AbortController().signal;
const fixed = (output: unknown): PetHeadDecider => async () => output as HeadDecision;
const headFor = (output: unknown, threshold?: number) => createChannelPetHead({ enabled: true, threshold }, { decider: fixed(output) })!;
const safeFailure = (message: string) => (error: unknown) => {
  assert.ok(error instanceof Error);
  assert.equal(error.message, message);
  assert.equal(error.cause, undefined);
  assert.equal(Object.hasOwn(error, 'output'), false);
  return true;
};

function fakeModel(invoke: (messages: BaseMessage[], config?: RunnableConfig) => Promise<unknown>,
  observe?: (schema: z.AnyZodObject, options: unknown) => void): BaseChatModel {
  return { withStructuredOutput: (schema: z.AnyZodObject, options: unknown) => {
    observe?.(schema, options);
    return { invoke };
  } } as unknown as BaseChatModel;
}

test('Head is disabled by default and disabled Heads never resolve or construct models', () => {
  let calls = 0;
  const options = { resolveModel: () => { calls += 1; throw new Error('must not resolve'); },
    decider: async () => { calls += 1; return decision; } };
  assert.equal(createChannelPetHead(undefined, options), undefined);
  assert.equal(createChannelPetHead({ enabled: false }, options), undefined);
  assert.equal(calls, 0);
  assert.equal(channelPetHeadOptionsSchema.parse({}).enabled, false);
});

test('Head configuration validates batching and bounded model settings', () => {
  const settings = channelPetHeadOptionsSchema.parse({ enabled: true });
  assert.equal(settings.cooldownMs, 300);
  assert.equal(settings.batchLimit, 50);
  for (const invalid of [{ batchLimit: 0 }, { batchLimit: 201 }, { cooldownMs: -1 }, { cooldownMs: 60_001 },
    { threshold: -0.1 }, { threshold: 1.1 }, { timeoutMs: 99 }, { timeoutMs: 120_001 }]) {
    assert.equal(channelPetHeadOptionsSchema.safeParse(invalid).success, false);
  }
});

test('Head accepts only own-Pet skip, reply and dispatch decisions, trimming public text and focus', async () => {
  for (const action of ['skip', 'reply', 'dispatch'] as const) {
    const output = { ...decision, action, reply: action === 'skip' ? '  ' : '  Public response  ', focus: '  Check the release  ' };
    assert.deepEqual(await headFor(output).decide(input, signal()), {
      ...output, reply: output.reply.trim(), focus: 'Check the release',
    });
  }
  assert.deepEqual(await headFor({ ...decision, action: 'dispatch' }).decide(input, signal()), { ...decision, action: 'dispatch' });
  for (const invalid of [
    { ...decision, target: 'pet:executor' }, { ...decision, participantId: 'pet:executor' },
    { ...decision, action: 'route' }, { ...decision, action: 'reply', reply: '' },
    { ...decision, action: 'reply', reply: ' \n\t ' }, { ...decision, reply: 'Cannot publish on skip' },
    { ...decision, confidence: -0.1 }, { ...decision, confidence: 1.1 },
    { ...decision, confidence: Number.NaN }, { ...decision, reason: 'r'.repeat(501) },
    { ...decision, action: 'reply', reply: 'r'.repeat(4_001) }, { ...decision, focus: 'f'.repeat(501) },
    { action: 'skip', confidence: 1 }, null,
  ]) {
    assert.equal(headDecisionSchema.safeParse(invalid).success, false);
    await assert.rejects(headFor(invalid).decide(input, signal()), safeFailure('Pet Head request failed.'));
  }
});

test('threshold skips low confidence and clears reply and focus without suppressing equal confidence', async () => {
  for (const action of ['reply', 'dispatch'] as const) {
    const output = { ...decision, action, confidence: 0.59, reply: 'Public answer', focus: 'Review this' };
    assert.deepEqual(await headFor(output, 0.6).decide(input, signal()), { ...output, action: 'skip', reply: '', focus: '' });
    assert.deepEqual(await headFor({ ...output, confidence: 0.6 }, 0.6).decide(input, signal()), { ...output, confidence: 0.6 });
  }
  assert.equal((await headFor({ ...decision, action: 'dispatch', confidence: 0.49 }).decide(input, signal())).action, 'skip');
  assert.equal((await headFor({ ...decision, action: 'dispatch', confidence: 0.5 }).decide(input, signal())).action, 'dispatch');
});

test('injected decider receives one public input and combined cancellation signal without resolving a model', async () => {
  let calls = 0;
  let observedSignal: AbortSignal | undefined;
  const controller = new AbortController();
  const head = createChannelPetHead({ enabled: true }, {
    resolveModel: () => { throw new Error('injected decider must not resolve a model'); },
    decider: async (value, cancellation) => {
      calls += 1;
      assert.deepEqual(value, input);
      observedSignal = cancellation;
      return decision;
    },
  })!;
  assert.deepEqual(await head.decide(input, controller.signal), decision);
  assert.equal(calls, 1);
  assert.equal(observedSignal?.aborted, false);
  controller.abort(new Error('PRIVATE_ABORT_REASON'));
  assert.equal(observedSignal?.aborted, true);
});

test('timeout settles even when an injected decider ignores its signal', async () => {
  let observed: AbortSignal | undefined;
  const head = createChannelPetHead({ enabled: true, timeoutMs: 100 }, { decider: async (_input, cancellation) => {
    observed = cancellation;
    return new Promise<HeadDecision>(() => {});
  } })!;
  // AbortSignal.timeout is unrefed; keep this test alive without relying on another test's handles.
  const keepAlive = setTimeout(() => {}, 2_000);
  try {
    await assert.rejects(head.decide(input, signal()), safeFailure('Pet Head request timed out.'));
    assert.equal(observed?.aborted, true);
  } finally { clearTimeout(keepAlive); }
});

test('abort settles ignoring deciders and pre-aborted calls never invoke the decider', async () => {
  let calls = 0;
  let observed: AbortSignal | undefined;
  const head = createChannelPetHead({ enabled: true }, { decider: async (_input, cancellation) => {
    calls += 1;
    observed = cancellation;
    return new Promise<HeadDecision>(() => {});
  } })!;
  const controller = new AbortController();
  const result = head.decide(input, controller.signal);
  await Promise.resolve();
  controller.abort(new Error('PRIVATE_ABORT_REASON'));
  await assert.rejects(result, safeFailure('Pet Head request aborted.'));
  assert.equal(observed?.aborted, true);
  assert.equal(calls, 1);
  await assert.rejects(head.decide(input, controller.signal), safeFailure('Pet Head request aborted.'));
  assert.equal(calls, 1);
});

test('structured model receives only public Head input, an own-Pet schema and one call per decision', async () => {
  for (const method of [undefined, 'jsonMode', 'jsonSchema', 'functionCalling'] as const) {
    let calls = 0;
    let factoryCalls = 0;
    let factoryOptions: unknown;
    let schema: z.AnyZodObject | undefined;
    let structuredOptions: unknown;
    let messages: BaseMessage[] = [];
    let observedSignal: AbortSignal | undefined;
    const model = fakeModel(async (value, config) => {
      calls += 1; messages = value; observedSignal = config?.signal;
      return decision;
    }, (value, options) => { schema = value; structuredOptions = options; });
    const decider = createLlmPetHeadDecider({ ...endpoint, structuredOutputMethod: method,
      createChatModel: options => { factoryCalls += 1; factoryOptions = options; return model; } });
    const cancellation = signal();
    assert.deepEqual(await decider(input, cancellation), decision);
    assert.equal(calls, 1);
    assert.equal(factoryCalls, 1);
    assert.deepEqual(factoryOptions, { maxOutputTokens: 1_200, maxRetries: 0, preferDeterministic: true, streaming: false, forceChatCompletions: true });
    assert.deepEqual(structuredOptions, { name: 'channel_pet_head', method: method ?? 'jsonMode' });
    assert.deepEqual(Object.keys(schema!.shape).sort(), ['action', 'confidence', 'focus', 'reason', 'reply']);
    assert.deepEqual(schema!.shape.action.options, ['skip', 'reply', 'dispatch']);
    assert.equal(schema!.safeParse({ ...decision, target: 'pet:executor' }).success, false);
    assert.equal(messages.length, 2);
    assert.equal(messages[0]!._getType(), 'system');
    assert.equal(messages[1]!._getType(), 'human');
    assert.deepEqual(JSON.parse(String(messages[1]!.content)), input);
    assert.equal(observedSignal, cancellation);
    const changed: HeadInput = { ...input, pet: { participantId: 'pet:new', name: 'New' }, execution: { state: 'running' } };
    await decider(changed, cancellation);
    assert.deepEqual(JSON.parse(String(messages[1]!.content)), changed);
    assert.equal(calls, 2);
    assert.equal(factoryCalls, 1);
  }
});

test('profile resolution and model factory failures are sanitized at startup', () => {
  assert.throws(() => createChannelPetHead({ enabled: true }, {}), safeFailure('Pet Head could not resolve the configured model profile.'));
  assert.throws(() => createChannelPetHead({ enabled: true, decider: { kind: 'llm', modelProfileId: 'chosen-profile' } }, {
    resolveModel: profile => { assert.equal(profile, 'chosen-profile'); throw new Error('PRIVATE_PROFILE'); },
  }), safeFailure('Pet Head could not resolve the configured model profile.'));
  assert.throws(() => createLlmPetHeadDecider(endpoint), safeFailure('Pet Head requires the Studio model factory.'));
  assert.throws(() => createLlmPetHeadDecider({ ...endpoint, createChatModel: () => { throw new Error('PRIVATE_FACTORY'); } }), safeFailure('Pet Head model initialization failed.'));
});

test('parser, structured output and HTTP errors are sanitized without additional model rounds', async () => {
  const cases: Array<{ output?: unknown; error?: unknown; expected: string }> = [
    { output: { ...decision, action: 'PRIVATE_OUTPUT' }, expected: 'Pet Head request failed.' },
    { output: { ...decision, action: 'reply', reply: ' ' }, expected: 'Pet Head request failed.' },
    { output: { ...decision, target: 'PRIVATE_TARGET' }, expected: 'Pet Head request failed.' },
    { error: new OutputParserException('PRIVATE_PARSER', 'PRIVATE_MODEL_OUTPUT'), expected: 'Pet Head request failed.' },
    { error: Object.assign(new Error('PRIVATE_HTTP_BODY'), { status: 429 }), expected: 'Pet Head model returned HTTP 429.' },
    { error: Object.assign(new Error('PRIVATE_HTTP_BODY'), { status: 503 }), expected: 'Pet Head model returned HTTP 503.' },
  ];
  for (const example of cases) {
    let calls = 0;
    const model = fakeModel(async () => {
      calls += 1;
      if (example.error) throw example.error;
      return example.output;
    });
    const head = createChannelPetHead({ enabled: true }, { resolveModel: () => ({ ...endpoint, createChatModel: () => model }) })!;
    await assert.rejects(head.decide(input, signal()), safeFailure(example.expected));
    assert.equal(calls, 1);
  }
  const model = { withStructuredOutput: () => { throw new Error('PRIVATE_SCHEMA_FAILURE'); } } as unknown as BaseChatModel;
  await assert.rejects(createLlmPetHeadDecider({ ...endpoint, createChatModel: () => model })(input, signal()), safeFailure('Pet Head request failed.'));
  for (const status of ['PRIVATE_STATUS', 99, 600, 200.5, Number.NaN, undefined]) {
    assert.equal(headError({ status, message: 'PRIVATE_ERROR' }).message, 'Pet Head request failed.');
  }
  const failing = createChannelPetHead({ enabled: true }, { decider: async () => { throw new Error('PRIVATE_CUSTOM_DECIDER'); } })!;
  await assert.rejects(failing.decide(input, signal()), safeFailure('Pet Head request failed.'));
});

test('cooperative deciders see cancellation and cannot publish a late successful result', async () => {
  const controller = new AbortController();
  let observed: AbortSignal | undefined;
  const head = createChannelPetHead({ enabled: true }, { decider: async (_input, cancellation) => {
    observed = cancellation;
    return new Promise<HeadDecision>(resolve => cancellation.addEventListener('abort', () => {
      resolve({ ...decision, action: 'reply', reply: 'Late answer' });
    }, { once: true }));
  } })!;
  const result = head.decide(input, controller.signal);
  await Promise.resolve();
  controller.abort('PRIVATE_ABORT_REASON');
  await assert.rejects(result, safeFailure('Pet Head request aborted.'));
  assert.equal(observed?.aborted, true);
});

test('already cancelled structured model decisions never make a provider request', async () => {
  let calls = 0;
  const model = fakeModel(async () => { calls += 1; return decision; });
  const controller = new AbortController();
  controller.abort(new Error('PRIVATE_ABORT_REASON'));
  await assert.rejects(createLlmPetHeadDecider({ ...endpoint, createChatModel: () => model })(input, controller.signal),
    safeFailure('Pet Head request aborted.'));
  assert.equal(calls, 0);
});


test('large mixed metadata never removes an older actionable trigger to fit newer chatter', () => {
  const rows = Array.from({ length: 100 }, (_, index) => ({
    ...input.messages[0]!, sequence: index + 1, messageId: `message-${index}`,
    body: index === 0 ? `ACTION: inspect the release. ${'more evidence '.repeat(200)}` : `Thanks ${'chat '.repeat(500)}`,
    mentions: Array.from({ length: 4 }, (_, n) => ({ participantId: `human:${n}`, label: 'label' })),
    deliverables: Array.from({ length: 10 }, (_, n) => ({ uri: `https://example.test/${n}/${'x'.repeat(2_000)}`, title: 'title'.repeat(500) })),
  }));
  const bounded = boundedHeadInput({ ...input, messages: rows });
  assert.ok(JSON.stringify(bounded).length <= 96_000);
  assert.equal(bounded.inputTruncated, true);
  assert.equal(bounded.messages.length, rows.length);
  assert.deepEqual(bounded.messages.map(row => row.messageId), rows.map(row => row.messageId));
  assert.ok(bounded.messages[0]!.body.startsWith('ACTION: inspect the release.'));
});
