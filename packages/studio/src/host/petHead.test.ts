import assert from 'node:assert/strict';
import { AIMessage, AIMessageChunk } from '@langchain/core/messages';
import { toJsonSchema, Validator } from '@langchain/core/utils/json_schema';
import { buildModel } from 'pinpawo/host-runtime';
import test from 'node:test';
import { bindPetHeadChannel, createPetHead, isHeadAddressed, type HeadMessage, type PetHeadChannel } from './petHead';
import { createHeadModel } from './petHeadModel';
import type { StudioModelEndpoint } from '../studioContract';
import type { StudioPetRegistration } from '../types';
import type { StudioEvent, StudioEventHandler, StudioEventSubscriptionFilter } from '../studioContract';

const relevant = async () => ({ relevant: true });
const noDispatchDecision = async (): Promise<never> => assert.fail('unexpected Dispatch decision');
const pet = (petId: string, channelId = 'team'): StudioPetRegistration => ({
  petId, channelId, definitionId: 'assistant', name: petId, createdAt: '2026-01-01T00:00:00Z',
});
const message = (id: string, overrides: Partial<HeadMessage> = {}): HeadMessage => ({
  sequence: Number(id) || 1, messageId: id, channelId: 'team',
  author: { kind: 'human', id: 'owner' }, occurredAt: '2026-01-01T00:00:00Z',
  body: `message ${id}`, mentions: [], ...overrides,
});
function bus() {
  const handlers = new Set<{ channelId: string; handle: (message: HeadMessage) => Promise<void> }>();
  return {
    subscribe: (channelId: string, handle: (message: HeadMessage) => Promise<void>) => {
      const entry = { channelId, handle };
      handlers.add(entry);
      return () => { handlers.delete(entry); };
    },
    publish: async (value: HeadMessage) => {
      await Promise.all([...handlers].filter(item => item.channelId === value.channelId).map(item => item.handle(value)));
    },
  };
}
/** Exercise the same ownership contract as an active instance: abort and unsubscribe together. */
function activate(
  options: Omit<Parameters<typeof createPetHead>[0], 'channel'> & { channel: Omit<PetHeadChannel, 'subscribe'> },
  events: ReturnType<typeof bus>,
) {
  const channel: PetHeadChannel = {
    ...options.channel,
    subscribe: handler => events.subscribe(options.pet.channelId, handler),
  };
  const controller = new AbortController();
  const handle = createPetHead({ ...options, channel });
  const unsubscribe = channel.subscribe(value => handle(value, controller.signal));
  return () => { controller.abort(); unsubscribe(); };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test('the bound Channel exposes only its committed live messages and forwards operations with its owner id', async () => {
  let handler: StudioEventHandler | undefined;
  let filter: StudioEventSubscriptionFilter | undefined;
  const calls: unknown[][] = [];
  const channel = bindPetHeadChannel('team', {
    readContext: async (...args) => { calls.push(['read', ...args]); return { messages: [] }; },
    reply: async (...args) => { calls.push(['reply', ...args]); },
    dispatch: async (...args) => { calls.push(['dispatch', ...args]); },
  }, (listener, scope) => { handler = listener; filter = scope; return () => { handler = undefined; }; });
  const seen: HeadMessage[] = [];
  const unsubscribe = channel.subscribe(async value => { seen.push(value); });
  assert.deepEqual(filter, { source: 'channel', topic: 'team' });
  const wrap = (payload: unknown): StudioEvent => ({ eventId: '1', type: 'channel.message.created', source: 'channel', topic: 'team', occurredAt: '2026-01-01T00:00:00Z', payload });
  const current = message('2');
  await handler?.({ ...wrap(current), source: 'other' });
  await handler?.({ ...wrap(current), type: 'channel.updated' });
  await handler?.({ ...wrap(current), topic: 'other' });
  await handler?.({ ...wrap(current), topic: undefined });
  await handler?.(wrap(message('3', { channelId: 'other' })));
  await handler?.(wrap({ bad: true }));
  await handler?.(wrap(current));
  assert.deepEqual(seen, [current]);
  await channel.readContext('a', 3, '1');
  const signal = new AbortController().signal;
  await channel.reply('a', '2', 'yes', signal);
  await channel.dispatch('a', current.messageId, signal);
  assert.deepEqual(calls, [
    ['read', 'team', 'a', 3, '1'],
    ['reply', 'team', 'a', '2', 'yes', signal, undefined],
    ['dispatch', 'team', 'a', current.messageId, signal],
  ]);
  unsubscribe();
  assert.equal(handler, undefined);
});

test('only live messages in the owned Channel reach each Head; reactivation never replays missed events', async () => {
  const events = bus();
  const seen: Array<{ petId: string; message: unknown }> = [];
  const channel = {
    readContext: async () => ({ messages: [] }),
    reply: async () => { throw new Error('unexpected reply'); },
    dispatch: async () => { throw new Error('unexpected dispatch'); },
  };
  const make = (petId: string, channelId = 'team') => activate({
    pet: pet(petId, channelId), channel,
    decideDispatch: noDispatchDecision,
    assessRelevance: async input => { seen.push({ petId: input.pet.petId, message: input.message }); return { relevant: false }; },
  }, events);
  await events.publish(message('1')); // no instances are subscribed
  const a = make('a');
  const b = make('b');
  const other = make('c', 'other');
  const live = message('2', { replyTo: '1', deliverables: [{ uri: 'https://example.test/report' }] });
  await events.publish(live);
  assert.deepEqual(seen, [{ petId: 'a', message: live }, { petId: 'b', message: live }]);
  a(); b(); other();
  await events.publish(message('3'));
  const resumed = make('a');
  await events.publish(message('4'));
  assert.deepEqual(seen.map(item => [item.petId, (item.message as { messageId: string }).messageId]), [['a', '2'], ['b', '2'], ['a', '4']]);
  resumed();
});

test('a Head ignores its own messages and messages in other Channels', async () => {
  const events = bus();
  const seen: unknown[] = [];
  const unsubscribe = activate({ pet: pet('a'),
    channel: { readContext: async () => ({ messages: [] }), reply: async () => {}, dispatch: async () => {} },
    decideDispatch: noDispatchDecision,
    assessRelevance: async input => { seen.push(input.message); return { relevant: false }; },
  }, events);
  await events.publish(message('1', { author: { kind: 'pet', id: 'a' } }));
  await events.publish(message('2', { channelId: 'other' }));
  assert.deepEqual(seen, []);
  unsubscribe();
});

test('the Dispatch decision can choose publication and dispatch independently with exact attribution', async () => {
  for (const shouldDispatch of [false, true]) for (const reply of [null, 'Acknowledged']) {
    const calls: unknown[][] = [];
    const source = message('1', { author: { kind: 'pet', id: 'peer' }, replyTo: 'older' });
    const signal = new AbortController().signal;
    const handler = createPetHead({ pet: pet('a'),
      channel: { subscribe: () => () => {}, readContext: async () => ({ messages: [] }),
        reply: async (...args) => { calls.push(['reply', ...args]); }, dispatch: async (...args) => { calls.push(['dispatch', ...args]); } },
      assessRelevance: relevant, decideDispatch: async () => ({ shouldDispatch, reply }),
    });
    await handler(source, signal);
    assert.equal(calls.filter(call => call[0] === 'reply').length, reply ? 1 : 0);
    assert.equal(calls.filter(call => call[0] === 'dispatch').length, shouldDispatch ? 1 : 0);
    if (reply) assert.deepEqual(calls.at(-1), ['reply', 'a', '1', reply, signal, { preventPetMentions: true }]);
    if (shouldDispatch) assert.deepEqual(calls[0], ['dispatch', 'a', source.messageId, signal]);
  }
});

test('publication and admission failures are independent and do not leak provider errors', async () => {
  for (const fail of ['reply', 'dispatch', 'both']) {
    const calls: string[] = [];
    const handler = createPetHead({ pet: pet('a'),
      channel: { subscribe: () => () => {}, readContext: async () => ({ messages: [] }),
        reply: async () => { calls.push('reply'); if (fail !== 'dispatch') throw new Error('private reply detail'); },
        dispatch: async () => { calls.push('dispatch'); if (fail !== 'reply') throw new Error('private dispatch detail'); } },
      assessRelevance: relevant,
      decideDispatch: async () => ({ shouldDispatch: true, reply: 'I can look into this.' }),
    });
    await assert.rejects(handler(message('1'), new AbortController().signal), error => {
      assert.equal((error as Error).message, 'Pet Head processing failed: ' + (fail === 'both' ? 'reply, dispatch' : fail) + '.'); return true;
    });
    assert.deepEqual(calls, ['dispatch', 'reply']);
  }
});

test('deactivation cancels an in-flight decision and never publishes or dispatches late', async () => {
  const controller = new AbortController();
  const started = deferred<void>();
  const pending = deferred<{ relevant: boolean }>();
  const effects: string[] = [];
  const handler = createPetHead({ pet: pet('a'),
    channel: { subscribe: () => () => {}, readContext: async () => ({ messages: [] }),
      reply: async () => { effects.push('reply'); }, dispatch: async () => { effects.push('dispatch'); } },
    decideDispatch: noDispatchDecision,
    assessRelevance: async () => { started.resolve(); return pending.promise; },
  });
  const run = handler(message('1'), controller.signal);
  await started.promise; controller.abort();
  pending.resolve({ relevant: true });
  await run;
  assert.deepEqual(effects, []);
});

test('cancellation while context is loading never starts a decision', async () => {
  const events = bus();
  const started = deferred<void>();
  const context = deferred<{ messages: [] }>();
  let decisions = 0;
  const unsubscribe = activate({ pet: pet('a'),
    channel: { readContext: async () => { started.resolve(); return context.promise; }, reply: async () => {}, dispatch: async () => {} },
    decideDispatch: noDispatchDecision,
    assessRelevance: async () => { decisions++; return { relevant: false }; },
  }, events);
  const pending = events.publish(message('1'));
  await started.promise;
  unsubscribe();
  context.resolve({ messages: [] });
  await pending;
  assert.equal(decisions, 0);
});

const decisionInput = { pet: pet('a'), message: message('1'), context: { messages: [] } };
test('Head prompt keeps its prefix stable and sends ten prior public messages plus any older target once', async () => {
  const current = message('20', { replyTo: '2', body: 'Inspect the note.', mentions: [{ participantId: 'pet:a' }, { participantId: 'pet:b' }] });
  const history = Array.from({ length: 15 }, (_, i) => message(String(i + 1), {
    mentions: [{ participantId: 'pet:b' }], externalRef: 'private-reference',
  }));
  const context = {
    channel: { title: 'Review', description: 'Evidence only', prompt: 'Check the sources', workdir: '/private/location' },
    messages: [current, message('21'), message('19', { channelId: 'foreign' }), ...history, history[14]!],
    members: [
      { kind: 'pet' as const, id: 'a', participantId: 'pet:a', label: 'A' },
      { kind: 'pet' as const, id: 'b', participantId: 'pet:b', label: 'B' },
      { kind: 'pet' as const, id: 'c', participantId: 'pet:c', label: 'C' },
    ],
    referencedMessage: history[1],
    queuedDispatches: 99,
  };
  const mock = mockEndpoint([structured({ relevant: true }), structured({ relevant: false })]);
  const model = createHeadModel(() => mock.endpoint);
  const signal = new AbortController().signal;
  const base = { pet: pet('a'), description: 'Reviewer', message: current, context, addressed: true };
  await model.assessRelevance(base, signal);
  await model.assessRelevance({ ...base, message: { ...current, replyTo: '15' },
    context: { ...context, referencedMessage: history[14] }, addressed: false }, signal);
  const [system, [, wire]] = mock.calls[0]!.messages as Array<[string, string]>;
  const inWindow = mock.calls[1]!.messages as Array<[string, string]>;
  assert.deepEqual(system, inWindow[0], 'a mention and different reference cannot change the system/cache prefix');
  const projection = JSON.parse(wire!);
  assert.deepEqual(Object.keys(projection), ['pet', 'context', 'message', 'addressed']);
  assert.deepEqual(projection.context.channel, { title: 'Review', description: 'Evidence only', prompt: 'Check the sources' });
  assert.deepEqual(projection.context.messages.map((item: { messageId: string }) => item.messageId), ['6','7','8','9','10','11','12','13','14','15']);
  assert.deepEqual(projection.context.referencedMessage, { messageId: '2', sequence: 2, author: current.author, body: 'message 2' });
  assert.ok(projection.context.messages.every((item: object) => !['mentions', 'externalRef', 'channelId'].some(key => Object.hasOwn(item, key))));
  assert.equal(Object.hasOwn(projection.context, 'members'), false);
  assert.equal(Object.hasOwn(projection.context, 'queuedDispatches'), false);
  assert.deepEqual(projection.message, {
    channelId: 'team', messageId: '20', sequence: 20, author: current.author, body: current.body, replyTo: '2',
    mentions: [
      { participantId: 'pet:a', kind: 'pet', id: 'a', label: 'A' },
      { participantId: 'pet:b', kind: 'pet', id: 'b', label: 'B' },
    ],
  });
  assert.equal(projection.addressed, true);
  assert.equal(JSON.parse(inWindow[1]![1]).context.referencedMessage, undefined);
  assert.equal(JSON.parse(inWindow[1]![1]).addressed, false);
});
const raw = (value: unknown) => new AIMessage(JSON.stringify(value));
const relevanceName = 'pet_head_relevance';
const dispatchName = 'pet_head_dispatch';
const tool = (args: Record<string, unknown>, name = relevanceName) => new AIMessage({ content: '', tool_calls: [{ name, args }] });
const structured = (value: Record<string, unknown>, method: StudioModelEndpoint['structuredOutputMethod'] = 'jsonMode', name = relevanceName) =>
  ({ raw: method === 'functionCalling' ? tool(value, name) : raw(value), parsed: value });

function mockEndpoint(outputs: unknown[], method?: StudioModelEndpoint['structuredOutputMethod']) {
  const calls: Array<{ mode: string; messages: unknown; signal: unknown }> = [];
  let binding: unknown;
  let schema: unknown;
  let factory: unknown;
  let factoryCalls = 0;
  const invoke = (mode: string) => async (messages: unknown, config: { signal: AbortSignal }) => {
    calls.push({ mode, messages, signal: config.signal });
    const value = outputs.shift();
    if (value instanceof Error) throw value;
    if (typeof value === 'function') return value();
    return value;
  };
  const endpoint = { profileId: 'test', baseUrl: 'https://example.test', apiKey: 'secret', model: 'test', structuredOutputMethod: method,
    createChatModel: (options: unknown) => { factory = options; factoryCalls++; return {
      withStructuredOutput: (value: Parameters<typeof toJsonSchema>[0], options: unknown) => {
        schema = toJsonSchema(value); binding = options; return { invoke: invoke('structured') };
      },
      invoke: invoke('unbound'),
    }; } };
  return { endpoint: endpoint as unknown as StudioModelEndpoint, calls, schema: () => schema, binding: () => binding,
    factory: () => factory, factoryCalls: () => factoryCalls };
}

const contracts = [
  { name: relevanceName, invoke: 'assessRelevance', value: { relevant: true },
    invalid: [{}, { relevant: 42 }, { relevant: true, shouldDispatch: true }] },
  { name: dispatchName, invoke: 'decideDispatch', value: { shouldDispatch: true, reply: null },
    invalid: [{ shouldDispatch: true }, { shouldDispatch: true, reply: 42 }, { shouldDispatch: true, reply: null, intent: 'rewritten work' }] },
] as const;

test('both structured contracts use only their declared schema and configured wire method', async () => {
  for (const contract of contracts) for (const method of [undefined, 'functionCalling', 'jsonMode', 'jsonSchema'] as const) {
    const mock = mockEndpoint([structured(contract.value, method, contract.name)], method);
    const signal = new AbortController().signal;
    const model = createHeadModel(() => mock.endpoint);
    assert.deepEqual(await model[contract.invoke](decisionInput, signal), contract.value);
    assert.deepEqual(mock.factory(), { maxRetries: 0, preferDeterministic: true, streaming: false });
    assert.deepEqual(mock.binding(), { name: contract.name, method: method ?? 'jsonMode', includeRaw: true });
    assert.deepEqual(mock.calls.map(call => call.mode), ['structured']);
    assert.equal(mock.calls[0]!.signal, signal);
    const schema = mock.schema() as Exclude<ConstructorParameters<typeof Validator>[0], boolean>;
    assert.deepEqual(Object.keys(schema.properties ?? {}), Object.keys(contract.value));
    assert.equal(schema.additionalProperties, false);
    const validator = new Validator(schema, '7');
    assert.equal(validator.validate(contract.value).valid, true);
    for (const value of contract.invalid) assert.equal(validator.validate(value).valid, false);
  }
});

test('both contracts reject invalid structured declarations exactly once', async () => {
  for (const contract of contracts) for (const method of ['functionCalling', 'jsonMode', 'jsonSchema'] as const) {
    const valid = structured(contract.value, method, contract.name);
    const bad = [
      ...contract.invalid.map(value => structured(value, method, contract.name)),
      method === 'functionCalling' ? { raw: tool(contract.value, 'other'), parsed: contract.value }
        : { raw: new AIMessage('Incomplete JSON: {'), parsed: null },
    ];
    for (const output of bad) {
      const mock = mockEndpoint([output, valid], method);
      const model = createHeadModel(() => mock.endpoint);
      await assert.rejects(model[contract.invoke](decisionInput, new AbortController().signal));
      assert.deepEqual(mock.calls.map(call => call.mode), ['structured']);
    }
  }
});

test('failure at either model stage produces no reply or admission', async () => {
  for (const [outputs, expectedCalls] of [
    [[structured({ relevant: true, reply: 'Unexpected relevance text' })], 1],
    [[structured({ relevant: true }), structured({ shouldDispatch: true, reply: 'Not admitted.', timing: 'interrupt' })], 2],
  ] as const) {
    const mock = mockEndpoint([...outputs]);
    const model = createHeadModel(() => mock.endpoint);
    const handle = createPetHead({ pet: pet('a'),
      channel: { subscribe: () => () => {}, readContext: async () => ({ messages: [] }),
        reply: async () => assert.fail('invalid output cannot publish'),
        dispatch: async () => assert.fail('invalid output cannot admit work'),
      },
      assessRelevance: model.assessRelevance, decideDispatch: model.decideDispatch,
    });
    await assert.rejects(handle(message('2'), new AbortController().signal), /Invalid Pet Head/);
    assert.equal(mock.calls.length, expectedCalls);
  }
});

test('relevance reports its own finite outcomes, not an execution decision or raw data', async () => {
  const valid = { relevant: true };
  const unrelated = { relevant: false };
  const mock = mockEndpoint([structured(valid), structured(unrelated),
    { raw: new AIMessage({ content: JSON.stringify(valid), response_metadata: { finish_reason: 'length' } }), parsed: valid },
    { raw: new AIMessage({ content: JSON.stringify(valid), response_metadata: { finish_reason: 'content_filter' } }), parsed: valid },
    new Error('private provider payload')]);
  const events: unknown[] = [];
  const { assessRelevance } = createHeadModel(() => mock.endpoint, { onDiagnostic: event => events.push(event) });
  const signal = new AbortController().signal;
  assert.deepEqual(await assessRelevance(decisionInput, signal), valid);
  assert.deepEqual(await assessRelevance(decisionInput, signal), unrelated);
  for (let i = 0; i < 3; i++) await assert.rejects(assessRelevance(decisionInput, signal), error => {
    assert.doesNotMatch(String(error), /private provider payload/);
    return true;
  });
  assert.deepEqual(events, [
    { outcome: 'related' }, { outcome: 'unrelated' }, { outcome: 'error', code: 'truncated' },
    { outcome: 'error', code: 'refusal' }, { outcome: 'error', code: 'provider_error' },
  ].map(outcome => ({ petId: 'a', channelId: 'team', messageId: '1', attempts: 1, ...outcome })));
  assert.equal(mock.calls.length, 5);
});

test('abort before or during relevance provider work prevents selection', async () => {
  for (const before of [true, false]) {
    const controller = new AbortController();
    const mock = mockEndpoint([() => { controller.abort(); return structured({ relevant: true }); }]);
    if (before) controller.abort();
    const events: Array<{ outcome: string; code?: string }> = [];
    const model = createHeadModel(() => mock.endpoint, { onDiagnostic: event => events.push(event) });
    await assert.rejects(model.assessRelevance(decisionInput, controller.signal));
    assert.equal(mock.calls.length, before ? 0 : 1);
    assert.equal(events[0]?.code, 'aborted');
  }
});

function nativeEndpoint(protocol: NonNullable<StudioModelEndpoint['protocol']>, model: string, method?: StudioModelEndpoint['structuredOutputMethod'],
  baseUrl = protocol === 'anthropic-compatible' ? 'https://api.anthropic.test'
    : model.startsWith('deepseek-') ? 'https://api.deepseek.com/v1' : 'https://api.openai.com/v1'): StudioModelEndpoint {
  const endpoint = { profileId: 'fixture', protocol, model, baseUrl, apiKey: 'fixture-only', structuredOutputMethod: method };
  return { ...endpoint, createChatModel: options => buildModel({ ...endpoint, maxOutputTokens: options.maxOutputTokens ?? 4096, maxRetries: options.maxRetries, timeoutMs: 2_000 },
    { streaming: options.streaming, preferDeterministic: options.preferDeterministic }) };
}

test('official DeepSeek Flash / Pro sends each contract through actual JSON mode', async t => {
  const calls: Array<{ url: string; body: { model: string; response_format: unknown; tools?: unknown; thinking?: unknown; max_tokens?: number; max_completion_tokens?: number } }> = [];
  let content = '';
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ url: String(url), body });
    return Response.json({ id: 'fixture', object: 'chat.completion', created: 0, model: body.model,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  });
  const signal = new AbortController().signal;
  for (const model of ['deepseek-flash', 'deepseek-v4-pro']) {
    const head = createHeadModel(() => nativeEndpoint('openai-compatible', model, 'jsonMode'));
    for (const contract of contracts) {
      content = JSON.stringify(contract.value);
      assert.deepEqual(await head[contract.invoke](decisionInput, signal), contract.value);
      content = JSON.stringify(contract.invalid[0]);
      await assert.rejects(head[contract.invoke](decisionInput, signal));
    }
  }
  assert.equal(calls.length, 8);
  for (const { url, body } of calls) {
    assert.equal(url, 'https://api.deepseek.com/v1/chat/completions');
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.equal(body.tools, undefined);
    assert.equal(Object.hasOwn(body, 'thinking'), false);
    assert.equal(body.max_completion_tokens ?? body.max_tokens, 4096);
  }
});

test('a custom DeepSeek gateway also receives the configured profile output budget', async t => {
  const requests: number[] = [];
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    assert.equal(Object.hasOwn(body, 'thinking'), false);
    requests.push(body.max_completion_tokens ?? body.max_tokens);
    return Response.json({ id: 'fixture', object: 'chat.completion', created: 0, model: body.model,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{"shouldDispatch":true,"reply":null}' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  });
  const head = createHeadModel(() => nativeEndpoint('openai-compatible', 'deepseek-flash', 'jsonMode', 'https://gateway.test/v1'));
  assert.deepEqual(await head.decideDispatch(decisionInput, new AbortController().signal), { shouldDispatch: true, reply: null });
  assert.deepEqual(requests, [4096]);
});

test('an addressed human or peer artifact review uses idle admission, but its status inquiry does not', async t => {
  const participantId = 'pet:a';
  const fixtures = (['human', 'pet'] as const).flatMap((kind, index) => [
    { work: true, incoming: message(String(index * 2 + 1), { author: { kind, id: 'other' }, mentions: [{ participantId }],
      body: '[@Reviewer](participant:pet:a) 请独立复核已交付的方案，指出缺失的证据。' }) },
    { work: false, incoming: message(String(index * 2 + 2), { author: { kind, id: 'other' }, mentions: [{ participantId }],
      body: '[@Reviewer](participant:pet:a) 这项复核进行到哪了？不要重做。' }) },
  ]);
  const seen: string[] = [];
  const admitted: string[] = [];
  const replies: Array<[string, string]> = [];
  const cannotConfirm = '无法确认这项复核的状态。';
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    const input = JSON.parse(body.messages.find((entry: { role: string }) => entry.role === 'user').content);
    const fixture = fixtures.find(item => item.incoming.messageId === input.message.messageId);
    assert.ok(fixture);
    assert.equal(input.addressed, true);
    assert.deepEqual(input.message.mentions, [{ participantId, kind: 'pet', id: 'a' }]);
    assert.deepEqual(body.response_format, { type: 'json_object' });
    seen.push(fixture.incoming.messageId);
    const content = JSON.stringify({ shouldDispatch: fixture.work, reply: fixture.work ? null : cannotConfirm });
    return Response.json({ id: 'fixture', object: 'chat.completion', created: 0, model: body.model,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  });
  const model = createHeadModel(() => nativeEndpoint('openai-compatible', 'deepseek-flash'));
  const handle = createPetHead({ pet: pet('a'),
    channel: { subscribe: () => () => {},
      readContext: async () => ({ messages: [], members: [{ kind: 'pet', id: 'a', participantId }] }),
      reply: async (_pet, id, text) => { replies.push([id, text]); },
      dispatch: async (_pet, id) => { admitted.push(id); },
    },
    assessRelevance: async () => assert.fail('canonical @ is already relevant'),
    decideDispatch: model.decideDispatch,
  });
  for (const { incoming } of fixtures) await handle(incoming, new AbortController().signal);
  assert.deepEqual(seen, fixtures.map(item => item.incoming.messageId));
  assert.deepEqual(admitted, fixtures.filter(item => item.work).map(item => item.incoming.messageId));
  assert.deepEqual(replies, fixtures.filter(item => !item.work).map(item => [item.incoming.messageId, cannotConfirm]));
});

test('native OpenAI schema keeps relevance boolean-only and Dispatch reply required nullable', async t => {
  const outputs = [...contracts.map(contract => ({ ...contract, output: contract.value })),
    { ...contracts[1], output: { shouldDispatch: false, reply: 'Direct response.' } }];
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    const { output, name: expected, invalid } = outputs[requests++]!;
    assert.equal(String(url), 'https://api.openai.com/v1/chat/completions');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.response_format.type, 'json_schema');
    const { name, strict, schema } = body.response_format.json_schema;
    assert.equal(name, expected);
    assert.equal(strict, true);
    assert.deepEqual(schema.required, Object.keys(output));
    assert.equal(schema.additionalProperties, false);
    const validator = new Validator(schema, '7');
    assert.equal(validator.validate(output).valid, true);
    for (const value of invalid) assert.equal(validator.validate(value).valid, false);
    return Response.json({ id: 'fixture', object: 'chat.completion', created: 0, model: body.model,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(output) } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  });
  const head = createHeadModel(() => nativeEndpoint('openai-compatible', 'gpt-5.5', 'jsonSchema'));
  for (const { invoke, output } of outputs) assert.deepEqual(await head[invoke](decisionInput, new AbortController().signal), output);
  assert.equal(requests, outputs.length);
});

test('native Anthropic accepts exactly one tool for the stage and does not repair malformed results', async t => {
  const calls: Array<{ tools: Array<{ name: string }>; tool_choice: unknown; output_config?: unknown }> = [];
  let content: unknown[] = [];
  let stopReason = 'tool_use';
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body)));
    return Response.json({ id: 'fixture', type: 'message', role: 'assistant', model: 'claude-haiku-4-5',
      content, stop_reason: stopReason, usage: { input_tokens: 1, output_tokens: 1 } });
  });
  const head = createHeadModel(() => nativeEndpoint('anthropic-compatible', 'claude-haiku-4-5', 'functionCalling'));
  const signal = new AbortController().signal;
  for (const contract of contracts) {
    const start = calls.length;
    const declaration = (id: string, name = contract.name) => ({ type: 'tool_use', id, name, input: contract.value });
    content = [declaration('valid')];
    stopReason = 'tool_use';
    assert.deepEqual(await head[contract.invoke](decisionInput, signal), contract.value);
    let attempts = 1;
    for (const [blocks, stop] of [
      [[{ type: 'text', text: JSON.stringify(contract.value) }], 'end_turn'],
      [[declaration('wrong', contract.name === relevanceName ? dispatchName : relevanceName)], 'tool_use'],
      [[declaration('first'), declaration('second')], 'tool_use'],
      [[{ ...declaration('bad_shape'), input: contract.invalid[0] }], 'tool_use'],
      [[declaration('refused')], 'refusal'],
      [[declaration('truncated')], 'max_tokens'],
    ] as const) {
      content = [...blocks]; stopReason = stop;
      await assert.rejects(head[contract.invoke](decisionInput, signal));
      assert.equal(calls.length, start + ++attempts);
    }
    for (const body of calls.slice(start)) {
      assert.deepEqual(body.tools.map(entry => entry.name), [contract.name]);
      assert.deepEqual(body.tool_choice, { type: 'tool', name: contract.name });
      assert.equal(body.output_config, undefined);
    }
  }
});

test('a canonical mention establishes relevance, not dispatch; a label or quotation cannot', async () => {
  const participantId = 'pet:a%28b%29';
  const base = { pet: pet('a(b)'), context: { messages: [], members: [{ kind: 'pet' as const, id: 'a(b)', participantId }] } };
  const named = message('2', { mentions: [{ participantId, label: 'not the current label' }], body: '[@Reviewer](participant:pet:a%28b%29)' });
  const addressedInput = { ...base, message: named };
  const matchingLabelOnly = message('3', { body: '@a(b)', mentions: [{ participantId: 'pet:other', label: 'a(b)' }] });
  const lookalike = { ...base, context: { ...base.context, messages: [named] }, message: matchingLabelOnly };
  assert.equal(isHeadAddressed(addressedInput), true);
  assert.equal(isHeadAddressed(lookalike), false);
  const calls: Array<[string, boolean | undefined]> = [];
  const handle = createPetHead({ pet: base.pet,
    channel: { subscribe: () => () => {}, readContext: async () => lookalike.context,
      reply: async () => assert.fail('bare mention need not produce text'),
      dispatch: async () => assert.fail('bare mention is not admission'),
    },
    assessRelevance: async input => { calls.push(['relevance', input.addressed]); return { relevant: false }; },
    decideDispatch: async input => { calls.push(['dispatch', input.addressed]); return { shouldDispatch: false, reply: null }; },
  });
  const signal = new AbortController().signal;
  await handle(named, signal);
  await handle(matchingLabelOnly, signal);
  assert.deepEqual(calls, [['dispatch', true], ['relevance', false]]);
});

test('only relevant input reads task facts before one Dispatch decision', async () => {
  const calls: string[] = [];
  const source = message('1', { body: 'Do A.' });
  const handle = createPetHead({
    pet: pet('a'),
    channel: { subscribe: () => () => {},
      readContext: async () => ({ messages: [source, message('other', { channelId: 'elsewhere' })] }),
      readBoundSessionId: async () => { calls.push('binding'); return 'session'; },
      dispatch: async (_, id, _signal, sessionId) => { assert.equal(id, '3'); assert.equal(sessionId, 'session'); calls.push('submit'); },
      reply: async (_, _id, text) => { assert.equal(text, 'A is done.'); calls.push('reply'); },
    },
    assessRelevance: async input => {
      assert.equal('tasks' in input, false);
      calls.push('relevance');
      return { relevant: input.message.messageId === '3' };
    },
    readSession: async (sessionId, sources) => {
      assert.equal(sessionId, 'session');
      assert.deepEqual([...sources], ['1']);
      calls.push('readSession');
      return [{ messageId: '1', status: 'completed' }];
    },
    decideDispatch: async input => {
      assert.deepEqual(input.tasks, [{ messageId: '1', status: 'completed' }]);
      calls.push('decision');
      return { shouldDispatch: true, reply: 'A is done.' };
    },
  });
  const signal = new AbortController().signal;
  await handle(message('2'), signal);
  await handle(message('3'), signal);
  assert.deepEqual(calls, ['relevance', 'relevance', 'binding', 'readSession', 'decision', 'submit', 'reply']);
});
