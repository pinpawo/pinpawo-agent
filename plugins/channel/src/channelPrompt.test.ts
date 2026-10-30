import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createStudioWithPets } from '../../../tests/support/livePets';
import { createChannelPlugin } from './channelPlugin';

const human = { kind: 'human' as const, id: 'local' };
type Dispatched = {
  request: string;
  session?: { id: string; create?: boolean };
  scope?: { namespace: string; id: string };
  systemPromptSections?: readonly { id: string; owner?: string; content: string }[];
};

test('each Channel dispatch supplies only its own current prompt to the same Pet', async () => {
  const dispatched: Dispatched[] = [];
  const channel = createChannelPlugin({
    httpRoute: false,
    routing: { enabled: true },
    routeDecider: async () => ({ target: 'pet:one', confidence: 1 }),
  });
  const studio = await createStudioWithPets({
    studioId: 'channel-prompt', plugins: [channel],
    pets: [{ registration: { petId: 'one', name: 'One' }, dispatch: {
      getQueueSnapshot: () => ({ state: 'open' as const, activeOperation: null, queuedConversations: 0, queuedDispatches: 0 }),
      onQueueChange: () => () => {}, onDispatchLifecycle: () => () => {},
      dispatch: async (input: unknown) => { dispatched.push(input as Dispatched); },
    } }],
  });
  try {
    const a = (await channel.service.createChannel(human, {
      title: 'A', prompt: 'Alpha ]]> collaboration', pets: ['one'],
    }, { studio: true })).channel.channelId;
    const b = (await channel.service.createChannel(human, { title: 'B', pets: ['one'] })).channel.channelId;
    const first = await channel.sendMessage(a, { body: 'hello', mentions: [{ participantId: 'pet:one' }] }, human);
    assert.equal(first.deliveries[0]?.state, 'accepted');
    await channel.sendMessage(b, { body: 'hello', mentions: [{ participantId: 'pet:one' }] }, human);
    assert.equal(dispatched.length, 2);
    const aSection = dispatched[0]!.systemPromptSections?.[0];
    assert.deepEqual([aSection?.id, aSection?.owner], ['channel:context', 'channel']);
    assert.match(aSection!.content, /Alpha \]\]\]\]><!\[CDATA\[> collaboration/);
    assert.doesNotMatch(dispatched[0]!.request, /Alpha/);
    assert.equal(dispatched[1]!.systemPromptSections, undefined, 'an empty Channel contributes no section');
    assert.notEqual(dispatched[0]!.session?.id, dispatched[1]!.session?.id);

    await channel.service.updateChannel(human, a, { prompt: 'Updated A' }, { studio: true });
    await channel.service.updateChannel(human, b, { prompt: 'Beta' }, { studio: true });
    await channel.run(a, 'one', 'scheduled', { kind: 'scheduler', id: 's' });
    await channel.run(b, 'one', 'triggered', { kind: 'trigger', id: 't' });
    assert.equal(dispatched.length, 4);
    assert.match(dispatched[2]!.systemPromptSections![0]!.content, /Updated A/);
    assert.doesNotMatch(dispatched[2]!.systemPromptSections![0]!.content, /Beta/);
    assert.match(dispatched[3]!.systemPromptSections![0]!.content, /Beta/);
    assert.doesNotMatch(dispatched[3]!.systemPromptSections![0]!.content, /Updated A/);
    assert.match(aSection!.content, /Alpha/, 'the previous dispatch remains a snapshot');
    assert.equal(dispatched[2]!.session?.id, dispatched[0]!.session?.id);
    assert.equal(dispatched[3]!.session?.id, dispatched[1]!.session?.id);

    await channel.service.updateChannel(human, a, { prompt: null }, { studio: true });
    await channel.run(a, 'one', 'cleared', { kind: 'scheduler', id: 's2' });
    assert.equal(dispatched[4]!.systemPromptSections, undefined);

    // An unaddressed human message takes the router path, not the mention path.
    await channel.sendMessage(b, { body: 'route this' }, human);
    for (let i = 0; i < 200 && dispatched.length < 6; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(dispatched.length, 6);
    assert.match(dispatched[5]!.systemPromptSections![0]!.content, /Beta/);
    assert.equal(dispatched[5]!.session?.id, dispatched[1]!.session?.id);
  } finally { await studio.shutdown(); }
});

test('provider uses the persisted binding and current membership after Studio restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'channel-prompt-binding-'));
  const storage = { kind: 'sqlite' as const, path: join(root, 'studio.sqlite') };
  const observed: Dispatched[] = [];
  const marker = randomUUID();
  const pet = { registration: { petId: 'one', name: 'One' }, dispatch: {
    getQueueSnapshot: () => ({ state: 'open' as const, activeOperation: null, queuedConversations: 0, queuedDispatches: 0 }),
    onQueueChange: () => () => {}, onDispatchLifecycle: () => () => {},
    dispatch: async (input: unknown) => { observed.push(input as Dispatched); },
  } };
  const otherPet = { ...pet, registration: { petId: 'two', name: 'Two' } };
  let studio: Awaited<ReturnType<typeof createStudioWithPets>> | undefined;
  try {
    let channel = createChannelPlugin({ httpRoute: false });
    studio = await createStudioWithPets({ studioId: 'persistent-prompt', storage, plugins: [channel], pets: [pet, otherPet] });
    const a = (await channel.service.createChannel(human, { title: 'A', prompt: marker, pets: ['one'] }, { studio: true })).channel.channelId;
    const b = (await channel.service.createChannel(human, { title: 'B', pets: ['one'] })).channel.channelId;
    await channel.run(a, 'one', 'one', { kind: 'scheduler', id: 'a' });
    await channel.run(b, 'one', 'two', { kind: 'scheduler', id: 'b' });
    const aSession = observed[0]!.session!.id;
    const bSession = observed[1]!.session!.id;
    assert.notEqual(aSession, bSession);
    await studio.shutdown();
    channel = createChannelPlugin({ httpRoute: false });
    studio = await createStudioWithPets({ studioId: 'persistent-prompt', storage, plugins: [channel], pets: [pet, otherPet] });

    await studio.dispatch({ petId: 'one', request: 'existing binding', session: { id: aSession }, scope: { namespace: 'channel', id: a } });
    assert.ok(observed.at(-1)!.systemPromptSections?.[0]?.content.includes(marker));
    await studio.dispatch({ petId: 'one', request: 'not a Channel invocation', session: { id: aSession } });
    assert.equal(observed.at(-1)!.systemPromptSections, undefined);
    const count = observed.length;
    await assert.rejects(studio.dispatch({ petId: 'one', request: 'wrong channel', session: { id: bSession }, scope: { namespace: 'channel', id: a } }));
    await assert.rejects(studio.dispatch({ petId: 'one', request: 'missing session', scope: { namespace: 'channel', id: a } }));
    await assert.rejects(studio.dispatch({ petId: 'two', request: 'wrong Pet', session: { id: aSession }, scope: { namespace: 'channel', id: a } }));
    await assert.rejects(studio.dispatch({ petId: 'one', request: 'unknown channel', session: { id: aSession }, scope: { namespace: 'channel', id: randomUUID() } }));
    await channel.service.removeMember(human, a, { kind: 'pet', id: 'one' });
    await assert.rejects(studio.dispatch({ petId: 'one', request: 'former member', session: { id: aSession }, scope: { namespace: 'channel', id: a } }));
    assert.equal(observed.length, count);
  } finally {
    await studio?.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
