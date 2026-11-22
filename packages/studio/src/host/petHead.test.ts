import assert from 'node:assert/strict';
import { AIMessage, AIMessageChunk } from '@langchain/core/messages';
import { toJsonSchema, Validator } from '@langchain/core/utils/json_schema';
import { buildModel } from 'pinpawo/host-runtime';
import test from 'node:test';
import { bindPetHeadChannel, createPetHead, isHeadAddressed, readHeadWorkState, type HeadMessage, type PetHeadChannel } from './petHead';
import { createHeadModel } from './petHeadModel';
import { headDecisionMessages } from './petHeadPrompts';
import type { StudioModelEndpoint } from '../studioContract';
import type { StudioPetRegistration } from '../types';
import type { StudioEvent, StudioEventHandler, StudioEventSubscriptionFilter } from '../studioContract';

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
    decide: async input => { seen.push({ petId: input.pet.petId, message: input.message }); return { action: 'direct' }; },
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
    decide: async input => { seen.push(input.message); return { action: 'direct' }; },
  }, events);
  await events.publish(message('1', { author: { kind: 'pet', id: 'a' } }));
  await events.publish(message('2', { channelId: 'other' }));
  assert.deepEqual(seen, []);
  unsubscribe();
});

test('independent publication and execution axes support all four combinations with exact attribution', async () => {
  for (const action of ['direct', 'dispatch'] as const) for (const reply of ['', 'Acknowledged']) {
    const calls: unknown[][] = [];
    const source = message('1', { author: { kind: 'pet', id: 'peer' }, replyTo: 'older' });
    const signal = new AbortController().signal;
    const handler = createPetHead({ pet: pet('a'),
      channel: { subscribe: () => () => {}, readContext: async () => ({ messages: [] }),
        reply: async (...args) => { calls.push(['reply', ...args]); }, dispatch: async (...args) => { calls.push(['dispatch', ...args]); } },
      decide: async () => ({ action, reply }),
    });
    await handler(source, signal);
    assert.equal(calls.filter(call => call[0] === 'reply').length, reply ? 1 : 0);
    assert.equal(calls.filter(call => call[0] === 'dispatch').length, action === 'dispatch' ? 1 : 0);
    if (reply) assert.deepEqual(calls[0], ['reply', 'a', '1', reply, signal, { preventPetMentions: true }]);
    if (action === 'dispatch') assert.deepEqual(calls.at(-1), ['dispatch', 'a', source.messageId, signal]);
  }
});

test('publication and admission failures are independent and do not leak provider errors', async () => {
  for (const fail of ['reply', 'dispatch', 'both']) {
    const calls: string[] = [];
    const handler = createPetHead({ pet: pet('a'),
      channel: { subscribe: () => () => {}, readContext: async () => ({ messages: [] }),
        reply: async () => { calls.push('reply'); if (fail !== 'dispatch') throw new Error('private reply detail'); },
        dispatch: async () => { calls.push('dispatch'); if (fail !== 'reply') throw new Error('private dispatch detail'); } },
      decide: async () => ({ action: 'dispatch', reply: 'I can look into this.' }),
    });
    await assert.rejects(handler(message('1'), new AbortController().signal), error => {
      assert.equal((error as Error).message, 'Pet Head action failed: ' + (fail === 'both' ? 'reply, dispatch' : fail) + '.'); return true;
    });
    assert.deepEqual(calls, ['reply', 'dispatch']);
  }
});

test('deactivation cancels an in-flight decision and never publishes or dispatches late', async () => {
  const controller = new AbortController();
  const started = deferred<void>();
  const pending = deferred<import('./petHead').HeadDecision>();
  const effects: string[] = [];
  const handler = createPetHead({ pet: pet('a'),
    channel: { subscribe: () => () => {}, readContext: async () => ({ messages: [] }),
      reply: async () => { effects.push('reply'); }, dispatch: async () => { effects.push('dispatch'); } },
    decide: async () => { started.resolve(); return pending.promise; },
  });
  const run = handler(message('1'), controller.signal);
  await started.promise; controller.abort();
  pending.resolve({ action: 'dispatch', reply: 'late' });
  await run;
  assert.deepEqual(effects, []);
});

test('cancellation during publication prevents execution admission', async () => {
  const controller = new AbortController();
  let admissions = 0;
  const handler = createPetHead({ pet: pet('a'),
    channel: { subscribe: () => () => {}, readContext: async () => ({ messages: [] }),
      reply: async () => { controller.abort(); }, dispatch: async () => { admissions++; } },
    decide: async () => ({ action: 'dispatch', reply: 'Acknowledged' }),
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
    decide: async () => { decisions++; return { action: 'direct' }; },
  }, events);
  const pending = events.publish(message('1'));
  await started.promise;
  unsubscribe();
  context.resolve({ messages: [] });
  await pending;
  assert.equal(decisions, 0);
});

const createHeadDecision = (endpoint: StudioModelEndpoint, options?: Parameters<typeof createHeadModel>[1]) =>
  createHeadModel(() => endpoint, options).decide;
const decisionInput = { pet: pet('a'), message: message('1'), context: { messages: [] } };
test('Head prompt keeps its prefix stable and sends ten prior public messages plus any older target once', () => {
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
  const make = (incoming: HeadMessage, nextContext = context, addressed = true) =>
    headDecisionMessages({ pet: pet('a'), description: 'Reviewer', message: incoming, context: nextContext, addressed }, 'Schema');
  const [system, [, wire]] = make(current);
  const inWindow = make({ ...current, replyTo: '15' }, { ...context, referencedMessage: history[14] }, false);
  assert.deepEqual(system, inWindow[0], 'a mention and different reference cannot change the system/cache prefix');
  const projection = JSON.parse(wire);
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
const decisionName = 'pet_head_decision';
const tool = (args: Record<string, unknown>, name = decisionName) => new AIMessage({ content: '', tool_calls: [{ name, args }] });
const structured = (value: Record<string, unknown>, method: StudioModelEndpoint['structuredOutputMethod'] = 'jsonMode') =>
  ({ raw: method === 'functionCalling' ? tool(value) : raw(value), parsed: value });
const ignore = { action: 'ignore' };

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

test('a single structured call uses the configured method, shared schema, and no SDK retries', async () => {
  const result = { ...ignore, action: 'dispatch' };
  for (const method of [undefined, 'functionCalling', 'jsonMode', 'jsonSchema'] as const) {
    const mock = mockEndpoint([structured(result, method)], method);
    const events: unknown[] = [];
    const signal = new AbortController().signal;
    assert.deepEqual(await createHeadDecision(mock.endpoint, { onDiagnostic: event => events.push(event) })(decisionInput, signal), result);
    assert.deepEqual(mock.factory(), { maxOutputTokens: 512, maxRetries: 0, preferDeterministic: true, streaming: false, purpose: 'pet-head' });
    assert.deepEqual(mock.binding(), { name: decisionName, method: method ?? 'jsonMode', includeRaw: true });
    assert.deepEqual(mock.calls.map(call => call.mode), ['structured']);
    assert.equal(mock.calls[0]!.signal, signal);
    assert.deepEqual(JSON.parse((mock.calls[0]!.messages as string[][])[1]![1]!), {
      pet: { petId: 'a' }, context: { messages: [] },
      message: { channelId: 'team', messageId: '1', sequence: 1, author: { kind: 'human', id: 'owner' }, body: 'message 1' },
      addressed: false,
    });
    assert.deepEqual(events, [{ petId: 'a', channelId: 'team', messageId: '1', attempts: 1, outcome: 'selected', action: 'dispatch' }]);
  }
});

test('a malformed decision cannot produce effects or retry even if a second result would be valid', async () => {
  const valid = { ...ignore, action: 'dispatch', reply: 'I can look into that.' };
  const mock = mockEndpoint([structured({ ...valid, intent: 'Hallucinated work' }, 'functionCalling'), structured(valid, 'functionCalling')], 'functionCalling');
  const effects: string[] = [];
  const handle = createPetHead({
    pet: pet('a'),
    channel: { subscribe: () => () => {}, readContext: async () => ({ messages: [] }),
      reply: async () => { effects.push('reply'); }, dispatch: async () => { effects.push('dispatch'); } },
    decide: createHeadDecision(mock.endpoint),
  });
  await assert.rejects(handle(message('1'), new AbortController().signal), /Invalid Pet Head decision/);
  assert.deepEqual(mock.calls.map(call => call.mode), ['structured']);
  assert.deepEqual(effects, []);
});

test('failed or unusable decisions are diagnosed without a second invocation or provider payload', async () => {
  for (const [output, code] of [
    [{ raw: new AIMessage(''), parsed: null }, 'malformed'],
    [{ raw: new AIMessage(''), parsed: undefined }, 'malformed'],
    [{ raw: new AIMessage({ content: JSON.stringify(ignore), response_metadata: { finish_reason: 'content_filter' } }), parsed: ignore }, 'refusal'],
    [{ raw: new AIMessage({ content: JSON.stringify(ignore), response_metadata: { finish_reason: 'length' } }), parsed: ignore }, 'truncated'],
    [{ raw: tool(ignore), parsed: ignore }, 'invalid_tool'],
    [{ raw: new AIMessage({ content: JSON.stringify(ignore),
      invalid_tool_calls: [{ name: decisionName, args: 'invalid' }] }), parsed: ignore }, 'invalid_tool'],
    [new Error('private provider payload'), 'provider_error'],
  ] as const) {
    const mock = mockEndpoint([output, structured(ignore)], 'jsonMode');
    const events: unknown[] = [];
    await assert.rejects(createHeadDecision(mock.endpoint, { onDiagnostic: event => events.push(event) })(decisionInput, new AbortController().signal),
      { message: 'Invalid Pet Head decision.' });
    assert.deepEqual(mock.calls.map(call => call.mode), ['structured']);
    assert.deepEqual(events, [{ petId: 'a', channelId: 'team', messageId: '1', attempts: 1, outcome: 'error', code }]);
  }
});

test('abort before or during provider work prevents selection', async () => {
  for (const before of [true, false]) {
    const controller = new AbortController();
    const mock = mockEndpoint([() => { controller.abort(); return structured(ignore); }, structured(ignore)]);
    if (before) controller.abort();
    const events: Array<{ outcome: string; code?: string }> = [];
    await assert.rejects(createHeadDecision(mock.endpoint, { onDiagnostic: event => events.push(event) })(decisionInput, controller.signal));
    assert.equal(mock.calls.length, before ? 0 : 1);
    assert.equal(events[0]?.code, 'aborted');
  }
});

function nativeEndpoint(protocol: NonNullable<StudioModelEndpoint['protocol']>, model: string, method?: StudioModelEndpoint['structuredOutputMethod']): StudioModelEndpoint {
  const baseUrl = protocol === 'anthropic-compatible' ? 'https://api.anthropic.test'
    : model.startsWith('deepseek-') ? 'https://api.deepseek.com/v1' : 'https://api.openai.com/v1';
  const endpoint = { profileId: 'fixture', protocol, model, baseUrl, apiKey: 'fixture-only', structuredOutputMethod: method };
  return { ...endpoint, createChatModel: options => buildModel({ ...endpoint, maxOutputTokens: options.maxOutputTokens, maxRetries: options.maxRetries, timeoutMs: 2_000 },
    { streaming: options.streaming, preferDeterministic: options.preferDeterministic, purpose: options.purpose }) };
}

test('official DeepSeek Flash / Pro profiles send JSON mode through the real Host model adapter', async t => {
  const calls: Array<{ url: string; body: { model: string; response_format: unknown; tools?: unknown; tool_choice?: unknown; thinking?: unknown; max_tokens?: number; max_completion_tokens?: number } }> = [];
  let content = JSON.stringify(ignore);
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    calls.push({ url: String(url), body });
    return Response.json({ id: 'fixture', object: 'chat.completion', created: 0, model: body.model,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  });
  for (const model of ['deepseek-flash', 'deepseek-v4-pro']) {
    const decide = createHeadDecision(nativeEndpoint('openai-compatible', model, 'jsonMode'));
    content = JSON.stringify(ignore);
    assert.deepEqual(await decide(decisionInput, new AbortController().signal), ignore);
    content = JSON.stringify({ ...ignore, action: 'unknown' });
    await assert.rejects(decide(decisionInput, new AbortController().signal), /Invalid Pet Head decision/);
    content = 'not JSON';
    await assert.rejects(decide(decisionInput, new AbortController().signal), /Invalid Pet Head decision/);
  }
  assert.deepEqual(calls.map(({ body }) => body.model), ['deepseek-flash', 'deepseek-flash', 'deepseek-flash', 'deepseek-v4-pro', 'deepseek-v4-pro', 'deepseek-v4-pro']);
  for (const { url, body } of calls) {
    assert.equal(url, 'https://api.deepseek.com/v1/chat/completions');
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.equal(body.tools, undefined);
    assert.equal(body.tool_choice, undefined);
    assert.deepEqual(body.thinking, { type: 'disabled' });
    assert.equal(body.max_completion_tokens ?? body.max_tokens, 512);
  }
});

test('official Flash sends a committed review handoff to work and a matching status question only to reply', async t => {
  const participantId = 'pet:a';
  const mentions = [{ participantId, label: 'Reviewer' }];
  const artifact = message('10', { body: 'Synthetic observation: indicator A has no verified source.' });
  const packet = [
    '盘点核对方案已完成：先核对盘点日期，再核对期末库存。当前交付结论为“证据齐全”。',
    ...Array.from({ length: 24 }, (_, i) => `证据 ${i + 1}：以同日账册为准，抽样结果附在对应批次下。`),
    '待独立核查：缺少的依据可能藏在附件目录，而非结论段。不要把这句话当成前述结论的证据。',
  ].join('\n');
  const address = '[@Reviewer](participant:pet:a)';
  const statusText = '我无法确认这项核查的执行状态。';
  const sources = (['pet', 'human'] as const).flatMap((kind, index) => {
    const author = { kind, id: kind === 'pet' ? 'executor' : 'owner' };
    const final = kind === 'pet' ? { externalRef: 'synthetic-executor-final' } : {};
    return [
      { route: 'work', incoming: message(String(11 + index * 5), { mentions, author, ...final,
        body: `${packet}\n\n${address} 请独立核查上述方案和频道中的依据，把证据不支持的结论列出来。` }) },
      { route: 'status', incoming: message(String(12 + index * 5), { mentions, author,
        body: `${packet}\n\n${address} 你的独立核查现在做到哪一步了？只报状态，不要重新核查。` }) },
      { route: 'thanks', incoming: message(String(13 + index * 5), { mentions, author, body: `${address} 辛苦了，谢谢。` }) },
      { route: 'bare', incoming: message(String(14 + index * 5), { mentions, author, body: address }) },
      { route: 'rewrite', incoming: message(String(15 + index * 5), { mentions, author, body: `${address} 复核上文。` }) },
    ] as const;
  });
  const modelCalls: Array<{ messageId: string; stage: 'decide' | 'compose' }> = [];
  const admitted: string[] = [];
  const replies: Array<[string, string]> = [];
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    assert.equal(String(url), 'https://api.deepseek.com/v1/chat/completions');
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.thinking, { type: 'disabled' });
    assert.equal(body.tools, undefined);
    const input = JSON.parse(body.messages.find((entry: { role: string }) => entry.role === 'user').content);
    const fixture = sources.find(item => item.incoming.messageId === input.message.messageId);
    assert.ok(fixture);
    let content: string;
    if (input.evidence) {
      const { messageId, sequence, channelId, author, body: sourceBody, mentions } = fixture.incoming;
      assert.deepEqual(input.message, { messageId, sequence, channelId, author, body: sourceBody, mentions });
      assert.equal(fixture.route, 'status');
      assert.equal(body.response_format, undefined);
      assert.deepEqual(input.evidence, { status: 'unavailable' });
      assert.equal(input.source, undefined);
      modelCalls.push({ messageId: fixture.incoming.messageId, stage: 'compose' });
      content = statusText;
    } else {
      assert.deepEqual(body.response_format, { type: 'json_object' });
      assert.equal(input.addressed, true);
      assert.deepEqual(Object.keys(input).sort(), ['addressed', 'context', 'message', 'pet']);
      const { messageId, sequence, channelId, author, body: sourceBody } = fixture.incoming;
      assert.deepEqual(input.message, { messageId, sequence, channelId, author, body: sourceBody,
        mentions: [{ participantId, kind: 'pet', id: 'a' }] });
      assert.deepEqual(input.context.messages, [{ messageId: artifact.messageId, sequence: artifact.sequence, author: artifact.author, body: artifact.body }]);
      modelCalls.push({ messageId: fixture.incoming.messageId, stage: 'decide' });
      content = JSON.stringify(fixture.route === 'work' ? { action: 'dispatch' } :
        fixture.route === 'status' ? { action: 'status' } :
          fixture.route === 'rewrite' ? { action: 'dispatch', intent: 'A fabricated rewrite' } : { action: 'ignore' });
    }
    return Response.json({ id: 'fixture', object: 'chat.completion', created: 0, model: body.model,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  });
  const signal = new AbortController().signal;
  const model = createHeadModel(() => nativeEndpoint('openai-compatible', 'deepseek-flash'));
  const handle = createPetHead({ pet: pet('a'),
    readWorkState: () => ({ kind: 'idle' }),
    channel: {
      subscribe: () => () => {},
      readContext: async (_pet, before) => {
        assert.ok(sources.some(item => item.incoming.sequence === before), 'Read exclusive of the current message');
        return { messages: [artifact], members: [{ kind: 'pet', id: 'a', participantId }] };
      },
      reply: async (_pet, source, text) => { replies.push([source, text]); },
      dispatch: async (petId, source, actualSignal) => {
        assert.equal(petId, 'a');
        assert.equal(actualSignal, signal);
        admitted.push(source);
      },
    },
    decide: model.decide,
    progress: {
      readRun: () => assert.fail('idle has no active run'),
      readSessionRun: async () => assert.fail('idle must not read Session'),
      compose: model.composeReply,
    },
  });
  for (const { route, incoming } of sources) {
    if (route === 'rewrite') await assert.rejects(handle(incoming, signal), /Invalid Pet Head decision/);
    else await handle(incoming, signal);
  }
  assert.deepEqual(modelCalls, sources.flatMap(({ route, incoming }) => [
    { messageId: incoming.messageId, stage: 'decide' },
    ...(route === 'status' ? [{ messageId: incoming.messageId, stage: 'compose' }] : []),
  ]));
  assert.deepEqual(admitted, sources.filter(item => item.route === 'work').map(item => item.incoming.messageId));
  assert.deepEqual(replies, sources.filter(item => item.route === 'status').map(item => [item.incoming.messageId, statusText]));
});

test('the native OpenAI strict schema uses a nullable reply without a work description', async t => {
  const outputs = [
    { action: 'direct', reply: 'I can answer directly.' },
    { action: 'dispatch', reply: null },
  ];
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    const output = outputs[requests++]!;
    assert.equal(String(url), 'https://api.openai.com/v1/chat/completions');
    const body = JSON.parse(String(init?.body));
    assert.equal(body.response_format.type, 'json_schema');
    const { name, strict, schema } = body.response_format.json_schema;
    assert.equal(name, decisionName);
    assert.equal(strict, true);
    assert.deepEqual(schema.required, ['action', 'reply']);
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.properties.action.enum, ['ignore', 'direct', 'dispatch', 'status']);
    const validator = new Validator(schema, '7');
    assert.equal(validator.validate(output).valid, true);
    assert.equal(validator.validate({ ...output, intent: 42 }).valid, false);
    assert.equal(validator.validate({ ...output, reply: 42 }).valid, false);
    assert.equal(validator.validate({ action: output.action }).valid, false);
    return Response.json({ id: 'fixture', object: 'chat.completion', created: 0, model: body.model,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(output) } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  });
  const decide = createHeadDecision(nativeEndpoint('openai-compatible', 'gpt-5.5', 'jsonSchema'));
  for (const output of outputs) {
    assert.deepEqual(await decide({ ...decisionInput, addressed: true }, new AbortController().signal), output);
  }
  assert.equal(requests, outputs.length);
});

test('native Anthropic declaration accepts exactly one named tool and never repairs a rejected result', async t => {
  const calls: Array<{ tools: Array<{ name: string }>; tool_choice: unknown; output_config?: unknown }> = [];
  const declaration = (id: string, name = decisionName) => ({ type: 'tool_use', id, name, input: ignore });
  let content: unknown[] = [declaration('valid')];
  let stopReason = 'tool_use';
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body)));
    return Response.json({ id: 'fixture', type: 'message', role: 'assistant', model: 'claude-haiku-4-5',
      content, stop_reason: stopReason, usage: { input_tokens: 1, output_tokens: 1 } });
  });
  const decide = createHeadDecision(nativeEndpoint('anthropic-compatible', 'claude-haiku-4-5', 'functionCalling'));
  const signal = new AbortController().signal;
  assert.deepEqual(await decide(decisionInput, signal), ignore);
  let attempts = 1;
  for (const [blocks, stop] of [
    [[{ type: 'text', text: JSON.stringify(ignore) }], 'end_turn'],
    [[declaration('wrong', 'other')], 'tool_use'],
    [[declaration('first'), declaration('second')], 'tool_use'],
    [[{ ...declaration('wrong_shape'), input: { ...ignore, readProgress: 'yes' } }], 'tool_use'],
    [[declaration('refused')], 'refusal'],
    [[declaration('truncated')], 'max_tokens'],
  ] as const) {
    content = [...blocks]; stopReason = stop;
    await assert.rejects(decide(decisionInput, signal), /Invalid Pet Head decision/);
    assert.equal(calls.length, ++attempts);
  }
  for (const body of calls) {
    assert.deepEqual(body.tools.map(entry => entry.name), [decisionName]);
    assert.deepEqual(body.tool_choice, { type: 'tool', name: decisionName });
    assert.equal(body.output_config, undefined);
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

test('only a verified status lookup fetches a missing active source; reuse a public reference when present', async () => {
  const active = { dispatchId: 'old', sessionId: 'session', messageId: 'original' };
  const original = message('original', { body: 'Calculate using the measured units.' });
  for (const replyTo of [undefined, original.messageId]) {
    for (const action of ['ignore', 'status'] as const) {
      const calls: string[] = [];
      const handler = createPetHead({ pet: pet('a'), readWorkState: () => ({ kind: 'active', dispatch: active }),
        channel: { subscribe: () => () => {}, reply: async () => assert.fail('no prose'),
          readContext: async (_pet, _before, reference) => {
            calls.push('context');
            return { messages: [], ...(reference === original.messageId ? { referencedMessage: original } : {}) };
          },
          dispatch: async () => assert.fail('status is never work') },
        decide: async input => {
          calls.push('decide');
          assert.deepEqual(Object.keys(input).sort(), ['addressed', 'context', 'message', 'pet']);
          return { action };
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
      assert.deepEqual(calls, action === 'ignore' ? ['context', 'decide']
        : ['context', 'decide', 'sample', ...(replyTo ? [] : ['context']), 'compose']);
    }
  }
});

test('tool and JSON transports accept every independent reply/execution combination', async () => {
  for (const method of ['functionCalling', 'jsonMode'] as const) for (const action of ['direct', 'dispatch'] as const) for (const reply of ['', 'I can look into this.']) {
    const decision = { action, reply };
    const mock = mockEndpoint([structured(decision, method)], method);
    const diagnostics: Array<{ outcome: string; action?: string }> = [];
    assert.deepEqual(await createHeadDecision(mock.endpoint, { onDiagnostic: value => diagnostics.push(value) })(decisionInput, new AbortController().signal), decision);
    assert.equal(mock.calls.length, 1);
    assert.equal(diagnostics[0]?.outcome, action === 'direct' && !reply ? 'ignore' : 'selected');
  }
});

test('unknown, contradictory, or scheduling-bearing decisions fail closed', async () => {
  for (const value of [
    { action: 'handle' },
    { action: 'direct', reply: 42 },
    { action: 'ignore', reply: 'Not silent' },
    { action: 'dispatch', intent: 'A rewritten request' },
    { action: 'dispatch', timing: 'interrupt' },
    { action: 'dispatch', readProgress: false },
    { action: 'status', intent: 'Hidden work' },
    { action: 'status', reply: 'Unverified status' },
  ]) {
    const mock = mockEndpoint([structured(value), structured(ignore)]);
    await assert.rejects(createHeadDecision(mock.endpoint)(decisionInput, new AbortController().signal));
    assert.equal(mock.calls.length, 1);
  }
});

test('tool and structured JSON expose the same independent reply and execution schema', async () => {
  const value = { action: 'dispatch', reply: '收到，我会先核对口径，再整理差异。' };
  const toolModel = mockEndpoint([structured(value, 'functionCalling')], 'functionCalling');
  const jsonModel = mockEndpoint([structured(value, 'jsonSchema')], 'jsonSchema');
  for (const mock of [toolModel, jsonModel]) {
    assert.deepEqual(await createHeadDecision(mock.endpoint)(decisionInput, new AbortController().signal), value);
  }
  const declaration = toolModel.schema();
  assert.deepEqual(declaration, jsonModel.schema());
  const schema = declaration as { required: string[]; additionalProperties: boolean; properties: { action: { enum: string[] } } };
  assert.deepEqual(schema.required, ['action']);
  assert.deepEqual(schema.properties.action.enum, ['ignore', 'direct', 'dispatch', 'status']);
  const validator = new Validator(schema, '7');
  assert.equal(validator.validate({ action: 'ignore' }).valid, true);
  assert.equal(validator.validate({ action: 'direct', reply: null }).valid, true);
  assert.equal(validator.validate(value).valid, true);
  assert.equal(schema.additionalProperties, false);
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
    decide: async () => ({ action: 'dispatch', reply: '收到，我会先核对口径，再整理差异。' }),
  });
  const pending = handler(source, signal);
  await entered.promise;
  assert.deepEqual(effects, ['收到，我会先核对口径，再整理差异。']);
  admission.resolve(); await pending;
  assert.deepEqual(effects, ['收到，我会先核对口径，再整理差异。', 'admitted']);
});

test('a canonical mention settles responsibility without changing the decision schema', async () => {
  const participantId = 'pet:a%28b%29';
  const base = { pet: pet('a(b)'), context: { messages: [], members: [{ kind: 'pet' as const, id: 'a(b)', participantId }] } };
  const named = message('2', { mentions: [{ participantId, label: 'not the current label' }] });
  const addressedInput = { ...base, message: named };
  const matchingLabelOnly = message('3', { body: '@a(b)', mentions: [{ participantId: 'pet:other', label: 'a(b)' }] });
  const lookalike = { ...base, context: { ...base.context, messages: [named] }, message: matchingLabelOnly };
  assert.equal(isHeadAddressed(addressedInput), true);
  assert.equal(isHeadAddressed(lookalike), false);
  for (const method of ['jsonSchema', 'functionCalling'] as const) {
    const output = { action: 'ignore' };
    const mock = mockEndpoint([structured(output, method), structured(output, method)], method);
    const signal = new AbortController().signal;
    const decide = createHeadDecision(mock.endpoint);
    assert.deepEqual(await decide({ ...addressedInput, addressed: true }, signal), output);
    const namedSchema = mock.schema();
    assert.deepEqual(await decide({ ...lookalike, addressed: false }, signal), output);
    assert.deepEqual(namedSchema, mock.schema());
  }
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

test('the status model sees checked evidence and public addressing, not storage or file metadata', async () => {
  const mentions = [{ participantId: 'pet:a', label: 'Analyst' }];
  const current = message('20', { author: { kind: 'pet', id: 'reviewer' }, body: 'Check the status of this report.',
    mentions, replyTo: '12', externalRef: 'internal-delivery-ref', deliverables: [{ uri: 'https://example.test/internal-report' }] });
  const source = { messageId: '12', body: 'Prepare the report.' };
  const mock = mockEndpoint([new AIMessage('The report is still running.')]);
  const reply = await createHeadModel(() => mock.endpoint).composeReply({ message: current, evidence: { status: 'running' }, source },
    new AbortController().signal);
  assert.equal(reply, 'The report is still running.');
  assert.deepEqual(JSON.parse((mock.calls[0]!.messages as string[][])[1]![1]!), {
    message: { channelId: current.channelId, messageId: current.messageId, sequence: current.sequence, author: current.author,
      body: current.body, replyTo: source.messageId, attachmentCount: 1, mentions },
    evidence: { status: 'running' }, source,
  });
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
  const result = { action: 'status' };
  const mock = mockEndpoint([structured(result), new AIMessage({
    content: [{ type: 'reasoning', reasoning: 'private analysis' }, { type: 'text', text: ' [Known update](https://example.test) ' }],
  }), structured(result)], 'jsonMode');
  let resolved = 0;
  const model = createHeadModel(() => { resolved++; return mock.endpoint; });
  assert.equal(resolved, 0);
  assert.equal(mock.factoryCalls(), 0);
  const signal = new AbortController().signal;
  assert.deepEqual(await model.decide(decisionInput, signal), result);
  assert.equal(await model.composeReply({ message: decisionInput.message, evidence: { status: 'unavailable' } }, signal),
    '[Known update](https://example.test)');
  assert.deepEqual(await model.decide(decisionInput, signal), result);
  assert.deepEqual(mock.calls.map(call => call.mode), ['structured', 'unbound', 'structured']);
  assert.equal(resolved, 1);
  assert.equal(mock.factoryCalls(), 1);
});

test('a run switch during progress composition cannot publish A as B, and B admission survives', async () => {
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
    decide: async () => ({ action: 'dispatch', reply: 'I received the calendar request.' }),
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
  assert.deepEqual(replies, ['I received the calendar request.']);
  assert.deepEqual(admitted, [inquiry.messageId]);
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
    decide: async () => ({ action: 'status' }),
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

test('an exact busy run is sampled once, while only a work request enters admission', async () => {
  const source = message('original', { body: 'Create the inventory.' });
  const active = { dispatchId: 'a', sessionId: 'same-session', messageId: source.messageId };
  const run = { invocationId: active.dispatchId, requestId: 'a-run', sessionId: active.sessionId };
  for (const [body, action, response] of [
    ['How far is the inventory?', 'status', 'The inventory is still running.'],
    ['How far is the inventory? Also summarize the calendar.', 'dispatch', 'The inventory is still running.'],
    ['Summarize the calendar after the inventory.', 'dispatch', ''],
  ] as const) {
    const incoming = message('20', { body });
    const calls: string[] = [];
    const handle = createPetHead({ pet: pet('a'), readWorkState: () => ({ kind: 'active', dispatch: active }),
      channel: {
        subscribe: () => () => {},
        readContext: async () => ({ messages: [source] }),
        reply: async (_pet, messageId, text) => {
          assert.equal(messageId, incoming.messageId);
          assert.equal(text, response);
          calls.push('reply');
        },
        dispatch: async (_pet, messageId) => {
          assert.equal(messageId, incoming.messageId);
          calls.push('dispatch');
        },
      },
      decide: async () => { calls.push('decide'); return { action }; },
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
    assert.deepEqual(calls, ['decide', 'read', 'compose', ...(response ? ['reply'] : []), ...(action === 'dispatch' ? ['dispatch'] : [])]);
  }
});

test('first-gate ignore and direct replies have no Session read even if the Pet is busy', async () => {
  for (const action of ['ignore', 'direct'] as const) {
    const replies: string[] = [];
    const handle = createPetHead({ pet: pet('a'),
      readWorkState: () => ({ kind: 'active', dispatch: { dispatchId: 'a', sessionId: 's' } }),
      channel: { subscribe: () => () => {}, readContext: async () => ({ messages: [] }),
        reply: async (_pet, _id, body) => { replies.push(body); },
        dispatch: async () => assert.fail('nothing is admitted') },
      decide: async () => ({ action, ...(action === 'direct' ? { reply: 'I know.' } : {}) }),
      progress: {
        readRun: () => ({ invocationId: 'a', requestId: 'r', sessionId: 's' }),
        readSessionRun: async () => assert.fail('first-gate ignore/direct never read Session'),
        compose: async () => assert.fail('first-gate ignore/direct never compose status'),
      },
    });
    await handle(message('1'), new AbortController().signal);
    assert.deepEqual(replies, action === 'direct' ? ['I know.'] : []);
  }
});

test('switching attempts before the first decision returns never reads the new attempt for the old message', async () => {
  const original = message('older', { body: 'Create the report.' });
  const inquiry = message('21', { replyTo: original.messageId, body: 'How far is the report?' });
  const active = { dispatchId: 'same-invocation', sessionId: 'same-session', messageId: original.messageId };
  let requestId = 'attempt-a';
  let composed = 0;
  const handle = createPetHead({ pet: pet('a'), readWorkState: () => ({ kind: 'active', dispatch: active }),
    channel: { subscribe: () => () => {}, readContext: async () => ({ messages: [original], referencedMessage: original }),
      reply: async () => {},
      dispatch: async () => assert.fail('pure status never dispatches') },
    decide: async () => { requestId = 'attempt-b'; return { action: 'status' }; },
    progress: {
      readRun: () => ({ invocationId: active.dispatchId, sessionId: active.sessionId, requestId }),
      readSessionRun: async () => assert.fail('do not read B or use B as evidence for A'),
      compose: async input => {
        assert.deepEqual(input.evidence, { status: 'unavailable' });
        composed++;
        return 'I cannot confirm its progress.';
      },
    },
  });
  await handle(inquiry, new AbortController().signal);
  assert.equal(composed, 1);
});

test('unknown is not idle: no arbitrary read, while separately identified work can use ordinary admission', async () => {
  for (const [kind, action] of [
    ['idle', 'dispatch'],
    ['idle', 'status'],
    ['unknown', 'dispatch'],
    ['unknown', 'status'],
  ] as const) {
    const calls: string[] = [];
    const incoming = message('10');
    const handle = createPetHead({ pet: pet('a'), readWorkState: () => ({ kind }),
      channel: {
        subscribe: () => () => {},
        readContext: async () => ({ messages: [] }),
        reply: async () => { calls.push('reply'); },
        dispatch: async (_pet, source) => {
          assert.equal(source, incoming.messageId);
          calls.push('dispatch');
        },
      },
      decide: async () => ({ action }),
      progress: {
        readRun: () => assert.fail('no exact ordinary slot is known'),
        readSessionRun: async () => assert.fail('do not open a Session without a verified run'),
        compose: async input => {
          assert.deepEqual(input.evidence, { status: 'unavailable' });
          calls.push('compose');
          return action === 'dispatch' ? '' : 'I cannot confirm the status.';
        },
      },
    });
    await handle(incoming, new AbortController().signal);
    const expected = kind === 'idle' && action === 'dispatch' ? [] : ['compose'];
    assert.deepEqual(calls, [...expected, action === 'dispatch' ? 'dispatch' : 'reply']);
  }
});

test('if the run changes inside the reply operation, its write guard blocks stale status without blocking B', async () => {
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
    decide: async () => ({ action: 'dispatch' }),
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
  assert.deepEqual(calls, ['dispatch']);
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
    decide: async () => ({ action: 'dispatch', reply: 'I cannot confirm the earlier report’s progress.' }),
    progress: {
      readRun: () => assert.fail('there is no currently bound attempt'),
      readSessionRun: async () => assert.fail('idle work never reads Session'),
      compose: async () => assert.fail('idle work never needs a second model call'),
    },
  });
  await handle(incoming, new AbortController().signal);
  assert.deepEqual(calls, ['I cannot confirm the earlier report’s progress.', 'dispatch']);
});
