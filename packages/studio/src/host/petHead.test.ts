import assert from 'node:assert/strict';
import { AIMessage, AIMessageChunk } from '@langchain/core/messages';
import test from 'node:test';
import { bindPetHeadChannel, createPetHead, isHeadAddressed, readHeadDispatchQueueSnapshot, type HeadMessage, type PetHeadChannel } from './petHead';
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
const toolsUnsupported = () => Object.assign(new Error('private provider payload'), { status: 400, code: 'unsupported_parameter', param: 'tools' });
const decisionInput = { pet: pet('a'), message: message('1'), context: { messages: [] } };
const raw = (value: unknown) => new AIMessage(JSON.stringify(value));
const tool = (args: Record<string, unknown>, name = 'pet_head_decision') => new AIMessage({ content: '', tool_calls: [{ name, args }] });
function mockEndpoint(outputs: unknown[], method?: string, hasTools = true) {
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
      ...(hasTools ? { bindTools: (...args: unknown[]) => { binding = args; return { invoke: invoke('tool') }; } } : {}),
      withStructuredOutput: (value: unknown, options: unknown) => { schema = value; binding = options; return { invoke: invoke('structured') }; },
      invoke: invoke('json'),
    }; } };
  return { endpoint: endpoint as never, calls, schema: () => schema, binding: () => binding, factory: () => factory, factoryCalls: () => factoryCalls };
}
test('single declared decision tool has no forced choice, no tool execution and no SDK retries', async () => {
  for (const method of [undefined, 'functionCalling', 'jsonMode', 'jsonSchema']) {
    const mock = mockEndpoint([tool({ reply: '', action: 'dispatch', intent: 'Address source', engage: true, readProgress: false })], method);
    const events: unknown[] = [];
    const decide = createHeadDecision(mock.endpoint, { onDiagnostic: event => events.push(event) });
    const signal = new AbortController().signal;
    assert.deepEqual(await decide(decisionInput, signal), { reply: '', action: 'dispatch', intent: 'Address source', engage: true, readProgress: false });
    assert.deepEqual(mock.factory(), { maxOutputTokens: 512, maxRetries: 0, preferDeterministic: true, streaming: false, purpose: 'pet-head' });
    assert.equal((mock.binding() as unknown[]).length, 1);
    assert.equal(mock.calls.length, 1);
    assert.equal(mock.calls[0]!.signal, signal);
    assert.deepEqual(JSON.parse((mock.calls[0]!.messages as string[][])[1]![1]!), decisionInput);
    assert.deepEqual(events, [{ petId: 'a', channelId: 'team', messageId: '1', attempts: 1, outcome: 'selected', action: 'dispatch' }]);
  }
});
test('explicit JSON schema capability inspects raw refusal and validates parsed output', async () => {
  const mock = mockEndpoint([{ raw: raw({ reply: '', action: 'ignore', intent: '', engage: true, readProgress: false }), parsed: { reply: '', action: 'ignore', intent: '', engage: true, readProgress: false } }], 'jsonSchema', false);
  assert.deepEqual(await createHeadDecision(mock.endpoint)(decisionInput, new AbortController().signal), { action: 'ignore', reply: '', intent: '', engage: true, readProgress: false });
  assert.deepEqual(mock.binding(), { name: 'pet_head_decision', method: 'jsonSchema', includeRaw: true });
});
test('known malformed output or explicit unsupported capability gets only one clean JSON fallback', async () => {
  const unsupported = Object.assign(new Error('private provider payload'), { status: 400, code: 'unsupported_parameter', param: 'tools' });
  for (const first of [raw({ reply: '', action: 'ignore', intent: 'not empty', engage: true, readProgress: false }), raw({ reply: '', action: 'dispatch', intent: 'ok', extra: true, engage: true, readProgress: false }), unsupported]) {
    const mock = mockEndpoint([first, raw({ reply: '', action: 'ignore', intent: '', engage: true, readProgress: false })]);
    assert.deepEqual(await createHeadDecision(mock.endpoint)(decisionInput, new AbortController().signal), { action: 'ignore', reply: '', intent: '', engage: true, readProgress: false });
    assert.deepEqual(mock.calls.map(call => call.mode), ['tool', 'json']);
    assert.deepEqual((mock.calls[0]!.messages as unknown[])[1], (mock.calls[1]!.messages as unknown[])[1], 'original input is preserved');
    assert.equal(JSON.stringify(mock.calls[1]!.messages).includes('private provider payload'), false);
    assert.notDeepEqual(mock.calls[0]!.messages, mock.calls[1]!.messages, 'fallback requests a fresh JSON-only decision');
  }
});
test('a returned declaration with invalid arguments cannot retry as JSON or produce effects', async () => {
  const otherwiseValid = { action: 'dispatch', reply: 'I can look into that.', intent: 'Inspect the report.', engage: true, readProgress: false };
  const mock = mockEndpoint([tool({ ...otherwiseValid, intent: ' ' }), raw(otherwiseValid)]);
  const effects: string[] = [];
  const diagnostics: Array<{ outcome: string; code?: string }> = [];
  const handle = createPetHead({
    pet: pet('a'),
    channel: { subscribe: () => () => {}, readContext: async () => ({ messages: [] }),
      reply: async () => { effects.push('reply'); }, dispatch: async () => { effects.push('dispatch'); } },
    decide: createHeadDecision(mock.endpoint, { onDiagnostic: value => diagnostics.push(value) }),
  });
  await assert.rejects(handle(message('1'), new AbortController().signal), /Invalid Pet Head decision/);
  assert.deepEqual(mock.calls.map(call => call.mode), ['tool']);
  assert.deepEqual(diagnostics.map(({ outcome, code }) => [outcome, code]), [['error', 'invalid_tool']]);
  assert.deepEqual(effects, []);
});

test('unknown tools, multiple calls, refusal, truncation and provider failures never fall back', async () => {
  for (const output of [tool({ reply: '', action: 'ignore', intent: '', engage: true, readProgress: false }, 'unknown'),
    new AIMessage({ content: '', tool_calls: [...tool({}).tool_calls!, ...tool({}).tool_calls!] }),
    new AIMessage({ content: '', invalid_tool_calls: [{ name: 'pet_head_decision', args: '{' }] }),
    new AIMessage({ content: 'valid-looking text', additional_kwargs: { refusal: 'private' } }),
    new AIMessage({ content: 'valid-looking text', response_metadata: { finish_reason: 'length' } }),
    new AIMessage({ content: [{ type: 'refusal', refusal: 'private' }] }),
    Object.assign(new Error('private auth'), { status: 401 }), new Error('private network'),
    Object.assign(new Error('private runtime'), { status: 400, code: 'invalid_request_error' })]) {
    const mock = mockEndpoint([output]);
    const events: unknown[] = [];
    await assert.rejects(createHeadDecision(mock.endpoint, { onDiagnostic: event => events.push(event) })(decisionInput, new AbortController().signal), { message: 'Invalid Pet Head decision.' });
    assert.equal(mock.calls.length, 1);
    assert.equal(JSON.stringify(events).includes('private'), false);
  }
});
test('strict validation never guesses an action and the two-call ceiling is absolute', async () => {
  for (const value of [null, {}, { action: 'ignore' }, { reply: '', action: 'dispatch', intent: 42, engage: true, readProgress: false }, { reply: '', action: 'route', intent: 'x', engage: true, readProgress: false }, { reply: '', action: 'ignore', intent: '', other: true, engage: true, readProgress: false }]) {
    const mock = mockEndpoint([raw(value), raw(value), raw({ reply: '', action: 'ignore', intent: '', engage: true, readProgress: false })]);
    await assert.rejects(createHeadDecision(mock.endpoint)(decisionInput, new AbortController().signal));
    assert.equal(mock.calls.length, 2);
  }
});
test('abort before or during provider work prevents fallback and selection', async () => {
  for (const before of [true, false]) {
    const controller = new AbortController();
    const mock = mockEndpoint([() => { controller.abort(); return raw({ reply: '', action: 'ignore', intent: '', engage: true, readProgress: false }); }]);
    if (before) controller.abort();
    const events: Array<{ outcome: string; code?: string }> = [];
    await assert.rejects(createHeadDecision(mock.endpoint, { onDiagnostic: event => events.push(event) })(decisionInput, controller.signal));
    assert.equal(mock.calls.length, before ? 0 : 1);
    assert.equal(events[0]?.code, 'aborted');
  }
});

test('configured JSON mode is used once when the provider specifically rejects tools', async () => {
  const value = { reply: '', action: 'dispatch', intent: 'Inspect the source', engage: true, readProgress: false };
  const mock = mockEndpoint([toolsUnsupported(), { raw: raw(value), parsed: value }], 'jsonMode');
  assert.deepEqual(await createHeadDecision(mock.endpoint)(decisionInput, new AbortController().signal), value);
  assert.deepEqual(mock.calls.map(call => call.mode), ['tool', 'structured']);
  assert.deepEqual(mock.binding(), { name: 'pet_head_decision', method: 'jsonMode', includeRaw: true });
});

test('without tool binding or declared structured transport the Head uses conservative plain JSON', async () => {
  let calls = 0;
  const endpoint = { createChatModel: () => ({ invoke: async () => { calls++; return raw({ reply: '', action: 'ignore', intent: '', engage: true, readProgress: false }); } }) };
  assert.deepEqual(await createHeadDecision(endpoint as never)(decisionInput, new AbortController().signal), { action: 'ignore', reply: '', intent: '', engage: true, readProgress: false });
  assert.equal(calls, 1);
});

test('structured parsing failure retries once but raw refusal never does', async () => {
  const bad = { raw: new AIMessage('broken'), parsed: null, parsing_error: new Error('private parsing detail') };
  const mock = mockEndpoint([bad, raw({ reply: '', action: 'ignore', intent: '', engage: true, readProgress: false })], 'jsonMode', false);
  assert.deepEqual(await createHeadDecision(mock.endpoint)(decisionInput, new AbortController().signal), { action: 'ignore', reply: '', intent: '', engage: true, readProgress: false });
  assert.deepEqual(mock.calls.map(call => call.mode), ['structured', 'json']);
  const refused = mockEndpoint([{ raw: new AIMessage({ content: '', response_metadata: { stop_reason: 'refusal' } }), parsed: { reply: '', action: 'ignore', intent: '', engage: true, readProgress: false } }], 'jsonSchema', false);
  await assert.rejects(createHeadDecision(refused.endpoint)(decisionInput, new AbortController().signal));
  assert.equal(refused.calls.length, 1);
});

test('scheduling snapshot admits only exact owning Channel sources, never names or foreign scopes', () => {
  const entry = { dispatchId: 'running', enqueuedAt: 'now', sessionId: 'session', scope: { namespace: 'channel', id: 'team' }, origin: { namespace: 'channel', id: 'original' } };
  const result = readHeadDispatchQueueSnapshot('a', 'team', [{ petId: 'a', state: 'busy', activeOperation: 'dispatch', queuedConversations: 0, queuedDispatches: 3,
    activeDispatch: entry, entries: [{ ...entry, dispatchId: 'next' }, { ...entry, scope: { namespace: 'channel', id: 'other' } }, { ...entry, origin: undefined }] }]);
  assert.deepEqual(result, { active: { dispatchId: 'running', sessionId: 'session', messageId: 'original' }, pending: [{ dispatchId: 'next', sessionId: 'session', messageId: 'original' }] });
});

test('the active source can be loaded from the Channel if it aged out of the current context', async () => {
  const scheduling = { active: { dispatchId: 'old', sessionId: 'session', messageId: 'original' }, pending: [] };
  const original = message('original', { body: 'Calculate using the measured units.' });
  let calls = 0;
  const handler = createPetHead({ pet: pet('a'), readScheduling: () => scheduling,
    channel: { subscribe: () => () => {}, reply: async () => { throw new Error('no direct reply'); },
      readContext: async (_pet, _before, reference) => ({ messages: [], ...(reference === 'original' ? { referencedMessage: original } : {}) }),
      dispatch: async () => { throw new Error('no execution'); } },
    decide: async input => {
      calls++;
      assert.deepEqual(input.activeSource, original);
      assert.equal(input.scheduling?.active?.dispatchId, 'old');
      return { engage: false, reply: '', action: 'ignore', intent: '', readProgress: false };
    } });
  await handler(message('2'), new AbortController().signal);
  assert.equal(calls, 1);
});

test('tool and JSON transports accept every independent reply/execution combination', async () => {
  for (const method of ['functionCalling', 'jsonMode']) for (const action of ['ignore', 'dispatch'] as const) for (const reply of ['', 'I can look into this.']) {
    const decision = { action, reply, intent: action === 'dispatch' ? 'Investigate the source' : '', engage: true, readProgress: false };
    const mock = mockEndpoint([method === 'jsonMode' ? { raw: raw(decision), parsed: decision } : tool(decision)], method, method !== 'jsonMode');
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
    const mock = mockEndpoint([raw(value), raw(value)]);
    await assert.rejects(createHeadDecision(mock.endpoint)(decisionInput, new AbortController().signal));
    assert.equal(mock.calls.length, 2);
  }
});

test('tool and structured JSON expose the same independent reply and execution schema', async () => {
  const value = { action: 'dispatch', reply: '收到，我会先核对口径，再整理差异。', intent: 'Compare both datasets using equivalent definitions.', engage: true, readProgress: false };
  const toolModel = mockEndpoint([tool(value)], 'functionCalling');
  const jsonModel = mockEndpoint([{ raw: raw(value), parsed: value }], 'jsonSchema', false);
  for (const mock of [toolModel, jsonModel]) {
    assert.deepEqual(await createHeadDecision(mock.endpoint)(decisionInput, new AbortController().signal), value);
  }
  const declaration = (toolModel.binding() as Array<Array<{ function: { parameters: unknown } }>>)[0]![0]!.function.parameters;
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

test('JSON-mode system carries the same parseable field-policy schema as the decision tool', async () => {
  const value = { action: 'ignore', reply: '', intent: '', engage: true, readProgress: false };
  const models = [mockEndpoint([tool(value)], 'functionCalling'), mockEndpoint([{ raw: raw(value), parsed: value }], 'jsonMode', false)];
  for (const mock of models) await createHeadDecision(mock.endpoint)(decisionInput, new AbortController().signal);
  const declaration = (models[0]!.binding() as Array<Array<{ function: { parameters: unknown } }>>)[0]![0]!.function.parameters;
  for (const mock of models) {
    const system = (mock.calls[0]!.messages as Array<[string, string]>)[0]![1];
    const block = system.split('<decision_schema>\n')[1]?.split('\n</decision_schema>')[0];
    assert.ok(block);
    assert.deepEqual(JSON.parse(block), declaration);
  }
});

test('empty stop output is diagnosed separately from malformed, refusal, truncation and ignore', async () => {
  for (const mode of ['functionCalling', 'jsonMode']) for (const [content, finish, code, attempts] of [
    ['', 'stop', 'empty_output', 2], ['   ', 'stop', 'empty_output', 2], [[], 'stop', 'empty_output', 2],
    ['broken', 'stop', 'malformed', 2], ['', 'length', 'truncated', 1], ['', 'content_filter', 'refusal', 1],
  ] as const) {
    const response = new AIMessage({ content: typeof content === 'string' ? content : [], response_metadata: { finish_reason: finish } });
    const first = mode === 'jsonMode' ? { raw: response, parsed: null } : response;
    const mock = mockEndpoint([first, response], mode, mode !== 'jsonMode');
    const diagnostics: Array<{ outcome: string; code?: string }> = [];
    await assert.rejects(createHeadDecision(mock.endpoint, { onDiagnostic: value => diagnostics.push(value) })(decisionInput, new AbortController().signal));
    assert.equal(mock.calls.length, attempts);
    assert.deepEqual(diagnostics.map(item => [item.outcome, item.code]), [['error', code]]);
  }
  const ignore = { action: 'ignore', reply: '', intent: '', engage: true, readProgress: false };
  const mock = mockEndpoint([new AIMessage({ content: '', response_metadata: { finish_reason: 'stop' } }), raw(ignore)]);
  assert.deepEqual(await createHeadDecision(mock.endpoint)(decisionInput, new AbortController().signal), ignore);
  assert.equal(mock.calls.length, 2);
});

test('a server-resolved canonical mention skips the engagement field but still needs handling', async () => {
  const participantId = 'pet:a%28b%29';
  const base = { pet: pet('a(b)'), context: { messages: [], members: [{ kind: 'pet' as const, id: 'a(b)', participantId }] } };
  const named = message('2', { mentions: [{ participantId, label: 'not the current label' }] });
  const addressedInput = { ...base, message: named };
  const addressedOutput = { action: 'ignore', reply: 'I am here.', intent: '', readProgress: false };
  for (const method of ['jsonSchema', 'functionCalling'] as const) {
    const mock = mockEndpoint([method === 'functionCalling' ? tool(addressedOutput) : { raw: raw(addressedOutput), parsed: addressedOutput }], method, method === 'functionCalling');
    assert.deepEqual(await createHeadDecision(mock.endpoint)({ ...addressedInput, addressed: isHeadAddressed(addressedInput) }, new AbortController().signal), addressedOutput);
    assert.equal(mock.calls.length, 1);
    const schema = method === 'jsonSchema' ? mock.schema() : (mock.binding() as Array<Array<{ function: { parameters: unknown } }>>)[0]![0]!.function.parameters;
    assert.deepEqual((schema as { required: string[] }).required, ['action', 'reply', 'intent', 'readProgress']);
  }
  const matchingLabelOnly = message('3', { body: '@a(b)', mentions: [{ participantId: 'pet:other', label: 'a(b)' }] });
  const decline = { action: 'ignore', reply: '', intent: '', readProgress: false, engage: false };
  const mock = mockEndpoint([tool(decline)]);
  const lookalike = { ...base, context: { ...base.context, messages: [named] }, message: matchingLabelOnly };
  assert.deepEqual(await createHeadDecision(mock.endpoint)({ ...lookalike, addressed: isHeadAddressed(lookalike) }, new AbortController().signal), decline);
});

test('progress composition accepts only a reply and never binds tools or retries', async () => {
  const input = { message: message('4'), evidence: { status: 'unavailable' as const } };
  for (const reply of ['I cannot confirm that yet.', '']) {
    const mock = mockEndpoint([new AIMessage(reply)], 'functionCalling');
    assert.equal(await createHeadModel(() => mock.endpoint).composeReply(input, new AbortController().signal), reply);
    assert.deepEqual(mock.calls.map(call => call.mode), ['json']);
    assert.deepEqual(JSON.parse((mock.calls[0]!.messages as string[][])[1]![1]!), input);
    assert.equal(mock.binding(), undefined);
  }
  for (const output of [
    tool({ reply: 'Done' }),
    raw({ reply: 'Okay', action: 'dispatch', intent: 'Unrelated' }),
    raw([{ action: 'dispatch', intent: 'Unrelated' }]),
    new AIMessage({ content: [{ type: 'tool_use', name: 'dispatch' }] }),
    new AIMessage({ content: 'Maybe', response_metadata: { finish_reason: 'length' } }),
  ]) {
    const mock = mockEndpoint([output], 'functionCalling');
    await assert.rejects(createHeadModel(() => mock.endpoint).composeReply(input, new AbortController().signal), /Invalid Pet Head progress reply/);
    assert.deepEqual(mock.calls.map(call => call.mode), ['json']);
  }
});

test('decision binding and unbound plain reply share one lazily resolved model client', async () => {
  const result = { action: 'ignore', reply: '', intent: '', engage: true, readProgress: true };
  const mock = mockEndpoint([tool(result), new AIMessage({
    content: [{ type: 'reasoning', reasoning: 'private analysis' }, { type: 'text', text: ' [Known update](https://example.test) ' }],
  }), tool(result)], 'jsonMode');
  let resolved = 0;
  const model = createHeadModel(() => { resolved++; return mock.endpoint; });
  assert.equal(resolved, 0);
  assert.equal(mock.factoryCalls(), 0);
  const signal = new AbortController().signal;
  assert.deepEqual(await model.decide(decisionInput, signal), result);
  assert.equal(await model.composeReply({ message: decisionInput.message, evidence: { status: 'unavailable' } }, signal),
    '[Known update](https://example.test)');
  assert.deepEqual(await model.decide(decisionInput, signal), result);
  assert.deepEqual(mock.calls.map(call => call.mode), ['tool', 'json', 'tool']);
  assert.equal(resolved, 1);
  assert.equal(mock.factoryCalls(), 1);
});

test('normalizing AIMessage text cannot hide a refusal or disguised tool payload', async () => {
  const safe = { action: 'ignore', reply: '', intent: '', engage: true, readProgress: false };
  const shown = JSON.stringify(safe);
  const refusal = new AIMessage({ content: [{ type: 'text', text: shown }, { type: 'refusal', refusal: 'private' }],
    response_metadata: { model_provider: 'openai' } });
  const legacyTool = new AIMessage({ content: shown, tool_calls: [], additional_kwargs: { function_call: { name: 'pet_head_decision', arguments: '{}' } } });
  const undecoded = new AIMessage({ content: shown, tool_calls: [], additional_kwargs: { tool_calls: [
    { id: 'unparsed', type: 'function', function: { name: 'pet_head_decision', arguments: '{}' } },
  ] } });
  const rawTool = new AIMessage({ content: [{ type: 'tool_use', id: 'native', name: 'pet_head_decision', input: {} }, { type: 'text', text: shown }], response_metadata: { model_provider: 'openai' } });
  for (const unsafe of [refusal, legacyTool, undecoded, rawTool]) {
    assert.equal(unsafe.text, shown, 'LangChain text projection by itself is insufficient');
    const mock = mockEndpoint([unsafe, raw(safe)]);
    await assert.rejects(createHeadDecision(mock.endpoint)(decisionInput, new AbortController().signal));
    assert.deepEqual(mock.calls.map(call => call.mode), ['tool']);
  }
});

test('JSON compatibility is exact, while unbound reply accepts valid LangChain chunks', async () => {
  const valid = { action: 'ignore', reply: '', intent: '', engage: true, readProgress: false };
  const serialized = JSON.stringify(valid);
  for (const invalid of [
    new AIMessage({ content: [{ type: 'text', text: serialized.slice(0,6) }, { type: 'text', text: serialized.slice(6) }] }),
    new AIMessage('Here is the decision: ' + serialized),
    new AIMessage('```json\n' + serialized + '\n```'),
  ]) {
    const mock = mockEndpoint([invalid, invalid]);
    await assert.rejects(createHeadDecision(mock.endpoint)(decisionInput, new AbortController().signal));
    assert.deepEqual(mock.calls.map(call => call.mode), ['tool', 'json']);
  }
  const input = { message: message('4'), evidence: { status: 'unavailable' as const } };
  const unknown = new AIMessage({ content: [{ type: 'text', text: 'Looks safe' }, { type: 'unsupported', value: 'hidden' }] });
  const refusal = new AIMessage({ content: [{ type: 'text', text: 'Looks safe' }, { type: 'refusal', refusal: 'hidden' }],
    response_metadata: { model_provider: 'openai' } });
  const image = new AIMessage({ content: [{ type: 'image_url', image_url: { url: 'https://example.test/fixture.png' } },
    { type: 'text', text: 'Looks safe' }], response_metadata: { model_provider: 'openai' } });
  const coercedText = new AIMessage({ content: [{ type: 'text', text: 42 } as never], response_metadata: { model_provider: 'openai' } });
  const signal = new AbortController().signal;
  for (const unsafe of [unknown, refusal, image, coercedText]) {
    const mock = mockEndpoint([unsafe]);
    await assert.rejects(createHeadModel(() => mock.endpoint).composeReply(input, signal), /Invalid Pet Head progress reply/);
    assert.deepEqual(mock.calls.map(call => call.mode), ['json']);
  }
  for (const message of [
    new AIMessageChunk('No current result.'),
    new AIMessage({ content: [{ type: 'redacted_thinking', data: 'do not publish' }, { type: 'text', text: 'No current result.' }],
      response_metadata: { model_provider: 'anthropic' } }),
    new AIMessage({ contentBlocks: [{ type: 'non_standard', value: { type: 'redacted_thinking', data: 'do not publish' } },
      { type: 'text', text: 'No current result.' }] }),
  ]) {
    assert.equal(await createHeadModel(() => mockEndpoint([message]).endpoint).composeReply(input, signal), 'No current result.');
  }
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
    readScheduling: () => ({ active: { dispatchId, messageId: original.messageId, sessionId: 'same-session' }, pending: [] }),
    decide: async () => ({ action: 'dispatch', reply: '', intent: 'Summarize the calendar.', readProgress: true }),
    progress: {
      readRun: () => ({ invocationId: dispatchId, requestId, sessionId: 'same-session', publishedIds: [] }),
      snapshot: async id => {
        reads++;
        return { session: { sessionId: id, activeRun: { requestId, state: 'running' }, timeline: [] } } as unknown as Awaited<ReturnType<import('../studioContract').StudioPetSessions['snapshot']>>;
      },
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
    readScheduling: () => ({ active: { dispatchId: 'd', messageId: source.messageId, sessionId: 's' }, pending: [] }),
    decide: async () => ({ action: 'ignore', reply: '', intent: '', readProgress: true }),
    progress: {
      readRun: () => ({ invocationId: 'd', sessionId: 's', requestId: 'r', publishedIds: [] }),
      snapshot: async () => { reads++; return undefined; },
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
