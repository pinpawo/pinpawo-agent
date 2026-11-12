import assert from 'node:assert/strict';
import test from 'node:test';
import { bindPetHeadChannel, createHeadDecision, createPetHead, type HeadMessage, type PetHeadChannel } from './petHead';
import type { StudioPetRegistration } from '../types';
import type { StudioEvent, StudioEventHandler } from '../studioContract';

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
  const calls: unknown[][] = [];
  const channel = bindPetHeadChannel('team', {
    readContext: async (...args) => { calls.push(['read', ...args]); return { messages: [] }; },
    reply: async (...args) => { calls.push(['reply', ...args]); },
    dispatch: async (...args) => { calls.push(['dispatch', ...args]); },
  }, listener => { handler = listener; return () => { handler = undefined; }; });
  const seen: HeadMessage[] = [];
  const unsubscribe = channel.subscribe(async value => { seen.push(value); });
  const wrap = (payload: unknown): StudioEvent => ({ eventId: '1', type: 'channel.message.created', source: 'channel', occurredAt: '2026-01-01T00:00:00Z', payload });
  const current = message('2');
  await handler?.({ ...wrap(current), source: 'other' });
  await handler?.({ ...wrap(current), type: 'channel.updated' });
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
  assert.deepEqual(calls[1]?.slice(0, 4), ['reply', 'a', '1', 'Acknowledged']);
  assert.ok(calls[1]?.[4] instanceof AbortSignal);
  action = 'dispatch';
  const taskMessage = message('2', { replyTo: '1', deliverables: [{ uri: 'https://example.test/file' }] });
  await events.publish(taskMessage);
  const dispatch = calls.find(call => call[0] === 'dispatch')!;
  assert.deepEqual(dispatch.slice(0, 4), ['dispatch', 'a', taskMessage, 'Investigate']);
  assert.ok(dispatch[4] instanceof AbortSignal);
  unsubscribe();
});

test('Pet messages are independently judged while undirected acknowledgements and recursive mentions are suppressed', async () => {
  const events = bus();
  const petMessages = [message('1', { author: { kind: 'pet', id: 'b' } }),
    message('2', { author: { kind: 'pet', id: 'c' } })];
  const decisions: string[] = [];
  const replies: unknown[][] = [];
  const dispatches: unknown[][] = [];
  let action: 'reply' | 'dispatch' = 'reply';
  let text = 'Acknowledged';
  const unsubscribe = activate({ pet: pet('a'),
    channel: { readContext: async () => ({ messages: petMessages }),
      reply: async (...args) => { replies.push(args); }, dispatch: async (...args) => { dispatches.push(args); } },
    decide: async input => { decisions.push(input.message.messageId); return { action, text }; },
  }, events);
  await events.publish(petMessages[1]!);
  assert.equal(replies.length, 0);
  action = 'dispatch';
  const task = message('3', { author: { kind: 'pet', id: 'b' }, mentions: [{ participantId: 'pet:a' }] });
  await events.publish(task);
  assert.deepEqual(dispatches[0]?.slice(0, 3), ['a', task, 'Acknowledged']);
  const unaddressedWork = message('4', { author: { kind: 'pet', id: 'c' } });
  await events.publish(unaddressedWork);
  assert.equal(dispatches.length, 2);
  action = 'reply';
  text = 'Here is the answer.';
  const question = message('5', { author: { kind: 'pet', id: 'b' }, mentions: [{ participantId: 'pet:a' }] });
  await events.publish(question);
  assert.deepEqual(replies[0]?.slice(0, 3), ['a', '5', 'Here is the answer.']);
  assert.deepEqual(replies[0]?.[4], { preventPetMentions: true });
  assert.deepEqual(decisions, ['2', '3', '4', '5']);
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

test('model decisions use the selected structured-output method and receive only the instance input and cancellation signal', async () => {
  for (const method of [undefined, 'functionCalling', 'jsonSchema'] as const) {
    let factoryOptions: unknown;
    let schema: unknown;
    let structuredOptions: unknown;
    let received: unknown;
    let receivedSignal: AbortSignal | undefined;
    const endpoint = {
      profileId: 'test', baseUrl: 'https://example.test', apiKey: 'secret', model: 'test', structuredOutputMethod: method,
      createChatModel: (options: unknown) => {
        factoryOptions = options;
        return { withStructuredOutput: (value: unknown, options: unknown) => {
          schema = value; structuredOptions = options;
          return { invoke: async (messages: unknown, config: { signal: AbortSignal }) => {
            received = messages; receivedSignal = config.signal;
            return { action: 'dispatch', text: 'Investigate' };
          } };
        } };
      },
    };
    const decide = createHeadDecision(endpoint as never);
    const controller = new AbortController();
    const input = { pet: pet('a'), description: 'Instance role', message: message('1'), context: { messages: [] } };
    assert.deepEqual(await decide(input, controller.signal), { action: 'dispatch', text: 'Investigate' });
    assert.deepEqual(factoryOptions, { maxOutputTokens: 512, maxRetries: 0, preferDeterministic: true });
    assert.deepEqual(structuredOptions, { name: 'pet_head_decision', method: method ?? 'jsonMode' });
    assert.deepEqual((schema as { properties: { action: { enum: string[] } } }).properties.action.enum, ['ignore', 'reply', 'dispatch']);
    const messages = received as Array<[string, string]>;
    assert.deepEqual(messages.map(item => item[0]), ['system', 'human']);
    if (method === undefined) {
      // jsonMode providers receive field constraints in the request itself.
      for (const part of ['JSON', 'action', 'text', 'ignore', 'reply', 'dispatch']) {
        assert.ok(messages[0]![1].includes(part));
      }
    }
    assert.deepEqual(JSON.parse(messages[1]![1]), input);
    assert.equal(receivedSignal, controller.signal);
  }
});

test('model decisions reject invalid outputs without exposing their contents', async () => {
  let output: unknown;
  const endpoint = { profileId: 'test', baseUrl: 'https://example.test', apiKey: 'secret', model: 'test',
    createChatModel: () => ({ withStructuredOutput: () => ({ invoke: async () => output }) }) };
  const decide = createHeadDecision(endpoint as never);
  const input = { pet: pet('a'), message: message('1'), context: { messages: [] } };
  const signal = new AbortController().signal;
  for (const invalid of [null, undefined, 'invalid', { action: 'route', text: 'sensitive output' }, { action: 'reply', text: ' ' }, { action: 'dispatch', text: 42 }, {}]) {
    output = invalid;
    await assert.rejects(decide(input, signal), (error: Error) => {
      assert.equal(error.message, 'Invalid Pet Head decision.');
      assert.ok(!error.message.includes('sensitive output'));
      return true;
    });
  }
  output = { action: 'ignore', text: '' };
  assert.deepEqual(await decide(input, signal), { action: 'ignore' });
});
