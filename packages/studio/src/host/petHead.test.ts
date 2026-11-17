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
    decide: async input => { seen.push({ petId: input.pet.petId, message: input.message }); return { action: 'ignore' }; },
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
    decide: async input => { seen.push(input.message); return { action: 'ignore' }; },
  }, events);
  await events.publish(message('1', { author: { kind: 'pet', id: 'a' } }));
  await events.publish(message('2', { channelId: 'other' }));
  assert.deepEqual(seen, []);
  unsubscribe();
});

test('deactivation cancels an in-flight decision and produces no late reply or dispatch', async () => {
  for (const action of ['reply', 'dispatch'] as const) {
    const events = bus();
    const started = deferred<void>();
    const decision = deferred<{ action: typeof action; text: string }>();
    const effects: string[] = [];
    let observed: AbortSignal | undefined;
    const unsubscribe = activate({ pet: pet('a'),
      channel: { readContext: async () => ({ messages: [] }),
        reply: async () => { effects.push('reply'); }, dispatch: async () => { effects.push('dispatch'); } },
      decide: async (_input, signal) => { observed = signal; started.resolve(); return decision.promise; },
    }, events);
    const processing = events.publish(message('1'));
    await started.promise;
    unsubscribe();
    assert.equal(observed?.aborted, true);
    decision.resolve({ action, text: 'late' });
    await processing;
    assert.deepEqual(effects, []);
  }
});

test('reply and dispatch decisions use their own instance, message and cancellation signal', async () => {
  const events = bus();
  const calls: unknown[][] = [];
  let action: 'reply' | 'dispatch' = 'reply';
  const current = message('1', { replyTo: 'original', deliverables: [{ uri: 'https://example.test/file' }] });
  const context = { messages: [message('original')] };
  const inputs: unknown[] = [];
  const unsubscribe = activate({ pet: pet('a'), description: 'Instance description',
    channel: { readContext: async (...args) => { calls.push(['read', ...args]); return context; },
      reply: async (...args) => { calls.push(['reply', ...args]); }, dispatch: async (...args) => { calls.push(['dispatch', ...args]); } },
    decide: async input => { inputs.push(input); return { action, text: action === 'reply' ? 'Acknowledged' : 'Investigate' }; },
  }, events);
  await events.publish(current);
  assert.deepEqual(inputs[0], { pet: pet('a'), description: 'Instance description', message: current, context });
  assert.deepEqual(calls[1]?.slice(0, 3), ['dispatch', 'a', current]);
  assert.equal(calls.filter(call => call[0] === 'reply').length, 0);
  assert.ok(calls[1]?.[4] instanceof AbortSignal);
  action = 'dispatch';
  const taskMessage = message('2', { replyTo: '1', deliverables: [{ uri: 'https://example.test/file' }] });
  await events.publish(taskMessage);
  const dispatch = calls.filter(call => call[0] === 'dispatch').at(-1)!;
  assert.deepEqual(dispatch.slice(0, 4), ['dispatch', 'a', taskMessage, 'Investigate']);
  assert.ok(dispatch[4] instanceof AbortSignal);
  unsubscribe();
});

test('eligible peer responses execute even without mentions; ignored messages and self replies do not route', async () => {
  const events = bus();
  const petMessages = [message('1', { author: { kind: 'pet', id: 'b' } }),
    message('2', { author: { kind: 'pet', id: 'c' } })];
  const decisions: string[] = [];
  const replies: unknown[][] = [];
  const dispatches: unknown[][] = [];
  let action: 'ignore' | 'reply' | 'dispatch' = 'ignore';
  let text = 'Address the peer question';
  const unsubscribe = activate({ pet: pet('a'),
    channel: { readContext: async () => ({ messages: petMessages }),
      reply: async (...args) => { replies.push(args); }, dispatch: async (...args) => { dispatches.push(args); } },
    decide: async input => { decisions.push(input.message.messageId); return action === 'ignore' ? { action } : { action, text }; },
  }, events);
  await events.publish(petMessages[1]!);
  assert.equal(replies.length, 0);
  action = 'dispatch';
  const task = message('3', { author: { kind: 'pet', id: 'b' }, mentions: [{ participantId: 'pet:a' }] });
  await events.publish(task);
  assert.deepEqual(dispatches[0]?.slice(0, 3), ['a', task, 'Address the peer question']);
  const unaddressedWork = message('4', { author: { kind: 'pet', id: 'c' } });
  await events.publish(unaddressedWork);
  assert.equal(dispatches.length, 2);
  action = 'reply';
  text = 'Here is the answer.';
  const question = message('5', { author: { kind: 'pet', id: 'b' }, mentions: [{ participantId: 'pet:a' }] });
  await events.publish(question);
  assert.equal(replies.length, 0);
  assert.deepEqual(dispatches[2]?.slice(0, 2), ['a', question]);
  const unmentionedQuestion = message('6', { author: { kind: 'pet', id: 'b' } });
  await events.publish(unmentionedQuestion);
  assert.deepEqual(dispatches[3]?.slice(0, 2), ['a', unmentionedQuestion]);
  assert.deepEqual(decisions, ['2', '3', '4', '5', '6']);
  unsubscribe();
});

test('cancellation while context is loading never starts a decision', async () => {
  const events = bus();
  const started = deferred<void>();
  const context = deferred<{ messages: [] }>();
  let decisions = 0;
  const unsubscribe = activate({ pet: pet('a'),
    channel: { readContext: async () => { started.resolve(); return context.promise; }, reply: async () => {}, dispatch: async () => {} },
    decide: async () => { decisions++; return { action: 'ignore' }; },
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
    const mock = mockEndpoint([tool({ action: 'reply', text: 'Address source', timing: 'enqueue' })], method);
    const events: unknown[] = [];
    const decide = createHeadDecision(mock.endpoint, { onDiagnostic: event => events.push(event) });
    const signal = new AbortController().signal;
    assert.deepEqual(await decide(decisionInput, signal), { action: 'reply', text: 'Address source', timing: 'enqueue' });
    assert.deepEqual(mock.factory(), { maxOutputTokens: 512, maxRetries: 0, preferDeterministic: true, streaming: false });
    assert.equal((mock.binding() as unknown[]).length, 1);
    assert.equal(mock.calls.length, 1);
    assert.equal(mock.calls[0]!.signal, signal);
    assert.deepEqual(JSON.parse((mock.calls[0]!.messages as string[][])[1]![1]!), decisionInput);
    assert.deepEqual(events, [{ petId: 'a', channelId: 'team', messageId: '1', attempts: 1, outcome: 'selected', action: 'reply' }]);
  }
});
test('explicit JSON schema capability inspects raw refusal and validates parsed output', async () => {
  const mock = mockEndpoint([{ raw: raw({ action: 'ignore', text: '', timing: 'enqueue' }), parsed: { action: 'ignore', text: '', timing: 'enqueue' } }], 'jsonSchema');
  assert.deepEqual(await createHeadDecision(mock.endpoint)(decisionInput, new AbortController().signal), { action: 'ignore' });
  assert.deepEqual(mock.binding(), { name: 'pet_head_decision', method: 'jsonSchema', includeRaw: true });
});
test('known malformed output or explicit unsupported capability gets only one clean JSON fallback', async () => {
  const unsupported = Object.assign(new Error('private provider payload'), { status: 400, code: 'unsupported_parameter', param: 'tools' });
  for (const first of [tool({ action: 'reply', text: ' ', timing: 'enqueue' }), raw({ action: 'ignore', text: 'not empty', timing: 'enqueue' }), raw({ action: 'dispatch', text: 'ok', extra: true, timing: 'enqueue' }), unsupported]) {
    const mock = mockEndpoint([first, raw({ action: 'ignore', text: '', timing: 'enqueue' })]);
    assert.deepEqual(await createHeadDecision(mock.endpoint)(decisionInput, new AbortController().signal), { action: 'ignore' });
    assert.deepEqual(mock.calls.map(call => call.mode), ['tool', 'json']);
    assert.deepEqual((mock.calls[0]!.messages as unknown[])[1], (mock.calls[1]!.messages as unknown[])[1], 'original input is preserved');
    assert.equal(JSON.stringify(mock.calls[1]!.messages).includes('private provider payload'), false);
    assert.notDeepEqual(mock.calls[0]!.messages, mock.calls[1]!.messages, 'fallback requests a fresh JSON-only decision');
  }
});
test('unknown tools, multiple calls, refusal, truncation and provider failures never fall back', async () => {
  for (const output of [tool({ action: 'ignore', text: '', timing: 'enqueue' }, 'unknown'),
    { content: '', tool_calls: [...tool({}).tool_calls, ...tool({}).tool_calls] },
    { content: '', invalid_tool_calls: [{}] },
    { ...raw({ action: 'ignore', text: '', timing: 'enqueue' }), additional_kwargs: { refusal: 'private' } },
    { ...raw({ action: 'ignore', text: '', timing: 'enqueue' }), response_metadata: { finish_reason: 'length' } },
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
  for (const value of [null, {}, { action: 'ignore' }, { action: 'reply', text: 42, timing: 'enqueue' }, { action: 'route', text: 'x', timing: 'enqueue' }, { action: 'ignore', text: '', other: true, timing: 'enqueue' }]) {
    const mock = mockEndpoint([raw(value), raw(value), raw({ action: 'ignore', text: '', timing: 'enqueue' })]);
    await assert.rejects(createHeadDecision(mock.endpoint)(decisionInput, new AbortController().signal));
    assert.equal(mock.calls.length, 2);
  }
});
test('abort before or during provider work prevents fallback and selection', async () => {
  for (const before of [true, false]) {
    const controller = new AbortController();
    const mock = mockEndpoint([() => { controller.abort(); return raw({ action: 'ignore', text: '', timing: 'enqueue' }); }]);
    if (before) controller.abort();
    const events: Array<{ outcome: string; code?: string }> = [];
    await assert.rejects(createHeadDecision(mock.endpoint, { onDiagnostic: event => events.push(event) })(decisionInput, controller.signal));
    assert.equal(mock.calls.length, before ? 0 : 1);
    assert.equal(events[0]?.code, 'aborted');
  }
});

test('explicit JSON mode is preserved even when the adapter exposes tools', async () => {
  const value = { action: 'dispatch', text: 'Inspect the source', timing: 'enqueue' };
  const mock = mockEndpoint([{ raw: raw(value), parsed: value }], 'jsonMode');
  assert.deepEqual(await createHeadDecision(mock.endpoint)(decisionInput, new AbortController().signal), value);
  assert.deepEqual(mock.calls.map(call => call.mode), ['structured']);
  assert.deepEqual(mock.binding(), { name: 'pet_head_decision', method: 'jsonMode', includeRaw: true });
});

test('without tool binding or declared structured transport the Head uses conservative plain JSON', async () => {
  let calls = 0;
  const endpoint = { createChatModel: () => ({ invoke: async () => { calls++; return raw({ action: 'ignore', text: '', timing: 'enqueue' }); } }) };
  assert.deepEqual(await createHeadDecision(endpoint as never)(decisionInput, new AbortController().signal), { action: 'ignore' });
  assert.equal(calls, 1);
});

test('structured parsing failure retries once but raw refusal never does', async () => {
  const bad = { raw: { content: 'broken' }, parsed: null, parsing_error: new Error('private parsing detail') };
  const mock = mockEndpoint([bad, raw({ action: 'ignore', text: '', timing: 'enqueue' })], 'jsonMode');
  assert.deepEqual(await createHeadDecision(mock.endpoint)(decisionInput, new AbortController().signal), { action: 'ignore' });
  assert.deepEqual(mock.calls.map(call => call.mode), ['structured', 'json']);
  const refused = mockEndpoint([{ raw: { content: '', response_metadata: { stop_reason: 'refusal' } }, parsed: { action: 'ignore', text: '', timing: 'enqueue' } }], 'jsonSchema');
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
    const value = { action: 'reply', text: timing === 'interrupt' ? 'Correct the invalid units, then address the original calculation.' : 'Add the nonblocking illustration after the current explanation.', timing };
    const mock = mockEndpoint([mode === 'jsonMode' ? { raw: raw(value), parsed: value } : tool(value)], mode);
    const result = await createHeadDecision(mock.endpoint)({ ...decisionInput, message: message('2', { author: { kind, id: 'source' } }) }, new AbortController().signal);
    assert.deepEqual(result, value);
  }
  for (const value of [{ action: 'ignore', text: '', timing: 'interrupt' }, { action: 'reply', text: 'work' }, { action: 'reply', text: 'work', timing: 'urgent' }]) {
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
        return { action: 'dispatch', text: 'Correct units and finish the original calculation.', timing: 'interrupt' };
      } });
    await handler(source, new AbortController().signal);
    assert.equal(effects.length, 1);
    assert.equal(effects[0]!.length, 4, 'no trusted interrupt delivery is passed');
    assert.equal(effects[0]![1], source);
    assert.deepEqual(decisions, [{ petId: 'a', channelId: 'team', messageId: '2', requested: 'interrupt', effective: 'enqueue', reason: stale ? 'stale_snapshot' : 'continuation_unavailable', activeDispatchId: 'old' }]);
  }
});
