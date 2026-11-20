import assert from 'node:assert/strict';
import { AIMessage, AIMessageChunk } from '@langchain/core/messages';
import { toJsonSchema } from '@langchain/core/utils/json_schema';
import { buildModel } from 'pinpawo/host-runtime';
import test from 'node:test';
import { bindPetHeadChannel, createPetHead, isHeadAddressed, readHeadActiveDispatch, type HeadMessage, type PetHeadChannel } from './petHead';
import { createHeadModel } from './petHeadModel';
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
  await channel.dispatch('a', current, 'work', signal);
  assert.deepEqual(calls, [
    ['read', 'team', 'a', 3, '1'],
    ['reply', 'team', 'a', '2', 'yes', signal, undefined],
    ['dispatch', 'team', 'a', current, 'work', signal],
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
    decide: async input => { seen.push({ petId: input.pet.petId, message: input.message }); return { action: 'ignore', reply: '', intent: '', engage: true, readProgress: false }; },
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
    decide: async input => { seen.push(input.message); return { action: 'ignore', reply: '', intent: '', engage: true, readProgress: false }; },
  }, events);
  await events.publish(message('1', { author: { kind: 'pet', id: 'a' } }));
  await events.publish(message('2', { channelId: 'other' }));
  assert.deepEqual(seen, []);
  unsubscribe();
});

test('independent publication and execution axes support all four combinations with exact attribution', async () => {
  for (const action of ['ignore', 'dispatch'] as const) for (const reply of ['', 'Acknowledged']) {
    const calls: unknown[][] = [];
    const source = message('1', { author: { kind: 'pet', id: 'peer' }, replyTo: 'older' });
    const signal = new AbortController().signal;
    const handler = createPetHead({ pet: pet('a'),
      channel: { subscribe: () => () => {}, readContext: async () => ({ messages: [] }),
        reply: async (...args) => { calls.push(['reply', ...args]); }, dispatch: async (...args) => { calls.push(['dispatch', ...args]); } },
      decide: async () => ({ action, reply, intent: action === 'dispatch' ? 'Do the work' : '', engage: true, readProgress: false }),
    });
    await handler(source, signal);
    assert.equal(calls.filter(call => call[0] === 'reply').length, reply ? 1 : 0);
    assert.equal(calls.filter(call => call[0] === 'dispatch').length, action === 'dispatch' ? 1 : 0);
    if (reply) assert.deepEqual(calls[0], ['reply', 'a', '1', reply, signal, { preventPetMentions: true }]);
    if (action === 'dispatch') assert.deepEqual(calls.at(-1), ['dispatch', 'a', source, 'Do the work', signal]);
  }
});

test('publication and admission failures are independent and do not leak provider errors', async () => {
  for (const fail of ['reply', 'dispatch', 'both']) {
    const calls: string[] = [];
    const handler = createPetHead({ pet: pet('a'),
      channel: { subscribe: () => () => {}, readContext: async () => ({ messages: [] }),
        reply: async () => { calls.push('reply'); if (fail !== 'dispatch') throw new Error('private reply detail'); },
        dispatch: async () => { calls.push('dispatch'); if (fail !== 'reply') throw new Error('private dispatch detail'); } },
      decide: async () => ({ action: 'dispatch', reply: 'I can look into this.', intent: 'Inspect source', engage: true, readProgress: false }),
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
  pending.resolve({ action: 'dispatch', reply: 'late', intent: 'late work', engage: true, readProgress: false });
  await run;
  assert.deepEqual(effects, []);
});

test('cancellation during publication prevents execution admission', async () => {
  const controller = new AbortController();
  let admissions = 0;
  const handler = createPetHead({ pet: pet('a'),
    channel: { subscribe: () => () => {}, readContext: async () => ({ messages: [] }),
      reply: async () => { controller.abort(); }, dispatch: async () => { admissions++; } },
    decide: async () => ({ action: 'dispatch', reply: 'Acknowledged', intent: 'Work', engage: true, readProgress: false }),
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
    decide: async () => { decisions++; return { action: 'ignore', reply: '', intent: '', engage: true, readProgress: false }; },
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
const raw = (value: unknown) => new AIMessage(JSON.stringify(value));
const decisionName = 'pet_head_decision';
const tool = (args: Record<string, unknown>, name = decisionName) => new AIMessage({ content: '', tool_calls: [{ name, args }] });
const structured = (value: Record<string, unknown>, method: StudioModelEndpoint['structuredOutputMethod'] = 'jsonMode') =>
  ({ raw: method === 'functionCalling' ? tool(value) : raw(value), parsed: value });
const ignore = { action: 'ignore', reply: '', intent: '', engage: true, readProgress: false };

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
  const result = { ...ignore, action: 'dispatch', intent: 'Address source' };
  for (const method of [undefined, 'functionCalling', 'jsonMode', 'jsonSchema'] as const) {
    const mock = mockEndpoint([structured(result, method)], method);
    const events: unknown[] = [];
    const signal = new AbortController().signal;
    assert.deepEqual(await createHeadDecision(mock.endpoint, { onDiagnostic: event => events.push(event) })(decisionInput, signal), result);
    assert.deepEqual(mock.factory(), { maxOutputTokens: 512, maxRetries: 0, preferDeterministic: true, streaming: false, purpose: 'pet-head' });
    assert.deepEqual(mock.binding(), { name: decisionName, method: method ?? 'jsonMode', includeRaw: true });
    assert.deepEqual(mock.calls.map(call => call.mode), ['structured']);
    assert.equal(mock.calls[0]!.signal, signal);
    assert.deepEqual(JSON.parse((mock.calls[0]!.messages as string[][])[1]![1]!), decisionInput);
    assert.deepEqual(events, [{ petId: 'a', channelId: 'team', messageId: '1', attempts: 1, outcome: 'selected', action: 'dispatch' }]);
  }
});

test('a malformed decision cannot produce effects or retry even if a second result would be valid', async () => {
  const valid = { ...ignore, action: 'dispatch', reply: 'I can look into that.', intent: 'Inspect the report.' };
  const mock = mockEndpoint([structured({ ...valid, intent: ' ' }, 'functionCalling'), structured(valid, 'functionCalling')], 'functionCalling');
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

function nativeEndpoint(protocol: NonNullable<StudioModelEndpoint['protocol']>, model: string, method: NonNullable<StudioModelEndpoint['structuredOutputMethod']>): StudioModelEndpoint {
  const baseUrl = protocol === 'anthropic-compatible' ? 'https://api.anthropic.test' : 'https://api.deepseek.com/v1';
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

test('readActiveDispatch uses only the current ordinary dispatch slot in its owner Channel', () => {
  const entry = { dispatchId: 'running', enqueuedAt: 'now', sessionId: 'session', scope: { namespace: 'channel', id: 'team' }, origin: { namespace: 'channel', id: 'original' } };
  const queue = { state: 'busy' as const, activeOperation: 'dispatch' as const, queuedConversations: 0, queuedDispatches: 1,
    activeDispatch: entry, entries: [{ ...entry, dispatchId: 'queued' }] };
  assert.deepEqual(readHeadActiveDispatch('team', queue), { dispatchId: 'running', sessionId: 'session', messageId: 'original' });
  assert.equal(readHeadActiveDispatch('elsewhere', queue), undefined);
  assert.equal(readHeadActiveDispatch('team', { ...queue, activeOperation: 'conversation' }), undefined);
  assert.equal(readHeadActiveDispatch('team', { ...queue, activeDispatch: undefined }), undefined);
});

test('the active source can be loaded outside the current context, reusing an existing reference if possible', async () => {
  const active = { dispatchId: 'old', sessionId: 'session', messageId: 'original' };
  const original = message('original', { body: 'Calculate using the measured units.' });
  for (const replyTo of [undefined, original.messageId]) {
    let contextReads = 0;
    let decisions = 0;
    const handler = createPetHead({ pet: pet('a'), readActiveDispatch: () => active,
      channel: { subscribe: () => () => {}, reply: async () => { throw new Error('no direct reply'); },
        readContext: async (_pet, _before, reference) => {
          contextReads++;
          return { messages: [], ...(reference === original.messageId ? { referencedMessage: original } : {}) };
        },
        dispatch: async () => { throw new Error('no execution'); } },
      decide: async input => {
        decisions++;
        assert.deepEqual(input.activeWork, { source: { messageId: original.messageId, body: original.body } });
        assert.doesNotMatch(JSON.stringify(input), /dispatchId|sessionId|pending/);
        return { engage: false, reply: '', action: 'ignore', intent: '', readProgress: false };
      },
    });
    await handler(message('2', { replyTo }), new AbortController().signal);
    assert.equal(decisions, 1);
    assert.equal(contextReads, replyTo ? 1 : 2);
  }
});

test('tool and JSON transports accept every independent reply/execution combination', async () => {
  for (const method of ['functionCalling', 'jsonMode'] as const) for (const action of ['ignore', 'dispatch'] as const) for (const reply of ['', 'I can look into this.']) {
    const decision = { action, reply, intent: action === 'dispatch' ? 'Investigate the source' : '', engage: true, readProgress: false };
    const mock = mockEndpoint([structured(decision, method)], method);
    const diagnostics: Array<{ outcome: string; action?: string }> = [];
    assert.deepEqual(await createHeadDecision(mock.endpoint, { onDiagnostic: value => diagnostics.push(value) })(decisionInput, new AbortController().signal), decision);
    assert.equal(mock.calls.length, 1);
    assert.equal(diagnostics[0]?.outcome, action === 'ignore' && !reply ? 'ignore' : 'selected');
  }
});

test('malformed decisions, stale timing and mixed engagement effects fail closed', async () => {
  for (const value of [
    { action: 'reply', text: 'old response', engage: true, readProgress: false },
    { action: 'ignore', reply: 42, intent: '', engage: true, readProgress: false },
    { action: 'ignore', reply: 'Ack', intent: 'Hidden work', engage: true, readProgress: false },
    { action: 'dispatch', reply: 'Ack', intent: '', engage: true, readProgress: false },
    { action: 'dispatch', reply: '', intent: 'Work', engage: true, readProgress: false, extra: true },
    { action: 'dispatch', reply: '', intent: 'Work', engage: true, readProgress: false, timing: 'interrupt' },
    { action: 'dispatch', reply: '', intent: 'Work', engage: false, readProgress: false },
    { action: 'ignore', reply: 'Cannot know yet', intent: '', engage: true, readProgress: true },
    { action: 'ignore', reply: '', intent: '', engage: false, readProgress: true },
  ]) {
    const mock = mockEndpoint([structured(value), structured(ignore)]);
    await assert.rejects(createHeadDecision(mock.endpoint)(decisionInput, new AbortController().signal));
    assert.equal(mock.calls.length, 1);
  }
});

test('tool and structured JSON expose the same independent reply and execution schema', async () => {
  const value = { action: 'dispatch', reply: '收到，我会先核对口径，再整理差异。', intent: 'Compare both datasets using equivalent definitions.', engage: true, readProgress: false };
  const toolModel = mockEndpoint([structured(value, 'functionCalling')], 'functionCalling');
  const jsonModel = mockEndpoint([structured(value, 'jsonSchema')], 'jsonSchema');
  for (const mock of [toolModel, jsonModel]) {
    assert.deepEqual(await createHeadDecision(mock.endpoint)(decisionInput, new AbortController().signal), value);
  }
  const declaration = toolModel.schema();
  assert.deepEqual(declaration, jsonModel.schema());
  const schema = declaration as { required: string[]; additionalProperties: boolean; properties: { action: { enum: string[] }; reply: { type: string }; intent: { type: string } } };
  assert.deepEqual(schema.required, ['engage', 'action', 'reply', 'intent', 'readProgress']);
  assert.deepEqual(schema.properties.action.enum, ['ignore', 'dispatch']);
  assert.equal(schema.properties.reply.type, 'string');
  assert.equal(schema.properties.intent.type, 'string');
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
      dispatch: async (_id, actualSource, request) => {
        assert.equal(actualSource, source); assert.equal(request, '核对两份数据的口径，整理差异。');
        entered.resolve(); await admission.promise; effects.push('admitted');
      } },
    decide: async () => ({ action: 'dispatch', reply: '收到，我会先核对口径，再整理差异。', intent: '核对两份数据的口径，整理差异。', engage: true, readProgress: false }),
  });
  const pending = handler(source, signal);
  await entered.promise;
  assert.deepEqual(effects, ['收到，我会先核对口径，再整理差异。']);
  admission.resolve(); await pending;
  assert.deepEqual(effects, ['收到，我会先核对口径，再整理差异。', 'admitted']);
});

test('a server-resolved canonical mention skips the engagement field but still needs handling', async () => {
  const participantId = 'pet:a%28b%29';
  const base = { pet: pet('a(b)'), context: { messages: [], members: [{ kind: 'pet' as const, id: 'a(b)', participantId }] } };
  const named = message('2', { mentions: [{ participantId, label: 'not the current label' }] });
  const addressedInput = { ...base, message: named };
  const addressedOutput = { action: 'ignore', reply: 'I am here.', intent: '', readProgress: false };
  for (const method of ['jsonSchema', 'functionCalling'] as const) {
    const mock = mockEndpoint([structured(addressedOutput, method)], method);
    assert.deepEqual(await createHeadDecision(mock.endpoint)({ ...addressedInput, addressed: isHeadAddressed(addressedInput) }, new AbortController().signal), addressedOutput);
    assert.equal(mock.calls.length, 1);
    const schema = mock.schema();
    assert.deepEqual((schema as { required: string[] }).required, ['action', 'reply', 'intent', 'readProgress']);
  }
  const matchingLabelOnly = message('3', { body: '@a(b)', mentions: [{ participantId: 'pet:other', label: 'a(b)' }] });
  const decline = { action: 'ignore', reply: '', intent: '', readProgress: false, engage: false };
  const mock = mockEndpoint([structured(decline)]);
  const lookalike = { ...base, context: { ...base.context, messages: [named] }, message: matchingLabelOnly };
  assert.deepEqual(await createHeadDecision(mock.endpoint)({ ...lookalike, addressed: isHeadAddressed(lookalike) }, new AbortController().signal), decline);
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
    assert.deepEqual(JSON.parse((mock.calls[0]!.messages as string[][])[1]![1]!), input);
    assert.equal(mock.binding(), undefined);
  }
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
  const result = { action: 'ignore', reply: '', intent: '', engage: true, readProgress: true };
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
  let replies = 0;
  const intents: string[] = [];
  const handler = createPetHead({ pet: pet('a'),
    channel: { subscribe: () => () => {}, readContext: async () => ({ messages: [original], referencedMessage: original }),
      reply: async () => { replies++; }, dispatch: async (_pet, source, request) => { assert.equal(source, inquiry); intents.push(request); } },
    readActiveDispatch: () => ({ dispatchId, messageId: original.messageId, sessionId: 'same-session' }),
    decide: async () => ({ action: 'dispatch', reply: '', intent: 'Summarize the calendar.', readProgress: true }),
    progress: {
      readRun: () => ({ invocationId: dispatchId, requestId, sessionId: 'same-session' }),
      readSessionRunId: async id => { assert.equal(id, 'same-session'); reads++; return requestId; },
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
  assert.equal(replies, 0);
  assert.deepEqual(intents, ['Summarize the calendar.']);
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
    readActiveDispatch: () => ({ dispatchId: 'd', messageId: source.messageId, sessionId: 's' }),
    decide: async () => ({ action: 'ignore', reply: '', intent: '', readProgress: true }),
    progress: {
      readRun: () => ({ invocationId: 'd', sessionId: 's', requestId: 'r' }),
      readSessionRunId: async () => { reads++; return undefined; },
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
