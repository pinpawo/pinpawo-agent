import assert from 'node:assert/strict';
import { AIMessage, AIMessageChunk } from '@langchain/core/messages';
import { toJsonSchema, Validator } from '@langchain/core/utils/json_schema';
import { PetDispatchRefusedError, buildModel } from 'pinpawo/host-runtime';
import test from 'node:test';
import { bindPetHeadChannel, createPetHead as createProductionPetHead, isHeadAddressed, readHeadWorkState, type HeadMessage,
  type HeadInput, type HeadReplyInput, type HeadRunningFacts, type HeadRunningResult, type PetHeadChannel } from './petHead';
import { createHeadModel } from './petHeadModel';
import type { StudioModelEndpoint } from '../studioContract';
import type { StudioPetRegistration } from '../types';
import type { StudioEvent, StudioEventHandler, StudioEventSubscriptionFilter } from '../studioContract';

type HeadOptions = Parameters<typeof createProductionPetHead>[0];
type HeadRunReader = NonNullable<Parameters<ReturnType<typeof createProductionPetHead>['receive']>[2]>;
type TestRunSample = Omit<NonNullable<Awaited<ReturnType<PetHeadChannel['readSession']>>>, 'status'>;
type TestChannel = Omit<PetHeadChannel, 'readSession'> & Partial<Pick<PetHeadChannel, 'readSession'>>;
type TestHeadOptions = Omit<HeadOptions, 'channel' | 'model'> &
  Pick<HeadOptions['model'], 'assessRelevance' | 'decideNewWorkAndReply'> & {
    channel: TestChannel;
    progress?: {
      readRun: HeadRunReader['read'];
      readResult?: HeadRunReader['readResult'];
      readSessionRun?: (id: string, signal: AbortSignal, isCurrent: () => boolean) => Promise<TestRunSample | undefined>;
      compose: (input: HeadReplyInput, signal: AbortSignal) => Promise<string>;
      decideRunning?: (input: HeadInput, facts: HeadRunningFacts, signal: AbortSignal) => Promise<HeadRunningResult>;
    };
  };

function testHead({ channel, progress, assessRelevance, decideNewWorkAndReply, ...options }: TestHeadOptions) {
  const reader = runReader(progress);
  return createProductionPetHead({ ...options,
    observeRun: reader ? () => ({ ...reader, close: () => {} }) : undefined,
    channel: { ...channel, readSession: channel.readSession ?? (async (_pet, id, signal, isCurrent) => {
      if (!id) return { status: 'ready' };
      const sample = await progress?.readSessionRun?.(id, signal, isCurrent);
      return sample ? { ...sample, status: 'running' } : undefined;
    }) },
    model: { assessRelevance, decideNewWorkAndReply,
      suggestDispatchForExistingWork: async (input, facts, signal) => {
        const source = 'source' in facts ? facts.source : undefined;
        if ('source' in facts && progress?.decideRunning) return progress.decideRunning(input, facts, signal);
        return { delivery: null, reply: progress
          ? await progress.compose({ message: input.message, evidence: facts.evidence, ...(source ? { source } : {}) }, signal) : null };
      },
    },
  });
}

function runReader(progress: TestHeadOptions['progress']): HeadRunReader | undefined {
  return progress && { read: progress.readRun, readResult: progress.readResult };
}

function createPetHead(options: TestHeadOptions) {
  const head = testHead(options);
  const reader = runReader(options.progress);
  return (value: HeadMessage, signal: AbortSignal) => head.receive(value, signal, reader);
}

const idle = () => ({ kind: 'idle' as const });
const relevant = async () => ({ relevant: true });
const noIdle = async (): Promise<never> => assert.fail('idle handler called outside a verified idle path');
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
  options: Omit<TestHeadOptions, 'channel'> & { channel: Omit<TestChannel, 'subscribe'> },
  events: ReturnType<typeof bus>,
) {
  const channel: TestChannel = {
    ...options.channel,
    subscribe: handler => events.subscribe(options.pet.channelId, handler),
  };
  const controller = new AbortController();
  const head = testHead({ ...options, channel });
  head.start(controller.signal);
  return () => { controller.abort(); head.close(); };
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
    readSession: async () => ({ status: 'ready' }),
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
  const queue = { kind: 'queue', sessionId: 'retained' } as const;
  await channel.dispatch('a', current.messageId, signal, queue);
  assert.deepEqual(calls, [
    ['read', 'team', 'a', 3, '1'],
    ['reply', 'team', 'a', '2', 'yes', signal, undefined],
    ['dispatch', 'team', 'a', current.messageId, signal],
    ['dispatch', 'team', 'a', current.messageId, signal, queue],
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
    readWorkState: idle, decideNewWorkAndReply: noIdle,
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
    readWorkState: idle, decideNewWorkAndReply: noIdle,
    assessRelevance: async input => { seen.push(input.message); return { relevant: false }; },
  }, events);
  await events.publish(message('1', { author: { kind: 'pet', id: 'a' } }));
  await events.publish(message('2', { channelId: 'other' }));
  assert.deepEqual(seen, []);
  unsubscribe();
});

test('verified idle can choose publication and dispatch independently with exact attribution', async () => {
  for (const shouldDispatch of [false, true]) for (const reply of [null, 'Acknowledged']) {
    const calls: unknown[][] = [];
    const source = message('1', { author: { kind: 'pet', id: 'peer' }, replyTo: 'older' });
    const signal = new AbortController().signal;
    const handler = createPetHead({ pet: pet('a'),
      channel: { subscribe: () => () => {}, readContext: async () => ({ messages: [] }),
        reply: async (...args) => { calls.push(['reply', ...args]); }, dispatch: async (...args) => { calls.push(['dispatch', ...args]); } },
      readWorkState: idle, assessRelevance: relevant, decideNewWorkAndReply: async () => ({ shouldDispatch, reply }),
    });
    await handler(source, signal);
    assert.equal(calls.filter(call => call[0] === 'reply').length, reply ? 1 : 0);
    assert.equal(calls.filter(call => call[0] === 'dispatch').length, shouldDispatch ? 1 : 0);
    if (reply) assert.deepEqual(calls[0], ['reply', 'a', '1', reply, signal, { preventPetMentions: true }]);
    if (shouldDispatch) assert.deepEqual(calls.at(-1), ['dispatch', 'a', source.messageId, signal]);
  }
});

test('publication and admission failures are independent and do not leak provider errors', async () => {
  for (const fail of ['reply', 'dispatch', 'both']) {
    const calls: string[] = [];
    const handler = createPetHead({ pet: pet('a'),
      channel: { subscribe: () => () => {}, readContext: async () => ({ messages: [] }),
        reply: async () => { calls.push('reply'); if (fail !== 'dispatch') throw new Error('private reply detail'); },
        dispatch: async () => { calls.push('dispatch'); if (fail !== 'reply') throw new Error('private dispatch detail'); } },
      readWorkState: idle, assessRelevance: relevant,
      decideNewWorkAndReply: async () => ({ shouldDispatch: true, reply: 'I can look into this.' }),
    });
    await assert.rejects(handler(message('1'), new AbortController().signal), error => {
      assert.equal((error as Error).message, 'Pet Head processing failed: ' + (fail === 'both' ? 'reply, dispatch' : fail) + '.'); return true;
    });
    assert.deepEqual(calls, ['reply', 'dispatch']);
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
    readWorkState: idle, decideNewWorkAndReply: noIdle,
    assessRelevance: async () => { started.resolve(); return pending.promise; },
  });
  const run = handler(message('1'), controller.signal);
  await started.promise; controller.abort();
  pending.resolve({ relevant: true });
  await run;
  assert.deepEqual(effects, []);
});

test('cancellation during publication prevents execution admission', async () => {
  const controller = new AbortController();
  let admissions = 0;
  const handler = createPetHead({ pet: pet('a'),
    channel: { subscribe: () => () => {}, readContext: async () => ({ messages: [] }),
      reply: async () => { controller.abort(); }, dispatch: async () => { admissions++; } },
    readWorkState: idle, assessRelevance: relevant,
    decideNewWorkAndReply: async () => ({ shouldDispatch: true, reply: 'Acknowledged' }),
  });
  await assert.rejects(handler(message('1'), controller.signal), /aborted/);
  assert.equal(admissions, 0);
});

test('cancellation while context is loading never starts a decision', async () => {
  const events = bus();
  const started = deferred<void>();
  const context = deferred<{ messages: [] }>();
  let decisions = 0;
  const unsubscribe = activate({ pet: pet('a'),
    channel: { readContext: async () => { started.resolve(); return context.promise; }, reply: async () => {}, dispatch: async () => {} },
    readWorkState: idle, decideNewWorkAndReply: noIdle,
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
const idleName = 'pet_head_idle';
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
  { name: idleName, invoke: 'decideNewWorkAndReply', value: { shouldDispatch: true, reply: null },
    invalid: [{ reply: null }, { shouldDispatch: 'true', reply: null }, { shouldDispatch: true, reply: 42 },
      { shouldDispatch: true, reply: null, intent: 'rewritten work' }] },
] as const;

test('both structured contracts use only their declared schema and configured wire method', async () => {
  for (const contract of contracts) for (const method of [undefined, 'functionCalling', 'jsonMode', 'jsonSchema'] as const) {
    const mock = mockEndpoint([structured(contract.value, method, contract.name)], method);
    const signal = new AbortController().signal;
    const model = createHeadModel(() => mock.endpoint);
    assert.deepEqual(await model[contract.invoke](decisionInput, signal), contract.value);
    assert.deepEqual(mock.factory(), { maxRetries: 0, preferDeterministic: true, streaming: false, purpose: 'pet-head' });
    assert.deepEqual(mock.binding(), { name: contract.name, method: method ?? 'jsonMode', includeRaw: true });
    assert.deepEqual(mock.calls.map(call => call.mode), ['structured']);
    assert.equal(mock.calls[0]!.signal, signal);
    const schema = mock.schema() as Exclude<ConstructorParameters<typeof Validator>[0], boolean>;
    assert.deepEqual(Object.keys(schema.properties ?? {}), Object.keys(contract.value));
    assert.equal(schema.additionalProperties, false);
    const validator = new Validator(schema, '7');
    assert.equal(validator.validate(contract.value).valid, true);
    if (contract.name === idleName) assert.equal(validator.validate({ shouldDispatch: true }).valid, !method || method === 'jsonMode');
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
    const handle = createPetHead({ pet: pet('a'), readWorkState: idle,
      channel: { subscribe: () => () => {}, readContext: async () => ({ messages: [] }),
        reply: async () => assert.fail('invalid output cannot publish'),
        dispatch: async () => assert.fail('invalid output cannot admit work'),
      },
      assessRelevance: model.assessRelevance, decideNewWorkAndReply: model.decideNewWorkAndReply,
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
    { streaming: options.streaming, preferDeterministic: options.preferDeterministic, purpose: options.purpose }) };
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
    assert.deepEqual(body.thinking, { type: 'disabled' });
    assert.equal(body.max_completion_tokens ?? body.max_tokens, 4096);
  }
});

test('an addressed human or peer request still uses idle handling through a JSON-mode gateway', async t => {
  const participantId = 'pet:a';
  const fixtures = (['human', 'pet'] as const).flatMap((kind, index) => [
    { route: 'work', incoming: message(String(index * 3 + 1), { author: { kind, id: 'other' }, mentions: [{ participantId }],
      body: '[@Reviewer](participant:pet:a) 能不能独立复核已交付的方案，指出缺失的证据？' }) },
    { route: 'status', incoming: message(String(index * 3 + 2), { author: { kind, id: 'other' }, mentions: [{ participantId }],
      body: '[@Reviewer](participant:pet:a) 这项复核进行到哪了？不要重做。' }) },
    { route: 'silent', incoming: message(String(index * 3 + 3), { author: { kind, id: 'other' }, mentions: [{ participantId }],
      body: '[@Reviewer](participant:pet:a)' }) },
  ]);
  const seen: string[] = [];
  const admitted: string[] = [];
  const replies: Array<[string, string]> = [];
  const cannotConfirm = '无法确认这项复核的状态。';
  const gateway = 'https://head-gateway.example.test/v1';
  const model = createHeadModel(() => nativeEndpoint('openai-compatible', 'deepseek-v4.1-flash', 'jsonMode', gateway));
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    assert.equal(String(url), `${gateway}/chat/completions`);
    const body = JSON.parse(String(init?.body));
    const input = JSON.parse(body.messages.find((entry: { role: string }) => entry.role === 'user').content);
    const fixture = fixtures.find(item => item.incoming.messageId === input.message.messageId);
    assert.ok(fixture);
    assert.equal(input.addressed, true);
    assert.deepEqual(input.message.mentions, [{ participantId, kind: 'pet', id: 'a' }]);
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.equal(body.thinking, undefined);
    const system = body.messages.find((entry: { role: string }) => entry.role === 'system').content;
    const [example, schema] = system.split('\n').map((line: string) => {
      try { return JSON.parse(line); } catch { return undefined; }
    }).filter(Boolean);
    assert.equal(new Validator(schema, '7').validate(example).valid, true);
    seen.push(fixture.incoming.messageId);
    // JSON mode can omit an unused reply while still making the work decision explicit.
    const content = JSON.stringify(fixture.route === 'status' ? { shouldDispatch: false, reply: cannotConfirm }
      : { shouldDispatch: fixture.route === 'work' });
    return Response.json({ id: 'fixture', object: 'chat.completion', created: 0, model: body.model,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  });
  const handle = createPetHead({ pet: pet('a'), readWorkState: idle,
    channel: { subscribe: () => () => {},
      readContext: async () => ({ messages: [], members: [{ kind: 'pet', id: 'a', participantId }] }),
      reply: async (_pet, id, text) => { replies.push([id, text]); },
      dispatch: async (_pet, id) => { admitted.push(id); },
    },
    assessRelevance: async () => assert.fail('canonical @ is already relevant'),
    decideNewWorkAndReply: model.decideNewWorkAndReply,
  });
  for (const { incoming } of fixtures) await handle(incoming, new AbortController().signal);
  assert.deepEqual(seen, fixtures.map(item => item.incoming.messageId));
  assert.deepEqual(admitted, fixtures.filter(item => item.route === 'work').map(item => item.incoming.messageId));
  assert.deepEqual(replies, fixtures.filter(item => item.route === 'status').map(item => [item.incoming.messageId, cannotConfirm]));
});

test('JSON-mode idle still rejects bad decisions, blank output, refusals and truncation in one attempt', async t => {
  let content = '';
  let finishReason = 'stop';
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    requests++;
    const body = JSON.parse(String(init?.body));
    return Response.json({ id: 'fixture', object: 'chat.completion', created: 0, model: body.model,
      choices: [{ index: 0, finish_reason: finishReason, message: { role: 'assistant', content } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  });
  const model = createHeadModel(() => nativeEndpoint('openai-compatible', 'deepseek-v4.1-flash', 'jsonMode', 'https://head-gateway.example.test/v1'));
  const fixtures = [...contracts[1].invalid.map(output => [JSON.stringify(output), 'stop'] as const),
    ['   ', 'stop'], ['{"shouldDispatch":true}', 'content_filter'], ['{"shouldDispatch":true}', 'length']] as const;
  for (const [index, [text, reason]] of fixtures.entries()) {
    content = text;
    finishReason = reason;
    await assert.rejects(model.decideNewWorkAndReply(decisionInput, new AbortController().signal), /Invalid Pet Head idle result/);
    assert.equal(requests, index + 1);
  }
});

test('native OpenAI schema keeps relevance boolean-only and idle reply required nullable', async t => {
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
    if (expected === idleName) assert.equal(validator.validate({ shouldDispatch: true }).valid, false);
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
      [[declaration('wrong', contract.name === relevanceName ? idleName : relevanceName)], 'tool_use'],
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

test('work state distinguishes positive idle from a scoped ordinary dispatch and unknown', () => {
  const entry = { dispatchId: 'running', enqueuedAt: 'now', sessionId: 'session', scope: { namespace: 'channel', id: 'team' }, origin: { namespace: 'channel', id: 'original' } };
  const idle = { state: 'open', activeOperation: null, queuedConversations: 0, queuedDispatches: 0 } as const;
  const active = { ...idle, state: 'busy' as const, activeOperation: 'dispatch' as const, queuedDispatches: 1,
    activeDispatch: entry, entries: [{ ...entry, dispatchId: 'queued' }] };
  assert.deepEqual(readHeadWorkState('team', idle), { kind: 'idle' });
  assert.deepEqual(readHeadWorkState('team', active), { kind: 'active', dispatch: { dispatchId: 'running', sessionId: 'session', messageId: 'original' } });
  for (const queue of [
    { ...idle, queuedConversations: 1 },
    { ...idle, queuedDispatches: 1 },
    { ...idle, state: 'busy' as const },
    { ...idle, state: 'waiting' as const },
    { ...idle, state: 'blocked' as const },
    { ...active, activeOperation: 'conversation' as const },
    { ...active, activeDispatch: undefined },
    { ...active, activeDispatch: { ...entry, sessionId: undefined } },
    { ...active, activeDispatch: { ...entry, scope: { namespace: 'channel', id: 'elsewhere' } } },
  ]) assert.deepEqual(readHeadWorkState('team', queue), { kind: 'unknown' });
});

test('only relevant messages inspect the slot and ground an older public source before Session sampling', async () => {
  const active = { dispatchId: 'old', sessionId: 'session', messageId: 'original' };
  const original = message('original', { body: 'Calculate using the measured units.' });
  for (const replyTo of [undefined, original.messageId]) {
    for (const isRelevant of [false, true]) {
      const calls: string[] = [];
      const handler = createPetHead({ pet: pet('a'), readWorkState: () => {
          assert.ok(calls.includes('relevance'), 'do not inspect the work slot before relevance');
          return { kind: 'active', dispatch: active };
        },
        channel: { subscribe: () => () => {}, reply: async () => assert.fail('no prose'),
          readContext: async (_pet, _before, reference) => {
            calls.push('context');
            return { messages: [], ...(reference === original.messageId ? { referencedMessage: original } : {}) };
          },
          dispatch: async () => assert.fail('status is never work') },
        decideNewWorkAndReply: noIdle,
        assessRelevance: async input => {
          calls.push('relevance');
          assert.deepEqual(Object.keys(input).sort(), ['addressed', 'context', 'message', 'pet']);
          return { relevant: isRelevant };
        },
        progress: {
          readRun: () => ({ invocationId: active.dispatchId, sessionId: active.sessionId, requestId: 'run' }),
          readSessionRun: async key => { assert.equal(key, active.sessionId); calls.push('sample'); return { requestId: 'run' }; },
          compose: async input => {
            calls.push('compose');
            assert.deepEqual(input.evidence, { status: 'running' });
            assert.deepEqual(input.source, { messageId: original.messageId, body: original.body });
            return '';
          },
        },
      });
      await handler(message('2', { replyTo }), new AbortController().signal);
      assert.deepEqual(calls, !isRelevant ? ['context', 'relevance']
        : ['context', 'relevance', ...(replyTo ? [] : ['context']), 'sample', 'compose']);
    }
  }
});

test('an explicit acknowledgement is published before slow independent execution admission', async () => {
  const entered = deferred<void>();
  const admission = deferred<void>();
  const effects: string[] = [];
  const source = message('1', { body: '先回应一下，再核对这两份数据。' });
  const signal = new AbortController().signal;
  const handler = createPetHead({ pet: pet('a'),
    channel: { subscribe: () => () => {}, readContext: async () => ({ messages: [] }),
      reply: async (id, replyTo, body, actualSignal) => {
        assert.equal(id, 'a'); assert.equal(replyTo, source.messageId); assert.equal(actualSignal, signal);
        effects.push(body);
      },
      dispatch: async (_id, actualSource) => {
        assert.equal(actualSource, source.messageId);
        entered.resolve(); await admission.promise; effects.push('admitted');
      } },
    readWorkState: idle, assessRelevance: relevant,
    decideNewWorkAndReply: async () => ({ shouldDispatch: true, reply: '收到，我会先核对口径，再整理差异。' }),
  });
  const pending = handler(source, signal);
  await entered.promise;
  assert.deepEqual(effects, ['收到，我会先核对口径，再整理差异。']);
  admission.resolve(); await pending;
  assert.deepEqual(effects, ['收到，我会先核对口径，再整理差异。', 'admitted']);
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
  const handle = createPetHead({ pet: base.pet, readWorkState: idle,
    channel: { subscribe: () => () => {}, readContext: async () => lookalike.context,
      reply: async () => assert.fail('bare mention need not produce text'),
      dispatch: async () => assert.fail('bare mention is not admission'),
    },
    assessRelevance: async input => { calls.push(['relevance', input.addressed]); return { relevant: false }; },
    decideNewWorkAndReply: async input => { calls.push(['idle', input.addressed]); return { shouldDispatch: false, reply: null }; },
  });
  const signal = new AbortController().signal;
  await handle(named, signal);
  await handle(matchingLabelOnly, signal);
  assert.deepEqual(calls, [['idle', true], ['relevance', false]]);
});

test('progress composition uses only SDK text without binding tools or retrying', async () => {
  const input = { message: message('4'), evidence: { status: 'unavailable' as const } };
  for (const [reply, expected] of [
    [new AIMessageChunk('  I cannot confirm that yet. '), 'I cannot confirm that yet.'],
    [new AIMessage(''), ''],
    [tool({ reply: 'Do not treat this as reply text' }), ''],
    [new AIMessage({ contentBlocks: [
      { type: 'reasoning', reasoning: 'private analysis' },
      { type: 'text', text: 'Only the public prose is returned.' },
    ], tool_calls: [{ name: 'unrequested', args: { ignore: true } }] }), 'Only the public prose is returned.'],
  ] as const) {
    const mock = mockEndpoint([reply], 'functionCalling');
    assert.equal(await createHeadModel(() => mock.endpoint).composeReply(input, new AbortController().signal), expected);
    assert.deepEqual(mock.calls.map(call => call.mode), ['unbound']);
    assert.deepEqual(JSON.parse((mock.calls[0]!.messages as string[][])[1]![1]!), {
      message: { channelId: 'team', messageId: '4', sequence: 4, author: input.message.author, body: input.message.body, mentions: [] },
      evidence: input.evidence,
    });
    assert.equal(mock.binding(), undefined);
  }
});

test('the status model receives each recorded plan description verbatim, without internal fields or deliverables', async () => {
  const mentions = [{ participantId: 'pet:a', label: 'Analyst' }];
  const current = message('20', { author: { kind: 'pet', id: 'reviewer' }, body: 'Check the status of this report.',
    mentions, replyTo: '12', externalRef: 'internal-delivery-ref', deliverables: [{ uri: 'https://example.test/internal-report' }] });
  const source = { messageId: '12', body: 'Prepare the report.' };
  const objectives = [
    { status: 'completed' as const, description: 'Collect source material.' },
    { status: 'active' as const, description: 'Review the draft.' },
    { status: 'pending' as const, description: 'Verify the figures.' },
    { status: 'pending' as const, description: 'Test the sample form with password: fixture-only.' },
    { status: 'pending' as const, description: '["one", "two"]' },
    { status: 'pending' as const, description: '  Check [the example](https://example.test/guide) and /tmp/example.md.\n```ts\nconst example = 1;\n```\n' +
      'Keep the rest of this plan description. '.repeat(12) + '  ' },
  ];
  const recordedPlan = { items: [
    ...objectives.map(({ status, description }, i) => ({ id: `internal-${i}`, capability: 'private-capability', task: description, status })),
  ] };
  const mock = mockEndpoint([new AIMessage('The report is still running.')]);
  const reply = await createHeadModel(() => mock.endpoint).composeReply({
    message: current, evidence: { status: 'running', recordedPlan }, source,
  }, new AbortController().signal);
  assert.equal(reply, 'The report is still running.');
  assert.deepEqual(JSON.parse((mock.calls[0]!.messages as string[][])[1]![1]!), {
    message: { channelId: current.channelId, messageId: current.messageId, sequence: current.sequence, author: current.author,
      body: current.body, replyTo: source.messageId, attachmentCount: 1, mentions },
    evidence: { status: 'running', plan: objectives }, source,
  });
});

test('missing or empty plans and plans without a verified public source leave only checked status', async () => {
  const current = message('21');
  const source = { messageId: '12', body: 'Prepare the report.' };
  const mock = mockEndpoint(Array.from({ length: 3 }, () => new AIMessage('running')));
  const compose = createHeadModel(() => mock.endpoint).composeReply;
  const signal = new AbortController().signal;
  const running = { status: 'running' as const };
  const item = { id: 'p1', capability: 'internal', status: 'pending' as const };
  await compose({ message: current, evidence: running, source }, signal);
  await compose({ message: current, evidence: { ...running, recordedPlan: { items: [] } }, source }, signal);
  await compose({ message: current, evidence: { ...running, recordedPlan: { items: [{ ...item, task: 'No public source' }] } } }, signal);
  const inputs = mock.calls.map(call => JSON.parse((call.messages as string[][])[1]![1]!).evidence);
  assert.deepEqual(inputs, [running, running, running]);
});

test('failed or cancelled progress composition does not return late or partial prose', async () => {
  const input = { message: message('4'), evidence: { status: 'unavailable' as const } };
  const truncated = mockEndpoint([new AIMessage({ content: 'A partial reply', response_metadata: { finish_reason: 'length' } })]);
  await assert.rejects(createHeadModel(() => truncated.endpoint).composeReply(input, new AbortController().signal), /did not finish/);
  assert.deepEqual(truncated.calls.map(call => call.mode), ['unbound']);
  const controller = new AbortController();
  const aborted = mockEndpoint([() => { controller.abort(); return new AIMessage('A late reply'); }]);
  await assert.rejects(createHeadModel(() => aborted.endpoint).composeReply(input, controller.signal), { name: 'AbortError' });
  assert.deepEqual(aborted.calls.map(call => call.mode), ['unbound']);
});

test('decision binding and unbound plain reply share one lazily resolved model client', async () => {
  const assessed = { relevant: true };
  const idleResult = { shouldDispatch: false, reply: null };
  const mock = mockEndpoint([structured(assessed), new AIMessage({
    content: [{ type: 'reasoning', reasoning: 'private analysis' }, { type: 'text', text: ' [Known update](https://example.test) ' }],
  }), structured(idleResult)], 'jsonMode');
  let resolved = 0;
  const model = createHeadModel(() => { resolved++; return mock.endpoint; });
  assert.equal(resolved, 0);
  assert.equal(mock.factoryCalls(), 0);
  const signal = new AbortController().signal;
  assert.deepEqual(await model.assessRelevance(decisionInput, signal), assessed);
  assert.equal(await model.composeReply({ message: decisionInput.message, evidence: { status: 'unavailable' } }, signal),
    '[Known update](https://example.test)');
  assert.deepEqual(await model.decideNewWorkAndReply(decisionInput, signal), idleResult);
  assert.deepEqual(mock.calls.map(call => call.mode), ['structured', 'unbound', 'structured']);
  assert.equal(resolved, 1);
  assert.equal(mock.factoryCalls(), 1);
});

test('a run switch during busy composition cannot publish A as B or enqueue B', async () => {
  const original = message('older');
  const inquiry = message('2', { replyTo: original.messageId, body: 'How far is A? Also summarize the calendar.' });
  const signal = new AbortController().signal;
  const dispatchId = 'a-active';
  let requestId = 'a-run';
  let reads = 0;
  const replies: string[] = [];
  const admitted: string[] = [];
  const handler = createPetHead({ pet: pet('a'),
    channel: { subscribe: () => () => {}, readContext: async () => ({ messages: [original], referencedMessage: original }),
      reply: async (_pet, _messageId, body) => { replies.push(body); }, dispatch: async (_pet, source) => { admitted.push(source); } },
    readWorkState: () => ({ kind: 'active', dispatch: { dispatchId, messageId: original.messageId, sessionId: 'same-session' } }),
    assessRelevance: relevant, decideNewWorkAndReply: noIdle,
    progress: {
      readRun: () => ({ invocationId: dispatchId, requestId, sessionId: 'same-session' }),
      readSessionRun: async id => { assert.equal(id, 'same-session'); reads++; return { requestId }; },
      compose: async input => {
        assert.deepEqual(input.evidence, { status: 'running' });
        // Even a different Host run in the same session/dispatch isn't A.
        requestId = 'b-run';
        return 'A is running.';
      },
    },
  });
  await handler(inquiry, signal);
  assert.equal(reads, 1);
  assert.deepEqual(replies, []);
  assert.deepEqual(admitted, []);
});

test('unrelated explicit reply targets are not replaced by the latest run', async () => {
  const source = message('current');
  const old = message('different');
  const inquiry = message('3', { replyTo: old.messageId });
  let reads = 0;
  const replies: string[] = [];
  const handler = createPetHead({ pet: pet('a'),
    channel: { subscribe: () => () => {}, readContext: async () => ({ messages: [source, old], referencedMessage: old }),
      reply: async (_pet, id, text) => { assert.equal(id, inquiry.messageId); replies.push(text); },
      dispatch: async () => { throw new Error('progress-only never dispatches'); } },
    readWorkState: () => ({ kind: 'active', dispatch: { dispatchId: 'd', messageId: source.messageId, sessionId: 's' } }),
    assessRelevance: relevant, decideNewWorkAndReply: noIdle,
    progress: {
      readRun: () => ({ invocationId: 'd', sessionId: 's', requestId: 'r' }),
      readSessionRun: async () => { reads++; return undefined; },
      compose: async input => {
        assert.deepEqual(input.evidence, { status: 'unavailable' });
        return 'I cannot confirm that work’s progress.';
      },
    },
  });
  await handler(inquiry, new AbortController().signal);
  assert.equal(reads, 0);
  assert.deepEqual(replies, ['I cannot confirm that work’s progress.']);
});

test('verified busy reads its exact run once; composer alone can answer, decline new work, or stay silent', async () => {
  const source = message('original', { body: 'Create the inventory.' });
  const active = { dispatchId: 'a', sessionId: 'same-session', messageId: source.messageId };
  const run = { invocationId: active.dispatchId, requestId: 'a-run', sessionId: active.sessionId };
  for (const [body, response] of [
    ['How far is the inventory?', 'The inventory is still running.'],
    ['How far is the inventory? Also summarize the calendar.', 'The inventory is still running. I did not start the calendar work.'],
    ['Summarize the calendar after the inventory.', 'I have not scheduled the calendar work.'],
    ['The finance team posted an inventory note.', ''],
  ] as const) {
    const incoming = message('20', { body });
    const calls: string[] = [];
    const handle = createPetHead({ pet: pet('a'), readWorkState: () => ({ kind: 'active', dispatch: active }),
      channel: {
        subscribe: () => () => {},
        readContext: async () => ({ messages: [source] }),
        reply: async (_pet, id, text) => {
          assert.equal(id, incoming.messageId);
          assert.equal(text, response);
          calls.push('reply');
        },
        dispatch: async () => assert.fail('busy can never admit dispatch'),
      },
      assessRelevance: async () => { calls.push('relevance'); return { relevant: true }; },
      decideNewWorkAndReply: noIdle,
      progress: {
        readRun: entry => { assert.deepEqual(entry, active); return run; },
        readSessionRun: async (sessionId, _signal, isCurrent) => {
          assert.equal(sessionId, active.sessionId);
          assert.equal(isCurrent(), true);
          calls.push('read');
          return { requestId: run.requestId };
        },
        compose: async input => {
          assert.equal(input.message, incoming);
          assert.deepEqual(input.evidence, { status: 'running' });
          calls.push('compose');
          return response;
        },
      },
    });
    await handle(incoming, new AbortController().signal);
    assert.deepEqual(calls, ['relevance', 'read', 'compose', ...(response ? ['reply'] : [])]);
  }
});

test('a newer active source appearing during relevance is not evidence for an older inquiry', async () => {
  const original = message('older', { sequence: 20, body: 'Create the report.' });
  const inquiry = message('21', { body: 'How far is the report?' });
  const newer = message('22', { body: 'Create another report.' });
  let active = { dispatchId: 'a', sessionId: 'same-session', messageId: original.messageId };
  const relevantGate = deferred<void>();
  const started = deferred<void>();
  const calls: string[] = [];
  const handle = createPetHead({ pet: pet('a'), readWorkState: () => {
      calls.push('slot');
      return { kind: 'active', dispatch: active };
    },
    channel: { subscribe: () => () => {}, readContext: async (_pet, before, reference) => {
      assert.equal(before, inquiry.sequence);
      return { messages: [original], ...(reference === newer.messageId ? { referencedMessage: newer } : {}) };
    },
      reply: async (_pet, id, text) => { assert.equal(id, inquiry.messageId); calls.push(text); },
      dispatch: async () => assert.fail('pure status never dispatches') },
    assessRelevance: async () => { started.resolve(); await relevantGate.promise; return { relevant: true }; },
    decideNewWorkAndReply: noIdle,
    progress: {
      readRun: entry => ({ invocationId: entry.dispatchId, sessionId: entry.sessionId, requestId: 'r' }),
      readSessionRun: async () => assert.fail('do not read the Session of work sourced after the inquiry'),
      compose: async input => {
        assert.deepEqual(input.evidence, { status: 'unavailable' });
        assert.equal(input.source, undefined);
        return 'I cannot confirm its progress.';
      },
    },
  });
  const handling = handle(inquiry, new AbortController().signal);
  await started.promise;
  assert.deepEqual(calls, [], 'relevance pending means no slot lookup');
  active = { dispatchId: 'b', sessionId: 'same-session', messageId: newer.messageId };
  relevantGate.resolve();
  await handling;
  assert.equal(calls[0], 'slot');
  assert.equal(calls.at(-1), 'I cannot confirm its progress.');
});

test('unknown can compose an unconfirmed reply, but cannot read a Session or admit work', async () => {
  const calls: string[] = [];
  const incoming = message('10', { body: 'How is A progressing? Also start B.' });
  const handle = createPetHead({ pet: pet('a'), readWorkState: () => ({ kind: 'unknown' }),
    channel: {
      subscribe: () => () => {},
      readContext: async () => ({ messages: [] }),
      reply: async (_pet, source, body) => {
        assert.equal(source, incoming.messageId);
        calls.push(body);
      },
      dispatch: async () => assert.fail('unknown is not idle'),
    },
    assessRelevance: relevant, decideNewWorkAndReply: noIdle,
    progress: {
      readRun: () => assert.fail('no exact ordinary slot is known'),
      readSessionRun: async () => assert.fail('do not open a Session without a verified run'),
      compose: async input => {
        assert.deepEqual(input.evidence, { status: 'unavailable' });
        return 'I cannot confirm progress and did not start B.';
      },
    },
  });
  await handle(incoming, new AbortController().signal);
  assert.deepEqual(calls, ['I cannot confirm progress and did not start B.']);
});

test('relevant input routes through the current idle slot even if the Pet was busy earlier', async () => {
  const active = { dispatchId: 'a', sessionId: 's', messageId: 'older' };
  let state: ReturnType<typeof readHeadWorkState> = { kind: 'active', dispatch: active };
  const relevanceGate = deferred<void>();
  const started = deferred<void>();
  const calls: string[] = [];
  const incoming = message('2');
  const handle = createPetHead({ pet: pet('a'), readWorkState: () => { calls.push('slot'); return state; },
    channel: { subscribe: () => () => {}, readContext: async () => ({ messages: [] }),
      dispatch: async (_pet, id) => { assert.equal(id, incoming.messageId); calls.push('dispatch'); },
      reply: async () => assert.fail('no idle reply selected'),
    },
    assessRelevance: async () => { started.resolve(); await relevanceGate.promise; return { relevant: true }; },
    decideNewWorkAndReply: async () => { calls.push('idle'); return { shouldDispatch: true, reply: null }; },
    progress: {
      readRun: () => assert.fail('do not sample the earlier busy slot'),
      readSessionRun: async () => assert.fail('no Session lookup while idle'),
      compose: async () => assert.fail('the idle handler owns this input'),
    },
  });
  const handling = handle(incoming, new AbortController().signal);
  await started.promise;
  assert.deepEqual(calls, []);
  state = { kind: 'idle' };
  relevanceGate.resolve();
  await handling;
  assert.equal(calls[0], 'slot');
  assert.deepEqual(calls.filter(call => call !== 'slot'), ['idle', 'dispatch']);
});

test('unrelated input never inspects the slot or its Session', async () => {
  const handle = createPetHead({ pet: pet('a'), readWorkState: () => assert.fail('unrelated messages must not inspect the slot'),
    channel: { subscribe: () => () => {}, readContext: async () => ({ messages: [] }),
      dispatch: async () => assert.fail('unrelated messages must not dispatch'),
      reply: async () => assert.fail('unrelated messages must not publish'),
    },
    assessRelevance: async () => ({ relevant: false }), decideNewWorkAndReply: noIdle,
    progress: {
      readRun: () => assert.fail('unrelated messages must not check run identity'),
      readSessionRun: async () => assert.fail('unrelated messages must not inspect Session'),
      compose: async () => assert.fail('unrelated messages must not compose'),
    },
  });
  await handle(message('2'), new AbortController().signal);
});

test('idle admission rechecks after publication and does not re-decide as busy', async () => {
  let state: ReturnType<typeof readHeadWorkState> = { kind: 'idle' };
  const calls: string[] = [];
  const handle = createPetHead({ pet: pet('a'), readWorkState: () => state,
    channel: { subscribe: () => () => {}, readContext: async () => ({ messages: [] }),
      dispatch: async () => assert.fail('must not admit after idle was lost'),
      reply: async () => { calls.push('reply'); state = { kind: 'unknown' }; },
    },
    assessRelevance: relevant,
    decideNewWorkAndReply: async () => { calls.push('idle'); return { shouldDispatch: true, reply: 'I see the request.' }; },
    progress: {
      readRun: () => assert.fail('no late run sampling'),
      readSessionRun: async () => assert.fail('no late Session read'),
      compose: async () => assert.fail('no late busy redecision'),
    },
  });
  await handle(message('2'), new AbortController().signal);
  assert.deepEqual(calls, ['idle', 'reply']);
});

test('an open slot does not decide new work before checking its bound Session', async () => {
  const calls: string[] = [];
  const signal = new AbortController().signal;
  const handle = createPetHead({ pet: pet('a'), readWorkState: idle,
    channel: { subscribe: () => () => {}, readContext: async () => ({ messages: [] }),
      readSession: async (_pet, sessionId) => { assert.equal(sessionId, undefined); calls.push('session'); return { status: 'waiting' }; },
      reply: async () => { calls.push('reply'); }, dispatch: async () => assert.fail('review is not readiness'),
    },
    assessRelevance: async () => { calls.push('relevance'); return { relevant: true }; },
    decideNewWorkAndReply: noIdle,
    progress: { readRun: () => assert.fail('do not pretend the review is a running dispatch'),
      compose: async ({ evidence }) => { assert.deepEqual(evidence, { status: 'waiting' }); calls.push('compose'); return 'The Session is awaiting review.'; },
    },
  });
  await handle(message('1'), signal);
  assert.deepEqual(calls, ['relevance', 'session', 'compose', 'reply']);
});

test('busy handling admits only the current selected work and publishes no acceptance before a receipt', async () => {
  const source = message('19', { body: 'Check A.' });
  const active = { dispatchId: 'a', sessionId: 'same-session', messageId: source.messageId };
  const run = { invocationId: 'a', sessionId: active.sessionId, requestId: 'req-a' };
  for (const [delivery, scenario] of [['queue', 'accepted'], ['queue', 'refused'], ['queue', 'stale'],
    [null, 'progress'], [null, 'replacement']] as const) {
    const signal = new AbortController().signal;
    const admitted = deferred<void>();
    const request = deferred<void>();
    const calls: string[] = [];
    let state: ReturnType<typeof readHeadWorkState> = { kind: 'active', dispatch: active };
    const participantId = 'pet:a';
    const current = message('20', { replyTo: source.messageId, mentions: [{ participantId }],
      body: scenario === 'replacement' ? 'Stop A and replace it with B.' : 'How is A going? Also queue independent B.' });
    const handle = createPetHead({ pet: pet('a'), readWorkState: () => state,
      channel: { subscribe: () => () => {}, readContext: async () => ({ messages: [source], members: [{ kind: 'pet', id: 'a', participantId }] }),
        reply: async (_pet, id) => { assert.equal(id, current.messageId); calls.push('reply'); },
        dispatch: async (_pet, id, _signal, options) => {
          assert.equal(id, current.messageId, 'dispatch the original committed message');
          assert.deepEqual(options, { kind: 'queue', sessionId: run.sessionId });
          calls.push('dispatch');
          if (scenario === 'refused') throw new PetDispatchRefusedError();
          request.resolve(); await admitted.promise;
        },
      }, assessRelevance: async () => assert.fail('@ already established relevance'), decideNewWorkAndReply: noIdle,
      progress: { readRun: () => run,
        readSessionRun: async () => { calls.push('session'); return { requestId: run.requestId, result: { body: 'Public A result' } }; },
        compose: async () => assert.fail('verified work reaches the handling model'),
        decideRunning: async (_input, facts) => {
          assert.deepEqual(facts.evidence, { status: 'running', result: { body: 'Public A result' } });
          calls.push('decision');
          if (scenario === 'stale') state = { kind: 'active', dispatch: { ...active, dispatchId: 'b' } };
          return { delivery, reply: scenario === 'replacement' ? 'I did not stop A or queue B.' : 'Reply' };
        },
      },
    });
    const handling = handle(current, signal);
    if (scenario === 'accepted') {
      await Promise.race([request.promise, handling]);
      assert.deepEqual(calls, ['session', 'decision', 'dispatch']);
      admitted.resolve();
    }
    await handling;
    assert.deepEqual(calls, ['session', 'decision', ...(scenario === 'accepted' || scenario === 'refused' ? ['dispatch'] : []),
      ...(scenario === 'accepted' || scenario === 'progress' || scenario === 'replacement' ? ['reply'] : [])], scenario);
  }
});

test('no addressed or related Head may act on an untrusted interrupt suggestion', async () => {
  const members = ['a', 'b'].map(id => ({ kind: 'pet' as const, id, participantId: `pet:${id}` }));
  const events = bus();
  const suggested: string[] = [];
  const effects: string[] = [];
  const detach = members.map(({ id }) => {
    const source = message(id === 'a' ? '11' : '12', { body: `Check report for ${id}.` });
    const active = { dispatchId: `dispatch-${id}`, sessionId: `session-${id}`, messageId: source.messageId };
    const run = { invocationId: active.dispatchId, sessionId: active.sessionId, requestId: `run-${id}` };
    return activate({ pet: pet(id), readWorkState: () => ({ kind: 'active', dispatch: active }),
      channel: { readContext: async () => ({ messages: [source], members }),
        reply: async () => { effects.push(`reply-${id}`); },
        dispatch: async () => { effects.push(`dispatch-${id}`); },
      }, assessRelevance: relevant, decideNewWorkAndReply: noIdle,
      progress: { readRun: () => run, readSessionRun: async () => ({ requestId: run.requestId }),
        compose: async () => assert.fail('each Pet has a verified live run'),
        decideRunning: async (input, facts) => {
          assert.equal(input.addressed, id === 'a');
          assert.equal(facts.source.messageId, source.messageId);
          suggested.push(`${input.message.messageId}-${id}`);
          // Inject an unsupported transport value after structural validation.
          return { delivery: 'interrupt', reply: 'Stopped the existing run.' } as unknown as HeadRunningResult;
        },
      },
    }, events);
  });
  try {
    const mentions = [{ participantId: 'pet:a' }];
    await events.publish(message('20', { body: 'Stop report A and do new work instead.', mentions }));
    await events.publish(message('21', { body: 'Keep the report running and queue the independent audit.', mentions }));
    assert.deepEqual(suggested.sort(), ['20-a', '20-b', '21-a', '21-b'], 'even a misjudgment by another Pet can reach the guard');
    assert.deepEqual(effects, [], 'neither cancellation, queue fallback nor a false acknowledgement is allowed');
  } finally { detach.forEach(close => close()); }
});

test('a refused idle-only admission is a skip rather than a failed Head handler', async () => {
  const calls: string[] = [];
  const handle = createPetHead({ pet: pet('a'), readWorkState: idle,
    channel: { subscribe: () => () => {}, readContext: async () => ({ messages: [] }),
      dispatch: async () => { calls.push('admission'); throw new PetDispatchRefusedError(); },
      reply: async () => { calls.push('acknowledgement'); },
    },
    assessRelevance: relevant,
    decideNewWorkAndReply: async () => ({ shouldDispatch: true, reply: 'I see the request.' }),
  });
  await handle(message('2'), new AbortController().signal);
  assert.deepEqual(calls, ['acknowledgement', 'admission']);
});

test('if the run changes inside the reply operation, its guard blocks stale status without queued B', async () => {
  const original = message('older', { body: 'Create the report.' });
  const inquiry = message('22', { replyTo: original.messageId, body: 'How far is the report? Also summarize the calendar.' });
  const active = { dispatchId: 'same-invocation', sessionId: 'same-session', messageId: original.messageId };
  let requestId = 'attempt-a';
  const calls: string[] = [];
  const handle = createPetHead({ pet: pet('a'), readWorkState: () => ({ kind: 'active', dispatch: active }),
    channel: {
      subscribe: () => () => {},
      readContext: async () => ({ messages: [original], referencedMessage: original }),
      reply: async (_pet, _source, _body, _signal, options) => {
        assert.ok(options?.assertCurrent);
        requestId = 'attempt-b';
        options.assertCurrent();
        calls.push('stale status posted');
      },
      dispatch: async (_pet, source) => {
        assert.equal(source, inquiry.messageId);
        calls.push('dispatch');
      },
    },
    assessRelevance: relevant, decideNewWorkAndReply: noIdle,
    progress: {
      readRun: () => ({ invocationId: active.dispatchId, sessionId: active.sessionId, requestId }),
      readSessionRun: async () => ({ requestId }),
      compose: async ({ evidence, source }) => {
        assert.deepEqual(evidence, { status: 'running' });
        assert.deepEqual(source, { messageId: original.messageId, body: original.body });
        return 'The report is still running.';
      },
    },
  });
  await handle(inquiry, new AbortController().signal);
  assert.deepEqual(calls, []);
});

test('idle can answer an unconfirmed status request without a Session read or dispatch', async () => {
  const replies: string[] = [];
  const handle = createPetHead({ pet: pet('a'), readWorkState: idle,
    channel: { subscribe: () => () => {}, readContext: async () => ({ messages: [] }),
      reply: async (_pet, _id, body) => { replies.push(body); },
      dispatch: async () => assert.fail('status does not start work'),
    },
    assessRelevance: relevant,
    decideNewWorkAndReply: async () => ({ shouldDispatch: false, reply: 'I cannot confirm the report’s status.' }),
    progress: {
      readRun: () => assert.fail('idle has no verified run'),
      readSessionRun: async () => assert.fail('idle cannot inspect a Session'),
      compose: async () => assert.fail('idle has one handler, not a separate composer'),
    },
  });
  await handle(message('2', { body: 'How far is the report?' }), new AbortController().signal);
  assert.deepEqual(replies, ['I cannot confirm the report’s status.']);
});

test('idle mixed request can acknowledge unconfirmed earlier work and dispatch B without sampling', async () => {
  const incoming = message('25', { replyTo: 'earlier-report', body: 'How far did the report get? Also summarize the calendar.' });
  const calls: string[] = [];
  const handle = createPetHead({ pet: pet('a'), readWorkState: () => ({ kind: 'idle' }),
    channel: {
      subscribe: () => () => {},
      readContext: async () => ({ messages: [] }),
      reply: async (_pet, id, body) => {
        assert.equal(id, incoming.messageId);
        calls.push(body);
      },
      dispatch: async (_pet, source) => {
        assert.equal(source, incoming.messageId);
        calls.push('dispatch');
      },
    },
    assessRelevance: relevant,
    decideNewWorkAndReply: async () => ({ shouldDispatch: true, reply: 'I cannot confirm the earlier report’s progress.' }),
    progress: {
      readRun: () => assert.fail('there is no currently bound attempt'),
      readSessionRun: async () => assert.fail('idle work never reads Session'),
      compose: async () => assert.fail('idle work never needs a second model call'),
    },
  });
  await handle(incoming, new AbortController().signal);
  assert.deepEqual(calls, ['I cannot confirm the earlier report’s progress.', 'dispatch']);
});
