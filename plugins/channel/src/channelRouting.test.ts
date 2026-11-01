import assert from 'node:assert/strict';
import test from 'node:test';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { createChannelRouter, createLlmRouteDecider, routeInput, type RouteInput } from './channelRouting';
import type { ChannelMember } from './channelService';
import type { ChannelMessageRow } from './store/channelStore';

const input: RouteInput = {
  channel: { title: 'Release' },
  message: { author: 'Barry', body: 'Who is handling #1003?' },
  pets: [{ participantId: 'pet:executor', name: 'Executor' }, { participantId: 'pet:reviewer', name: 'Reviewer' }],
  history: [{ author: 'Executor', body: 'Opened #1003.' }],
};
const endpoint = { profileId: 'p', baseUrl: 'https://models.test/v1/', apiKey: 'k', model: 'small', structuredOutputMethod: 'jsonMode' as const };
const message = (author: ChannelMessageRow['author'], mentions: ChannelMessageRow['mentions'] = []): ChannelMessageRow => ({
  sequence: 1, messageId: 'm', channelId: 'c', author, occurredAt: '', body: 'hi', mentions, artifacts: [],
});
const pet: ChannelMember = { participantId: 'pet:executor', kind: 'pet', id: 'executor', label: 'Executor', joinedAt: '' };
const human: ChannelMember = { participantId: 'human:local', kind: 'human', id: 'local', label: 'Barry', joinedAt: '' };

test('routing is off unless enabled', () => {
  assert.equal(createChannelRouter(undefined, {}), undefined);
  assert.equal(createChannelRouter({ enabled: false }, { decider: async () => ({ target: 'none', confidence: 1 }) }), undefined);
});

test('applies only to a human message with no mentions in a Channel with a Pet', () => {
  const router = createChannelRouter({ enabled: true }, { decider: async () => ({ target: 'none', confidence: 1 }) })!;
  assert.equal(router.applies(message({ kind: 'human', id: 'local' }), [human, pet]), true);
  assert.equal(router.applies(message({ kind: 'pet', id: 'executor' }), [human, pet]), false);
  assert.equal(router.applies(message({ kind: 'human', id: 'local' }, [{ participantId: 'pet:executor' }]), [human, pet]), false);
  assert.equal(router.applies(message({ kind: 'human', id: 'local' }), [human]), false);
});

test('a decision routes only above the threshold and only to a candidate', async () => {
  const decide = (target: string, confidence: number) => createChannelRouter({ enabled: true, threshold: 0.6 }, {
    decider: async () => ({ target, confidence, reason: 'r' }),
  })!.decide(input);
  assert.deepEqual(await decide('pet:executor', 0.9), { kind: 'route', participantId: 'pet:executor', confidence: 0.9, reason: 'r' });
  assert.deepEqual(await decide('pet:executor', 0.4), { kind: 'skip', reason: 'low_confidence', confidence: 0.4 });
  assert.deepEqual(await decide('none', 0.9), { kind: 'skip', reason: 'none', confidence: 0.9 });
  assert.deepEqual(await decide('pet:ghost', 0.9), { kind: 'skip', reason: 'invalid', confidence: 0.9, detail: 'Invalid routing target or confidence.' });
});

test('a failing or slow decider skips instead of throwing', async () => {
  const failing = createChannelRouter({ enabled: true }, { decider: async () => { throw new Error('down'); } })!;
  assert.deepEqual(await failing.decide(input), { kind: 'skip', reason: 'error', detail: 'Routing model request failed.' });
  const slow = createChannelRouter({ enabled: true, timeoutMs: 100 }, {
    decider: (_input, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))),
  })!;
  const outcome = await slow.decide(input);
  assert.equal(outcome.kind === 'skip' && outcome.reason, 'error');
});

test('Pet notes from the routing settings reach the decider', async () => {
  let seen: RouteInput | undefined;
  await createChannelRouter({ enabled: true, pets: { executor: 'Runs the work.' } }, {
    decider: async (value) => { seen = value; return { target: 'none', confidence: 1 }; },
  })!.decide(input);
  assert.deepEqual(seen?.pets, [
    { participantId: 'pet:executor', name: 'Executor', description: 'Runs the work.' },
    { participantId: 'pet:reviewer', name: 'Reviewer' },
  ]);
});

test('the Channel collaboration prompt reaches the routing model as Channel context', async () => {
  const channel = { channelId: 'c', title: 'Release', prompt: 'Reviewer handles review questions.', createdBy: { kind: 'human' as const, id: 'local' }, createdAt: '', updatedAt: '' };
  const input = routeInput(channel, message({ kind: 'human', id: 'local' }), undefined, [], [human, pet]);
  let modelInput: RouteInput | undefined;
  const model = { withStructuredOutput: () => ({
    invoke: async (messages: Array<{ content: unknown }>) => {
      modelInput = JSON.parse(String(messages[1]!.content)) as RouteInput;
      return { target: 'none', confidence: 1 };
    },
  }) } as unknown as BaseChatModel;
  await createLlmRouteDecider({ ...endpoint, createChatModel: () => model })(input, AbortSignal.timeout(1_000));
  assert.deepEqual(modelInput?.channel, { title: 'Release', prompt: channel.prompt });
  assert.deepEqual(routeInput({ ...channel, prompt: undefined }, message({ kind: 'human', id: 'local' }), undefined, [], [human, pet]).channel, { title: 'Release' });
});

test('the llm decider resolves its profile at start and fails early for a missing one', () => {
  assert.throws(() => createChannelRouter({ enabled: true, decider: { kind: 'llm', modelProfileId: 'ghost' } }, {
    resolveModel: () => { throw new Error('Unknown model profile "ghost".'); },
  }), /could not resolve the configured model profile/);
  assert.throws(() => createChannelRouter({ enabled: true }, {}), /model profiles/);
});


test('the structured decider uses the configured method and dynamic candidate schema', async () => {
  for (const method of [undefined, 'jsonMode', 'jsonSchema', 'functionCalling'] as const) {
    let observed: { schema: any; options: any; messages: any; signal: unknown } | undefined;
    const controller = new AbortController();
    const model = {
      withStructuredOutput: (schema: any, options: unknown) => ({
        invoke: async (messages: unknown, config: { signal: unknown }) => {
          observed = { schema, options, messages, signal: config.signal };
          return { target: schema.shape.target.options[0], confidence: 0.8, reason: 'Selected' };
        },
      }),
    } as unknown as BaseChatModel;
    let factoryOptions: unknown;
    const decider = createLlmRouteDecider({ ...endpoint, structuredOutputMethod: method,
      createChatModel: (options) => { factoryOptions = options; return model; } });
    assert.deepEqual(await decider(input, controller.signal), { target: 'pet:executor', confidence: 0.8, reason: 'Selected' });
    assert.deepEqual(factoryOptions, { maxOutputTokens: 300, maxRetries: 0, preferDeterministic: true, streaming: false, forceChatCompletions: true });
    assert.deepEqual(observed?.schema.shape.target.options, ['pet:executor', 'pet:reviewer', 'none']);
    assert.deepEqual(observed?.options, { name: 'channel_route', method: method ?? 'jsonMode' });
    assert.equal(observed?.signal, controller.signal);
    assert.equal(observed?.messages[0]._getType(), 'system');
    assert.equal(observed?.messages[1]._getType(), 'human');
    await decider({ ...input, pets: [{ participantId: 'pet:new', name: 'New' }] }, controller.signal);
    assert.deepEqual(observed?.schema.shape.target.options, ['pet:new', 'none']);
  }
});

test('custom endpoints keep the legacy jsonMode default regardless of protocol', async () => {
  let calls = 0;
  const model = { withStructuredOutput: (_schema: unknown, options: unknown) => {
    assert.deepEqual(options, { name: 'channel_route', method: 'jsonMode' });
    return { invoke: async () => {
      calls += 1;
      return { target: 'none', confidence: 0.9, reason: 'No response needed' };
    } };
  } } as unknown as BaseChatModel;
  const decider = createLlmRouteDecider({
    ...endpoint, protocol: 'anthropic-compatible', structuredOutputMethod: undefined,
    createChatModel: () => model,
  });
  assert.deepEqual(await decider(input, new AbortController().signal), { target: 'none', confidence: 0.9, reason: 'No response needed' });
  assert.equal(calls, 1);
});

test('routing rejects endpoints without the Host model factory at startup', () => {
  assert.throws(() => createLlmRouteDecider(endpoint), /createChatModel/);
  assert.throws(() => createChannelRouter({ enabled: true }, { resolveModel: () => endpoint }), /createChatModel/);
});


test('model construction and output failures do not expose private values', async () => {
  const secret = 'PRIVATE_CONSTRUCTION_SECRET';
  assert.throws(() => createChannelRouter({ enabled: true }, { resolveModel: () => { throw new Error(secret); } }), (error: Error) => {
    assert.equal(error.message, 'Channel routing could not resolve the configured model profile.');
    assert.doesNotMatch(error.message, /PRIVATE_CONSTRUCTION_SECRET/);
    return true;
  });
  assert.throws(() => createLlmRouteDecider({ ...endpoint,
    createChatModel: () => { throw new Error(secret); } }), (error: Error) => {
    assert.equal(error.message, 'Routing model initialization failed.');
    assert.doesNotMatch(error.message, /PRIVATE_CONSTRUCTION_SECRET/);
    return true;
  });
  const model = { withStructuredOutput: () => { throw new Error(secret); } } as unknown as BaseChatModel;
  const router = createChannelRouter({ enabled: true }, { resolveModel: () => ({ ...endpoint, createChatModel: () => model }) })!;
  assert.deepEqual(await router.decide(input), { kind: 'skip', reason: 'error', detail: 'Routing model request failed.' });
  const custom = createChannelRouter({ enabled: true }, { decider: async () => { throw new Error(secret); } })!;
  assert.deepEqual(await custom.decide(input), { kind: 'skip', reason: 'error', detail: 'Routing model request failed.' });
  const invalid = createChannelRouter({ enabled: true }, { decider: async () => ({ target: secret, confidence: 0.9 }) })!;
  assert.deepEqual(await invalid.decide(input), { kind: 'skip', reason: 'invalid', confidence: 0.9, detail: 'Invalid routing target or confidence.' });
});


test('invalid structured decisions fail locally without retrying or exposing output', async () => {
  for (const decision of [
    { target: 'PRIVATE_OUTPUT', confidence: 0.8, reason: 'Invalid target' },
    { target: 'pet:executor', confidence: 2, reason: 'Invalid confidence' },
  ]) {
    let calls = 0;
    const model = { withStructuredOutput: () => ({ invoke: async () => {
      calls += 1;
      return decision;
    } }) } as unknown as BaseChatModel;
    const router = createChannelRouter({ enabled: true }, {
      resolveModel: () => ({ ...endpoint, structuredOutputMethod: undefined, createChatModel: () => model }),
    })!;
    assert.deepEqual(await router.decide(input), {
      kind: 'skip', reason: 'error', detail: 'Routing model request failed.',
    });
    assert.equal(calls, 1);
  }
});
