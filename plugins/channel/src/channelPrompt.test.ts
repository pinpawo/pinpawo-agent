import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { StudioContextProvider, StudioInvocationContext } from '@pinpawo/studio-core';
import type { AgentInvocationHint, SystemPromptSection } from '@pinpawo/pet-agent';
import { createStudioWithPets } from '../../../tests/support/livePets';
import { readChannelTestInput, readChannelTestTask } from '../../../tests/support/channelDispatchInput';
import { createChannelPlugin } from './channelPlugin';

const human = { kind: 'human' as const, id: 'local' };
type Dispatched = {
  request: string;
  session?: { id: string; create?: boolean };
  scope?: { namespace: string; id: string };
};
type Context = Awaited<ReturnType<StudioContextProvider>>;
type Sections = readonly SystemPromptSection[] | undefined;
function contextObject(value: Context): StudioInvocationContext | undefined {
  return Array.isArray(value) ? { systemPromptSections: value } : value as Exclude<Context, readonly SystemPromptSection[]>;
}

test('each Channel dispatch supplies only its own current prompt to the same Pet', async () => {
  const dispatched: Dispatched[] = [];
  const resolved: Sections[] = [];
  const hints: Array<AgentInvocationHint | undefined> = [];
  const routingReason = randomUUID();
  const routingFocus = randomUUID();
  let resolver!: StudioContextProvider;
  const channel = createChannelPlugin({
    httpRoute: false,
    routing: { enabled: true },
    routeDecider: async () => ({ target: 'pet:one', confidence: 1, reason: routingReason, focus: routingFocus }),
  });
  const studio = await createStudioWithPets({
    studioId: 'channel-prompt', plugins: [channel],
    onPreparedContextResolver: value => { resolver = value; },
    pets: [{ registration: { petId: 'one', name: 'One' }, dispatch: {
      getQueueSnapshot: () => ({ state: 'open' as const, activeOperation: null, queuedConversations: 0, queuedDispatches: 0 }),
      onQueueChange: () => () => {}, onDispatchLifecycle: () => () => {},
      dispatch: async (input: Dispatched) => {
        const context = contextObject(input.scope ? await resolver({ petId: 'one', sessionId: input.session?.id, scope: input.scope, request: input.request }) : undefined);
        resolved.push(context?.systemPromptSections);
        hints.push(context?.hint);
        dispatched.push(input);
      },
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
    assert.equal(Object.hasOwn(readChannelTestInput(dispatched[0]!.request), 'contextHint'), false);
    assert.equal(Object.hasOwn(readChannelTestInput(dispatched[1]!.request), 'contextHint'), false);
    const aSection = resolved[0]?.find(section => section.id === 'channel:context');
    assert.deepEqual([aSection?.id, aSection?.owner], ['channel:context', 'channel']);
    assert.match(aSection!.content, /Alpha \]\]\]\]><!\[CDATA\[> collaboration/);
    assert.doesNotMatch(dispatched[0]!.request, /Alpha/);
    assert.equal(Object.hasOwn(dispatched[0]!, 'systemPromptSections'), false, 'context is not a dispatch parameter');
    assert.equal(Object.hasOwn(dispatched[0]!, 'hint'), false, 'hint is not a dispatch parameter');
    assert.equal(hints[0]?.source, 'channel');
    assert.deepEqual(hints[0], hints[1]);
    assert.deepEqual(resolved[1]?.map(section => section.id), ['channel:protocol', 'channel:metadata']);
    const metadata = resolved[1]!.find(section => section.id === 'channel:metadata')!;
    assert.deepEqual(JSON.parse(metadata.content), { channelId: b, title: 'B' });
    assert.equal(resolved[0]![0]!.content, resolved[1]![0]!.content, 'the Plugin supplies one shared protocol');
    assert.notEqual(dispatched[0]!.session?.id, dispatched[1]!.session?.id);

    await channel.service.updateChannel(human, a, { prompt: 'Updated A' }, { studio: true });
    await channel.service.updateChannel(human, b, { prompt: 'Beta' }, { studio: true });
    await channel.run(a, 'one', 'scheduled', { kind: 'scheduler', id: 's' });
    await channel.run(b, 'one', 'triggered', { kind: 'trigger', id: 't' });
    assert.equal(dispatched.length, 4);
    assert.equal(hints[2]?.source, 'channel');
    assert.equal(hints[3]?.source, 'channel');
    assert.equal(hints[2]?.focus, undefined);
    assert.equal(hints[3]?.focus, undefined);
    assert.equal(Object.hasOwn(readChannelTestTask(dispatched[2]!.request), 'contextHint'), false);
    assert.equal(Object.hasOwn(readChannelTestTask(dispatched[3]!.request), 'contextHint'), false);
    assert.match(resolved[2]!.find(section => section.id === 'channel:context')!.content, /Updated A/);
    assert.doesNotMatch(resolved[2]!.find(section => section.id === 'channel:context')!.content, /Beta/);
    assert.match(resolved[3]!.find(section => section.id === 'channel:context')!.content, /Beta/);
    assert.doesNotMatch(resolved[3]!.find(section => section.id === 'channel:context')!.content, /Updated A/);
    assert.match(aSection!.content, /Alpha/, 'the previous dispatch remains a snapshot');
    assert.equal(dispatched[2]!.session?.id, dispatched[0]!.session?.id);
    assert.equal(dispatched[3]!.session?.id, dispatched[1]!.session?.id);

    await channel.service.updateChannel(human, a, { prompt: null }, { studio: true });
    await channel.run(a, 'one', 'cleared', { kind: 'scheduler', id: 's2' });
    assert.deepEqual(resolved[4]?.map(section => section.id), ['channel:protocol', 'channel:metadata'], 'clearing the announcement keeps the Plugin context');

    // An unaddressed human message takes the router path, not the mention path.
    await channel.sendMessage(b, { body: 'route this' }, human);
    for (let i = 0; i < 200 && dispatched.length < 6; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(dispatched.length, 6);
    const routed = readChannelTestInput(dispatched[5]!.request);
    assert.equal(routed.addressedBy, 'routing');
    assert.equal(routed.contextHint?.source, 'channel-routing');
    assert.equal(routed.contextHint?.action, 'read-latest-channel');
    assert.equal(routed.contextHint?.focus, routingFocus);
    assert.equal(hints[5]?.focus, routingFocus, 'the provider exposes model advice independently of the goal');
    assert.equal(hints[4]?.focus, undefined);
    assert.equal(routed.body, 'route this');
    assert.equal(dispatched[5]!.request.includes(routingReason), false, 'the decision reason remains outside the Pet request');
    assert.ok(resolved[5]?.every(section => !section.content.includes(routingFocus)), 'dynamic attention stays outside the system context');
    assert.equal(dispatched[5]!.request.includes('Beta'), false, 'the announcement remains in the provider context');
    assert.match(resolved[5]!.find(section => section.id === 'channel:context')!.content, /Beta/);
    assert.deepEqual(resolved[5]?.map(section => section.id), ['channel:protocol', 'channel:metadata', 'channel:context']);
    assert.equal(dispatched[5]!.session?.id, dispatched[1]!.session?.id);
    await channel.run(b, 'one', 'after routing', { kind: 'trigger', id: 'after-routing' });
    assert.equal(hints[6]?.source, 'channel');
    assert.equal(hints[6]?.focus, undefined, 'a later non-routed task has no old focus');
    assert.equal(hints[5]?.focus, routingFocus, 'the earlier invocation snapshot keeps its own focus');
  } finally { await studio.shutdown(); }
});

test('provider uses the persisted binding and current membership after Studio restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'channel-prompt-binding-'));
  const storage = { kind: 'sqlite' as const, path: join(root, 'studio.sqlite') };
  const observed: Dispatched[] = [];
  const observedSections: Sections[] = [];
  let resolver!: StudioContextProvider;
  const marker = randomUUID();
  const pet = (petId: string, name: string) => ({ registration: { petId, name }, dispatch: {
    getQueueSnapshot: () => ({ state: 'open' as const, activeOperation: null, queuedConversations: 0, queuedDispatches: 0 }),
    onQueueChange: () => () => {}, onDispatchLifecycle: () => () => {},
    dispatch: async (input: Dispatched) => {
      observedSections.push(contextObject(input.scope ? await resolver({ petId, sessionId: input.session?.id, scope: input.scope, request: input.request }) : undefined)?.systemPromptSections);
      observed.push(input);
    },
  } });
  const pets = [pet('one', 'One'), pet('two', 'Two')];
  let studio: Awaited<ReturnType<typeof createStudioWithPets>> | undefined;
  try {
    let channel = createChannelPlugin({ httpRoute: false });
    studio = await createStudioWithPets({ studioId: 'persistent-prompt', storage, plugins: [channel], pets,
      onPreparedContextResolver: value => { resolver = value; } });
    const a = (await channel.service.createChannel(human, { title: 'A', prompt: marker, pets: ['one'] }, { studio: true })).channel.channelId;
    const b = (await channel.service.createChannel(human, { title: 'B', pets: ['one'] })).channel.channelId;
    await channel.run(a, 'one', 'one', { kind: 'scheduler', id: 'a' });
    await channel.run(b, 'one', 'two', { kind: 'scheduler', id: 'b' });
    const aSession = observed[0]!.session!.id;
    const bSession = observed[1]!.session!.id;
    assert.notEqual(aSession, bSession);
    await studio.shutdown();
    channel = createChannelPlugin({ httpRoute: false });
    studio = await createStudioWithPets({ studioId: 'persistent-prompt', storage, plugins: [channel], pets,
      onPreparedContextResolver: value => { resolver = value; } });

    await studio.dispatch({ petId: 'one', request: 'existing binding', session: { id: aSession }, scope: { namespace: 'channel', id: a } });
    assert.ok(observedSections.at(-1)?.find(section => section.id === 'channel:context')?.content.includes(marker));
    assert.equal(Object.hasOwn(observed.at(-1)!, 'systemPromptSections'), false);
    await studio.dispatch({ petId: 'one', request: 'not a Channel invocation', session: { id: aSession } });
    assert.equal(observedSections.at(-1), undefined);
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
