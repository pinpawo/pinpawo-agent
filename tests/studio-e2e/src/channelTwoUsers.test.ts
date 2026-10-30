import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import { Annotation, END, START, StateGraph } from '@langchain/langgraph';

import { createChannelPlugin } from '@pinpawo-plugin/channel';
import { createStudioHttpPlugin } from '@pinpawo-plugin/studio-http';
import { buildHostRuntimeConfig, createResidentPetHost, FileSaver } from 'pinpawo/host-runtime';
import { readChannelTestInput, type ChannelTestInput } from '../../support/channelDispatchInput';
import { parseStudioOperatorArgs, runStudioOperator } from '../../../packages/studio/src/studioOperatorCli';
import { createTestModelProfiles } from '../../../services/host/src/testing/modelProfiles';
import { HostToolkitInventoryStore } from '../../../services/host/src/toolkits/toolkitInventory';
import type { AgentChannelSetup } from '../../../services/host/src/agent/agentChannel';
import { createStudioWithPets } from '../../../tests/support/livePets';
import { createInvocationContextBridge } from './invocationContextBridge';

const LOCAL_TOKEN = 'channel-two-users-test-only';

async function waitFor(check: () => boolean | Promise<boolean>, label: string) {
  for (let i = 0; i < 1000; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error(`Timed out: ${label}`);
}

/**
 * #943 acceptance: two people, each with their own Studio client key, share a
 * Channel with two Pets over HTTP and the CLI. Each Pet answers whoever wrote
 * to it, by name, and only members can read or speak.
 */
test('two users with their own keys share a Channel with two Pets over HTTP and the CLI', async () => {
  const root = await mkdtemp(join(tmpdir(), 'channel-two-users-'));
  const contextBridge = createInvocationContextBridge();
  const channel = createChannelPlugin();
  const http = createStudioHttpPlugin({ port: 0, authToken: LOCAL_TOKEN });
  const hosts: Awaited<ReturnType<typeof createResidentPetHost>>[] = [];
  const inputs: Array<{ petId: string; input: ChannelTestInput }> = [];
  const pets = [{ petId: 'alpha', name: 'Alpha', definitionId: 'alpha' }, { petId: 'beta', name: 'Beta', definitionId: 'beta' }];
  for (const { petId, name } of pets) {
    const config = buildHostRuntimeConfig(join(root, petId));
    const checkpointer = new FileSaver(config.checkpointPath);
    const State = Annotation.Root({ messages: Annotation<BaseMessage[]>({ reducer: (a, b) => [...a, ...b], default: () => [] }) });
    // A deterministic Pet: answer the author of the message that woke it, by the name Channel gave.
    const graph = new StateGraph(State).addNode('reply', async state => {
      const input = readChannelTestInput(state.messages.at(-1)!.text);
      inputs.push({ petId, input });
      const { participantId, label } = input.author;
      return { messages: [new AIMessage(`[@${label}](participant:${participantId}) ${name} heard ${label}: ${input.body}`)] };
    }).addEdge(START, 'reply').addEdge('reply', END).compile({ checkpointer });
    const graphConfig = (setup: AgentChannelSetup) => ({ configurable: { thread_id: setup.input.threadId } });
    hosts.push(await createResidentPetHost({ petId, petName: name, runtimeConfig: config,
      resolveInvocationContext: contextBridge.resolveInvocationContext,
      modelProfiles: createTestModelProfiles(), toolAuthorizationMode: 'full_access', autoAuthorizationSafetyLevel: 'strict',
      capabilities: [], toolkitInventory: new HostToolkitInventoryStore(), checkpointer, sessionStatePath: config.tuiSessionPath,
      capabilityArtifactStore: { writeArtifact: async () => { throw Error('unused'); }, readArtifact: async () => { throw Error('unused'); },
        listArtifacts: async () => [], deleteThreadArtifacts: async () => {}, getDownloadUri: async uri => uri },
      graphService: {
        async readThreadState(setup: AgentChannelSetup) {
          const snapshot = await graph.getState(graphConfig(setup));
          return { messages: snapshot.values.messages ?? [], pendingInterrupt: null, acceptsResume: false, currentPlan: null };
        },
        async streamEvents(setup: AgentChannelSetup) { return graph.streamEvents({ messages: setup.input.messages }, { ...graphConfig(setup), version: 'v3' }); },
      } as never,
    }));
  }
  const studio = await createStudioWithPets({ studioId: 'two-users', plugins: [channel, http],
    onPreparedContextResolver: contextBridge.onPreparedContextResolver,
    storage: { kind: 'sqlite', path: join(root, 'studio.sqlite') },
    pets: hosts.map((host, i) => ({ registration: pets[i]!, dispatch: host.resident.dispatch })),
  });
  const base = `http://127.0.0.1:${http.address()!.port}`;
  const call = async (token: string, path: string, body?: unknown) => {
    const response = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json().catch(() => null) as any };
  };
  const ok = async (token: string, path: string, body?: unknown) => {
    const result = await call(token, path, body);
    assert.ok(result.status < 300, `${path} ${result.status} ${JSON.stringify(result.body)}`);
    return result.body;
  };
  /** The CLI as a person runs it, with their key in a token file. */
  const cli = async (keyFile: string, args: string[], stdin = '') => {
    let output = '';
    await runStudioOperator(parseStudioOperatorArgs([...args, '--studio-url', base, '--token-file', keyFile])!, {
      readStdin: async () => stdin, writeOutput: text => { output += text; },
    });
    return JSON.parse(output);
  };
  try {
    // The local Host token registers two people; each gets their own key.
    const keys: Record<string, string> = {};
    for (const [clientId, label] of [['alice', 'Alice'], ['bob', 'Bob'], ['carol', 'Carol']]) {
      keys[clientId!] = (await ok(LOCAL_TOKEN, '/clients', { clientId, label })).key;
    }
    const bobKeyFile = join(root, 'bob.key');
    await writeFile(bobKeyFile, keys.bob! + '\n');

    // Alice, over HTTP: who am I, which Pets exist, then a Channel with Alpha.
    assert.deepEqual(await ok(keys.alice!, '/me'), { clientId: 'alice', scope: 'client' });
    assert.deepEqual((await ok(keys.alice!, '/pets')).pets, pets);
    const channelId = (await ok(keys.alice!, '/channels', { title: 'Launch', pets: ['alpha'] })).channel.channelId as string;
    await ok(keys.alice!, '/channels/members', { channelId, kind: 'human', id: 'bob' });
    await ok(keys.alice!, '/channels/members', { channelId, kind: 'pet', id: 'beta' });

    // Bob, over the CLI with his own key: sees the Channel and the Pets, and asks Alpha.
    assert.deepEqual((await cli(bobKeyFile, ['channels', 'list'])).channels.map((item: any) => item.channelId), [channelId]);
    assert.deepEqual((await cli(bobKeyFile, ['pets', 'list'])).pets.map((pet: any) => pet.petId), ['alpha', 'beta']);
    const members = (await cli(bobKeyFile, ['channels', 'members', channelId])).members;
    assert.deepEqual(members.map((member: any) => [member.participantId, member.label]),
      [['human:alice', 'Alice'], ['pet:alpha', 'Alpha'], ['human:bob', 'Bob'], ['pet:beta', 'Beta']]);
    const fromBob = await cli(bobKeyFile, ['channels', 'send', channelId, '--file', '-', '--mention', 'pet:alpha'], 'Is the build green?');
    assert.deepEqual(fromBob.author, { kind: 'human', id: 'bob' });

    // Alice asks Beta over HTTP while Bob's question is answered.
    const fromAlice = await ok(keys.alice!, '/channels/messages', { channelId, body: 'Draft the release note.', mentions: [{ participantId: 'pet:beta' }] });
    assert.deepEqual(fromAlice.author, { kind: 'human', id: 'alice' });
    const petMessages = async () => (await ok(keys.alice!, `/channels/context?channelId=${channelId}&limit=200`)).messages
      .filter((message: any) => message.author.kind === 'pet');
    await waitFor(async () => (await petMessages()).length === 2, 'both Pets answer');

    // Each Pet was told who wrote, by name, and answered that person.
    assert.deepEqual(inputs.map(({ petId, input }) => [petId, input.author]).sort(), [
      ['alpha', { participantId: 'human:bob', kind: 'human', label: 'Bob' }],
      ['beta', { participantId: 'human:alice', kind: 'human', label: 'Alice' }],
    ]);
    const replies = Object.fromEntries((await petMessages()).map((message: any) => [message.author.id, message]));
    assert.equal(replies.alpha.body, '[@Bob](participant:human:bob) Alpha heard Bob: Is the build green?');
    assert.deepEqual(replies.alpha.mentions, [{ participantId: 'human:bob', label: 'Bob' }]);
    assert.deepEqual(replies.beta.mentions, [{ participantId: 'human:alice', label: 'Alice' }]);

    // Both people read the same conversation, Bob through the CLI.
    const seenByBob = (await cli(bobKeyFile, ['channels', 'read', channelId])).messages.map((message: any) => message.author.id);
    const seenByAlice = (await ok(keys.alice!, `/channels/context?channelId=${channelId}`)).messages.map((message: any) => message.author.id);
    assert.deepEqual(seenByBob, seenByAlice);
    assert.deepEqual(new Set(seenByBob), new Set(['bob', 'alice', 'alpha', 'beta']));

    // Carol is not a member: no reading, speaking or listing, and no local-token routes.
    for (const path of [`/channels/context?channelId=${channelId}`, `/channels/members?channelId=${channelId}`]) {
      assert.equal((await call(keys.carol!, path)).status, 403, path);
    }
    assert.equal((await call(keys.carol!, '/channels/messages', { channelId, body: 'Let me in.' })).status, 403);
    assert.deepEqual((await ok(keys.carol!, '/channels')).channels, []);
    for (const path of ['/events', '/dispatch/queues', '/clients']) assert.equal((await call(keys.bob!, path)).status, 403, path);
    await assert.rejects(cli(bobKeyFile, ['queues']), /HTTP 403/);

    // A Channel Bob makes for himself stays his; only the local token lists every Channel.
    const bobsOwn = (await cli(bobKeyFile, ['channels', 'create', '--title', 'Bob notes', '--pet', 'beta'])).channel.channelId;
    assert.deepEqual((await ok(keys.alice!, '/channels')).channels.map((item: any) => item.channelId), [channelId]);
    assert.deepEqual(new Set((await ok(LOCAL_TOKEN, '/channels?all=true')).channels.map((item: any) => item.channelId)), new Set([channelId, bobsOwn]));

    // Alice removes Bob, who then can no longer read; Alice cannot leave as the last human.
    await ok(keys.alice!, '/channels/members/remove', { channelId, kind: 'human', id: 'bob' });
    await assert.rejects(cli(bobKeyFile, ['channels', 'read', channelId]), /HTTP 403/);
    assert.equal((await call(keys.alice!, '/channels/members/remove', { channelId, kind: 'human', id: 'alice' })).status, 409);
  } finally {
    await Promise.all(hosts.map(host => host.close()));
    await studio.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
