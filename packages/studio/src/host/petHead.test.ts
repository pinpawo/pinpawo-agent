import assert from 'node:assert/strict';
import test from 'node:test';
import { createHeadDecision, createPetHead, type HeadMessage } from './petHead';
import type { StudioEvent, StudioEventHandler } from '../studioContract';
import type { StudioPetRegistration } from '../types';

const pet = (petId: string, channelId = 'team'): StudioPetRegistration => ({
  petId, channelId, definitionId: 'assistant', name: petId, createdAt: '2026-01-01T00:00:00Z',
});
const message = (id: string, overrides: Partial<HeadMessage> = {}): HeadMessage => ({
  sequence: Number(id) || 1, messageId: id, channelId: 'team',
  author: { kind: 'human', id: 'owner' }, occurredAt: '2026-01-01T00:00:00Z',
  body: `message ${id}`, mentions: [], ...overrides,
});
const event = (payload: unknown): StudioEvent => ({
  eventId: 'event', type: 'channel.message.created', source: 'channel', occurredAt: '2026-01-01T00:00:00Z', payload,
});
function bus() {
  const handlers = new Set<StudioEventHandler>();
  return {
    subscribe: (handler: StudioEventHandler) => { handlers.add(handler); return () => handlers.delete(handler); },
    publish: async (value: StudioEvent) => { await Promise.all([...handlers].map(handler => handler(value))); },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test('only live messages in the owned Channel reach each Head; restarting never replays missed events', async () => {
  const events = bus();
  const seen: Array<{ petId: string; message: unknown }> = [];
  const channel = {
    readContext: async () => ({ messages: [] }),
    reply: async () => { throw new Error('unexpected reply'); },
    dispatch: async () => { throw new Error('unexpected dispatch'); },
  };
  const make = (petId: string, channelId = 'team') => createPetHead({
    pet: pet(petId, channelId), subscribe: events.subscribe, channel,
    decide: async input => { seen.push({ petId: input.pet.petId, message: input.message }); return { action: 'ignore' }; },
  });
  await events.publish(event(message('1'))); // no Heads are subscribed
  const a = make('a');
  const b = make('b');
  const other = make('c', 'other');
  const live = message('2', { replyTo: '1', deliverables: [{ uri: 'https://example.test/report' }] });
  await events.publish(event(live));
  assert.deepEqual(seen, [{ petId: 'a', message: live }, { petId: 'b', message: live }]);
  a.stop();
  b.stop();
  other.stop();
  await events.publish(event(message('3')));
  const resumed = make('a');
  await events.publish(event(message('4')));
  assert.deepEqual(seen.map(item => [item.petId, (item.message as { messageId: string }).messageId]), [['a', '2'], ['b', '2'], ['a', '4']]);
  resumed.stop();
});

test('a Head ignores its own messages and unrelated or malformed events', async () => {
  const events = bus();
  const seen: unknown[] = [];
  const head = createPetHead({ pet: pet('a'), subscribe: events.subscribe,
    channel: { readContext: async () => ({ messages: [] }), reply: async () => {}, dispatch: async () => {} },
    decide: async input => { seen.push(input.message); return { action: 'ignore' }; },
  });
  await events.publish(event(message('1', { author: { kind: 'pet', id: 'a' } })));
  await events.publish({ ...event(message('2')), source: 'other' });
  await events.publish({ ...event(message('3')), type: 'channel.updated' });
  await events.publish(event({ bad: true }));
  assert.deepEqual(seen, []);
  head.stop();
});

test('a stopped Head cancels an in-flight decision and produces no late reply or dispatch', async () => {
  for (const action of ['reply', 'dispatch'] as const) {
    const events = bus();
    const started = deferred<void>();
    const decision = deferred<{ action: typeof action; text: string }>();
    const effects: string[] = [];
    let observed: AbortSignal | undefined;
    const head = createPetHead({ pet: pet('a'), subscribe: events.subscribe,
      channel: { readContext: async () => ({ messages: [] }),
        reply: async () => { effects.push('reply'); }, dispatch: async () => { effects.push('dispatch'); } },
      decide: async (_input, signal) => { observed = signal; started.resolve(); return decision.promise; },
    });
    const processing = events.publish(event(message('1')));
    await started.promise;
    head.stop();
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
  const head = createPetHead({ pet: pet('a'), description: 'Instance description', subscribe: events.subscribe,
    channel: { readContext: async (...args) => { calls.push(['read', ...args]); return context; },
      reply: async (...args) => { calls.push(['reply', ...args]); }, dispatch: async (...args) => { calls.push(['dispatch', ...args]); } },
    decide: async input => { inputs.push(input); return { action, text: action === 'reply' ? 'Acknowledged' : 'Investigate' }; },
  });
  await events.publish(event(current));
  assert.deepEqual(inputs[0], { pet: pet('a'), description: 'Instance description', message: current, context });
  assert.deepEqual(calls[1]?.slice(0, 5), ['reply', 'team', 'a', '1', 'Acknowledged']);
  assert.ok(calls[1]?.[5] instanceof AbortSignal);
  action = 'dispatch';
  const taskMessage = message('2', { replyTo: '1', deliverables: [{ uri: 'https://example.test/file' }] });
  await events.publish(event(taskMessage));
  const dispatch = calls.find(call => call[0] === 'dispatch')!;
  assert.deepEqual(dispatch.slice(0, 5), ['dispatch', 'team', 'a', taskMessage, 'Investigate']);
  assert.ok(dispatch[5] instanceof AbortSignal);
  head.stop();
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
  const head = createPetHead({ pet: pet('a'), subscribe: events.subscribe,
    channel: { readContext: async () => ({ messages: petMessages }),
      reply: async (...args) => { replies.push(args); }, dispatch: async (...args) => { dispatches.push(args); } },
    decide: async input => { decisions.push(input.message.messageId); return { action, text }; },
  });
  // An undirected Pet acknowledgement must not start a confirmation loop.
  await events.publish(event(petMessages[1]));
  assert.equal(replies.length, 0);
  // A task or new result can be dispatched even after multiple Pet messages.
  action = 'dispatch';
  const task = message('3', { author: { kind: 'pet', id: 'b' }, mentions: [{ participantId: 'pet:a' }] });
  await events.publish(event(task));
  assert.deepEqual(dispatches[0]?.slice(0, 4), ['team', 'a', task, 'Acknowledged']);
  const unaddressedWork = message('4', { author: { kind: 'pet', id: 'c' } });
  await events.publish(event(unaddressedWork));
  assert.equal(dispatches.length, 2);
  // A directly addressed Pet question can receive a lightweight reply.
  action = 'reply';
  text = 'Here is the answer.';
  const question = message('5', { author: { kind: 'pet', id: 'b' }, mentions: [{ participantId: 'pet:a' }] });
  await events.publish(event(question));
  assert.deepEqual(replies[0]?.slice(0, 4), ['team', 'a', '5', 'Here is the answer.']);
  // The Channel rejects Pet mentions in this reply, so it cannot initiate a new chain.
  assert.deepEqual(replies[0]?.[5], { preventPetMentions: true });
  assert.deepEqual(decisions, ['2', '3', '4', '5']);
  head.stop();
});

test('cancellation while context is loading never starts a decision', async () => {
  const events = bus();
  const started = deferred<void>();
  const context = deferred<{ messages: [] }>();
  let decisions = 0;
  const head = createPetHead({ pet: pet('a'), subscribe: events.subscribe,
    channel: { readContext: async () => { started.resolve(); return context.promise; }, reply: async () => {}, dispatch: async () => {} },
    decide: async () => { decisions++; return { action: 'ignore' }; },
  });
  const pending = events.publish(event(message('1')));
  await started.promise;
  head.stop();
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
