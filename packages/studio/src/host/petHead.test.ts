import assert from 'node:assert/strict';
import test from 'node:test';
import { bindPetHeadChannel, createHeadDecision, createPetHead, readHeadSchedulingSnapshot, type HeadMessage, type PetHeadChannel } from './petHead';
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
    decide: async input => { seen.push({ petId: input.pet.petId, message: input.message }); return { action: 'ignore', reply: '', intent: '', timing: 'enqueue' }; },
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
    decide: async input => { seen.push(input.message); return { action: 'ignore', reply: '', intent: '', timing: 'enqueue' }; },
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
      decide: async () => ({ action, reply, intent: action === 'dispatch' ? 'Do the work' : '', timing: 'enqueue' }),
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
      decide: async () => ({ action: 'dispatch', reply: 'I can look into this.', intent: 'Inspect source', timing: 'enqueue' }),
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
  pending.resolve({ action: 'dispatch', reply: 'late', intent: 'late work', timing: 'enqueue' });
  await run;
  assert.deepEqual(effects, []);
});

test('cancellation during publication prevents execution admission', async () => {
  const controller = new AbortController();
  let admissions = 0;
  const handler = createPetHead({ pet: pet('a'),
    channel: { subscribe: () => () => {}, readContext: async () => ({ messages: [] }),
      reply: async () => { controller.abort(); }, dispatch: async () => { admissions++; } },
    decide: async () => ({ action: 'dispatch', reply: 'Acknowledged', intent: 'Work', timing: 'enqueue' }),
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
    decide: async () => { decisions++; return { action: 'ignore', reply: '', intent: '', timing: 'enqueue' }; },
  }, events);
  const pending = events.publish(message('1'));
  await started.promise;
  unsubscribe();
  context.resolve({ messages: [] });
  await pending;
  assert.equal(decisions, 0);
});

const decisionInput = { pet: pet('a'), message: message('1'), context: { messages: [] } };
const raw = (value: unknown) => ({ content: JSON.stringify(value) });
const tool = (args: unknown, name = 'pet_head_decision') => ({ content: '', tool_calls: [{ name, args }] });
function mockEndpoint(outputs: unknown[], method?: string) {
  const calls: Array<{ mode: string; messages: unknown; signal: unknown }> = [];
  let binding: unknown;
  let factory: unknown;
  const invoke = (mode: string) => async (messages: unknown, config: { signal: AbortSignal }) => {
    calls.push({ mode, messages, signal: config.signal });
    const value = outputs.shift();
    if (value instanceof Error) throw value;
    if (typeof value === 'function') return value();
    return value;
  };
  const endpoint = { profileId: 'test', baseUrl: 'https://example.test', apiKey: 'secret', model: 'test', structuredOutputMethod: method,
    createChatModel: (options: unknown) => { factory = options; return {
      bindTools: (...args: unknown[]) => { binding = args; return { invoke: invoke('tool') }; },
      withStructuredOutput: (_schema: unknown, options: unknown) => { binding = options; return { invoke: invoke('structured') }; },
      invoke: invoke('json'),
    }; } };
  return { endpoint: endpoint as never, calls, binding: () => binding, factory: () => factory };
}
test('single declared decision tool has no forced choice, no tool execution and no SDK retries', async () => {
  for (const method of [undefined, 'functionCalling']) {
    const mock = mockEndpoint([tool({ reply: '', action: 'dispatch', intent: 'Address source', timing: 'enqueue' })], method);
    const events: unknown[] = [];
    const decide = createHeadDecision(mock.endpoint, { onDiagnostic: event => events.push(event) });
    const signal = new AbortController().signal;
    assert.deepEqual(await decide(decisionInput, signal), { reply: '', action: 'dispatch', intent: 'Address source', timing: 'enqueue' });
    assert.deepEqual(mock.factory(), { maxOutputTokens: 512, maxRetries: 0, preferDeterministic: true, streaming: false });
    assert.equal((mock.binding() as unknown[]).length, 1);
    assert.equal(mock.calls.length, 1);
    assert.equal(mock.calls[0]!.signal, signal);
    assert.deepEqual(JSON.parse((mock.calls[0]!.messages as string[][])[1]![1]!), decisionInput);
    assert.deepEqual(events, [{ petId: 'a', channelId: 'team', messageId: '1', attempts: 1, outcome: 'selected', action: 'dispatch' }]);
  }
});
test('explicit JSON schema capability inspects raw refusal and validates parsed output', async () => {
  const mock = mockEndpoint([{ raw: raw({ reply: '', action: 'ignore', intent: '', timing: 'enqueue' }), parsed: { reply: '', action: 'ignore', intent: '', timing: 'enqueue' } }], 'jsonSchema');
  assert.deepEqual(await createHeadDecision(mock.endpoint)(decisionInput, new AbortController().signal), { action: 'ignore', reply: '', intent: '', timing: 'enqueue' });
  assert.deepEqual(mock.binding(), { name: 'pet_head_decision', method: 'jsonSchema', includeRaw: true });
});
test('known malformed output or explicit unsupported capability gets only one clean JSON fallback', async () => {
  const unsupported = Object.assign(new Error('private provider payload'), { status: 400, code: 'unsupported_parameter', param: 'tools' });
  for (const first of [tool({ reply: '', action: 'dispatch', intent: ' ', timing: 'enqueue' }), raw({ reply: '', action: 'ignore', intent: 'not empty', timing: 'enqueue' }), raw({ reply: '', action: 'dispatch', intent: 'ok', extra: true, timing: 'enqueue' }), unsupported]) {
    const mock = mockEndpoint([first, raw({ reply: '', action: 'ignore', intent: '', timing: 'enqueue' })]);
    assert.deepEqual(await createHeadDecision(mock.endpoint)(decisionInput, new AbortController().signal), { action: 'ignore', reply: '', intent: '', timing: 'enqueue' });
    assert.deepEqual(mock.calls.map(call => call.mode), ['tool', 'json']);
    assert.deepEqual((mock.calls[0]!.messages as unknown[])[1], (mock.calls[1]!.messages as unknown[])[1], 'original input is preserved');
    assert.equal(JSON.stringify(mock.calls[1]!.messages).includes('private provider payload'), false);
    assert.notDeepEqual(mock.calls[0]!.messages, mock.calls[1]!.messages, 'fallback requests a fresh JSON-only decision');
  }
});
test('unknown tools, multiple calls, refusal, truncation and provider failures never fall back', async () => {
  for (const output of [tool({ reply: '', action: 'ignore', intent: '', timing: 'enqueue' }, 'unknown'),
    { content: '', tool_calls: [...tool({}).tool_calls, ...tool({}).tool_calls] },
    { content: '', invalid_tool_calls: [{}] },
    { ...raw({ reply: '', action: 'ignore', intent: '', timing: 'enqueue' }), additional_kwargs: { refusal: 'private' } },
    { ...raw({ reply: '', action: 'ignore', intent: '', timing: 'enqueue' }), response_metadata: { finish_reason: 'length' } },
    { content: [{ type: 'refusal', refusal: 'private' }] },
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
  for (const value of [null, {}, { action: 'ignore' }, { reply: '', action: 'dispatch', intent: 42, timing: 'enqueue' }, { reply: '', action: 'route', intent: 'x', timing: 'enqueue' }, { reply: '', action: 'ignore', intent: '', other: true, timing: 'enqueue' }]) {
    const mock = mockEndpoint([raw(value), raw(value), raw({ reply: '', action: 'ignore', intent: '', timing: 'enqueue' })]);
    await assert.rejects(createHeadDecision(mock.endpoint)(decisionInput, new AbortController().signal));
    assert.equal(mock.calls.length, 2);
  }
});
test('abort before or during provider work prevents fallback and selection', async () => {
  for (const before of [true, false]) {
    const controller = new AbortController();
    const mock = mockEndpoint([() => { controller.abort(); return raw({ reply: '', action: 'ignore', intent: '', timing: 'enqueue' }); }]);
    if (before) controller.abort();
    const events: Array<{ outcome: string; code?: string }> = [];
    await assert.rejects(createHeadDecision(mock.endpoint, { onDiagnostic: event => events.push(event) })(decisionInput, controller.signal));
    assert.equal(mock.calls.length, before ? 0 : 1);
    assert.equal(events[0]?.code, 'aborted');
  }
});

test('explicit JSON mode is preserved even when the adapter exposes tools', async () => {
  const value = { reply: '', action: 'dispatch', intent: 'Inspect the source', timing: 'enqueue' };
  const mock = mockEndpoint([{ raw: raw(value), parsed: value }], 'jsonMode');
  assert.deepEqual(await createHeadDecision(mock.endpoint)(decisionInput, new AbortController().signal), value);
  assert.deepEqual(mock.calls.map(call => call.mode), ['structured']);
  assert.deepEqual(mock.binding(), { name: 'pet_head_decision', method: 'jsonMode', includeRaw: true });
});

test('without tool binding or declared structured transport the Head uses conservative plain JSON', async () => {
  let calls = 0;
  const endpoint = { createChatModel: () => ({ invoke: async () => { calls++; return raw({ reply: '', action: 'ignore', intent: '', timing: 'enqueue' }); } }) };
  assert.deepEqual(await createHeadDecision(endpoint as never)(decisionInput, new AbortController().signal), { action: 'ignore', reply: '', intent: '', timing: 'enqueue' });
  assert.equal(calls, 1);
});

test('structured parsing failure retries once but raw refusal never does', async () => {
  const bad = { raw: { content: 'broken' }, parsed: null, parsing_error: new Error('private parsing detail') };
  const mock = mockEndpoint([bad, raw({ reply: '', action: 'ignore', intent: '', timing: 'enqueue' })], 'jsonMode');
  assert.deepEqual(await createHeadDecision(mock.endpoint)(decisionInput, new AbortController().signal), { action: 'ignore', reply: '', intent: '', timing: 'enqueue' });
  assert.deepEqual(mock.calls.map(call => call.mode), ['structured', 'json']);
  const refused = mockEndpoint([{ raw: { content: '', response_metadata: { stop_reason: 'refusal' } }, parsed: { reply: '', action: 'ignore', intent: '', timing: 'enqueue' } }], 'jsonSchema');
  await assert.rejects(createHeadDecision(refused.endpoint)(decisionInput, new AbortController().signal));
  assert.equal(refused.calls.length, 1);
});

test('scheduling snapshot admits only exact owning Channel sources, never names or foreign scopes', () => {
  const entry = { dispatchId: 'running', enqueuedAt: 'now', sessionId: 'session', scope: { namespace: 'channel', id: 'team' }, origin: { namespace: 'channel', id: 'original' } };
  const result = readHeadSchedulingSnapshot('a', 'team', [{ petId: 'a', state: 'busy', activeOperation: 'dispatch', queuedConversations: 0, queuedDispatches: 3,
    activeDispatch: entry, entries: [{ ...entry, dispatchId: 'next' }, { ...entry, scope: { namespace: 'channel', id: 'other' } }, { ...entry, origin: undefined }] }]);
  assert.deepEqual(result, { active: { dispatchId: 'running', sessionId: 'session', messageId: 'original' }, pending: [{ dispatchId: 'next', sessionId: 'session', messageId: 'original' }] });
});

test('tool and JSON decisions separately validate participation and timing for either author', async () => {
  for (const kind of ['human', 'pet'] as const) for (const timing of ['enqueue', 'interrupt'] as const) for (const mode of ['functionCalling', 'jsonMode']) {
    const value = { reply: '', action: 'dispatch', intent: timing === 'interrupt' ? 'Correct the invalid units, then address the original calculation.' : 'Add the nonblocking illustration after the current explanation.', timing };
    const mock = mockEndpoint([mode === 'jsonMode' ? { raw: raw(value), parsed: value } : tool(value)], mode);
    const result = await createHeadDecision(mock.endpoint)({ ...decisionInput, message: message('2', { author: { kind, id: 'source' } }) }, new AbortController().signal);
    assert.deepEqual(result, value);
  }
  for (const value of [{ reply: '', action: 'ignore', intent: '', timing: 'interrupt' }, { reply: '', action: 'dispatch', intent: 'work' }, { reply: '', action: 'dispatch', intent: 'work', timing: 'urgent' }]) {
    const mock = mockEndpoint([raw(value), raw(value)]);
    await assert.rejects(createHeadDecision(mock.endpoint)(decisionInput, new AbortController().signal));
    assert.equal(mock.calls.length, 2);
  }
});

test('modeled interrupt preserves exact source and safely queues; stale snapshots never cancel a different run', async () => {
  for (const stale of [false, true]) for (const author of ['human', 'pet'] as const) {
    let snapshot = { active: { dispatchId: 'old', sessionId: 'session', messageId: 'original' }, pending: [] };
    const original = message('original', { body: 'Calculate using the measured units.' });
    const source = message('2', { author: { kind: author, id: 'source' }, body: 'The original units were wrong.' });
    const effects: unknown[][] = [];
    const decisions: unknown[] = [];
    const handler = createPetHead({ pet: pet('a'), readScheduling: () => structuredClone(snapshot), onScheduling: event => decisions.push(event),
      channel: { subscribe: () => () => {}, reply: async () => { throw new Error('no direct reply'); },
        readContext: async (_pet, _before, reference) => ({ messages: [], ...(reference === 'original' ? { referencedMessage: original } : {}) }),
        dispatch: async (...args) => { effects.push(args); } },
      decide: async input => {
        assert.deepEqual(input.activeSource, original);
        assert.equal(input.scheduling?.active?.dispatchId, 'old');
        if (stale) snapshot = { ...snapshot, active: { ...snapshot.active, dispatchId: 'new' } };
        return { reply: '', action: 'dispatch', intent: 'Correct units and finish the original calculation.', timing: 'interrupt' };
      } });
    await handler(source, new AbortController().signal);
    assert.equal(effects.length, 1);
    assert.equal(effects[0]!.length, 4, 'no trusted interrupt delivery is passed');
    assert.equal(effects[0]![1], source);
    assert.deepEqual(decisions, [{ petId: 'a', channelId: 'team', messageId: '2', requested: 'interrupt', effective: 'enqueue', reason: stale ? 'stale_snapshot' : 'continuation_unavailable', activeDispatchId: 'old' }]);
  }
});

test('tool and JSON transports accept every independent reply/execution combination', async () => {
  for (const method of ['functionCalling', 'jsonMode']) for (const action of ['ignore', 'dispatch'] as const) for (const reply of ['', 'I can look into this.']) {
    const decision = { action, reply, intent: action === 'dispatch' ? 'Investigate the source' : '', timing: 'enqueue' };
    const mock = mockEndpoint([method === 'jsonMode' ? { raw: raw(decision), parsed: decision } : tool(decision)], method);
    const diagnostics: Array<{ outcome: string; action?: string }> = [];
    assert.deepEqual(await createHeadDecision(mock.endpoint, { onDiagnostic: value => diagnostics.push(value) })(decisionInput, new AbortController().signal), decision);
    assert.equal(mock.calls.length, 1);
    assert.equal(diagnostics[0]?.outcome, action === 'ignore' && !reply ? 'ignore' : 'selected');
  }
});

test('old schema, non-string reply and ignore carrying execution intent fail closed', async () => {
  for (const value of [
    { action: 'reply', text: 'old response', timing: 'enqueue' },
    { action: 'ignore', reply: 42, intent: '', timing: 'enqueue' },
    { action: 'ignore', reply: 'Ack', intent: 'Hidden work', timing: 'enqueue' },
    { action: 'dispatch', reply: 'Ack', intent: '', timing: 'enqueue' },
    { action: 'dispatch', reply: '', intent: 'Work', timing: 'enqueue', extra: true },
  ]) {
    const mock = mockEndpoint([raw(value), raw(value)]);
    await assert.rejects(createHeadDecision(mock.endpoint)(decisionInput, new AbortController().signal));
    assert.equal(mock.calls.length, 2);
  }
});
