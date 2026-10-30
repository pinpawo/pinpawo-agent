import assert from 'node:assert/strict';
import test from 'node:test';
import { createChannelRouter, createLlmRouteDecider, type RouteInput } from './channelRouting';
import type { ChannelMember } from './channelService';
import type { ChannelMessageRow } from './store/channelStore';

const input: RouteInput = {
  channel: { title: 'Release' },
  message: { author: 'Barry', body: 'Who is handling #1003?' },
  pets: [{ participantId: 'pet:executor', name: 'Executor' }, { participantId: 'pet:reviewer', name: 'Reviewer' }],
  history: [{ author: 'Executor', body: 'Opened #1003.' }],
};
const endpoint = { profileId: 'p', baseUrl: 'https://models.test/v1/', apiKey: 'k', model: 'small' };
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
  assert.deepEqual(await decide('pet:ghost', 0.9), { kind: 'skip', reason: 'invalid', confidence: 0.9, detail: 'pet:ghost' });
});

test('a failing or slow decider skips instead of throwing', async () => {
  const failing = createChannelRouter({ enabled: true }, { decider: async () => { throw new Error('down'); } })!;
  assert.deepEqual(await failing.decide(input), { kind: 'skip', reason: 'error', detail: 'down' });
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

test('the llm decider resolves its profile at start and fails early for a missing one', () => {
  assert.throws(() => createChannelRouter({ enabled: true, decider: { kind: 'llm', modelProfileId: 'ghost' } }, {
    resolveModel: () => { throw new Error('Unknown model profile "ghost".'); },
  }), /ghost/);
  assert.throws(() => createChannelRouter({ enabled: true }, {}), /model profiles/);
});

for (const [method, expect] of [
  ['jsonSchema', (body: Record<string, unknown>) => (body.response_format as { type: string }).type === 'json_schema'],
  ['jsonMode', (body: Record<string, unknown>) => (body.response_format as { type: string }).type === 'json_object'],
  ['functionCalling', (body: Record<string, unknown>) => Array.isArray(body.tools)],
] as const) {
  test(`the llm decider asks for structured output with ${method}`, async () => {
    let sent: { url: string; body: Record<string, unknown> } | undefined;
    const decision = { target: 'pet:executor', confidence: 0.8, reason: 'It opened #1003.' };
    const fake = (async (url: string, init: RequestInit) => {
      sent = { url, body: JSON.parse(String(init.body)) };
      const text = JSON.stringify(decision);
      const choice = method === 'functionCalling'
        ? { message: { content: null, tool_calls: [{ function: { arguments: text } }] } }
        : { message: { content: text } };
      return new Response(JSON.stringify({ choices: [choice] }), { status: 200 });
    }) as unknown as typeof fetch;
    const decider = createLlmRouteDecider({ ...endpoint, structuredOutputMethod: method }, fake);
    assert.deepEqual(await decider(input, AbortSignal.timeout(1_000)), decision);
    assert.equal(sent?.url, 'https://models.test/v1/chat/completions');
    assert.equal(sent?.body.model, 'small');
    assert.ok(expect(sent!.body));
    const user = JSON.parse((sent!.body.messages as Array<{ content: string }>)[1]!.content) as { targets: string[] };
    assert.deepEqual(user.targets, ['pet:executor', 'pet:reviewer', 'none']);
  });
}

test('the llm decider rejects an HTTP error or a malformed answer', async () => {
  const reply = (status: number, content: string) => (async () => new Response(
    JSON.stringify({ choices: [{ message: { content } }] }), { status },
  )) as unknown as typeof fetch;
  await assert.rejects(createLlmRouteDecider(endpoint, reply(500, '{}'))(input, AbortSignal.timeout(1_000)), /HTTP 500/);
  await assert.rejects(createLlmRouteDecider(endpoint, reply(200, 'not json'))(input, AbortSignal.timeout(1_000)));
  await assert.rejects(createLlmRouteDecider(endpoint, reply(200, '{"target":"none","confidence":2}'))(input, AbortSignal.timeout(1_000)));
});

test('native routing fails at startup before any request, including the inherited Host default', () => {
  let requests = 0;
  const fetchImpl = (async () => { requests++; throw new Error('must not request'); }) as typeof fetch;
  const native = { ...endpoint, protocol: 'anthropic' as const };
  assert.throws(() => createLlmRouteDecider(native, fetchImpl), /routing.decider.modelProfileId/);
  for (const modelProfileId of [undefined, 'native']) {
    assert.throws(() => createChannelRouter({ enabled: true, decider: { kind: 'llm', modelProfileId } }, {
      resolveModel: () => native, fetch: fetchImpl,
    }), /only openai-compatible/);
  }
  assert.equal(requests, 0);
  assert.equal(createChannelRouter({ enabled: false }, { resolveModel: () => native }), undefined);
  const router = createChannelRouter({ enabled: true, decider: { kind: 'llm', modelProfileId: 'gateway' } }, {
    resolveModel: (profileId) => {
      assert.equal(profileId, 'gateway');
      return { ...endpoint, protocol: 'openai-compatible' };
    }, fetch: fetchImpl,
  });
  assert.ok(router);
});
