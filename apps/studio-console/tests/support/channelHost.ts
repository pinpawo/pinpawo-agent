import { readChannelTestTask } from '../../../../tests/support/channelDispatchInput';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import { Annotation, Command, END, START, StateGraph, interrupt } from '@langchain/langgraph';
import { buildReviewSpec, readPendingInterrupt } from '@pinpawo/pet-agent';

import { createStudioHttpPlugin, type StudioHttpRoutesHook } from '@pinpawo-plugin/studio-http';
import { prepareStudio, type StudioPetAssembler, type StudioPlugin } from '@pinpawo/studio-core';
import { createChannelPlugin } from '../../../../plugins/channel/src/channelPlugin';
import { buildHostRuntimeConfig, createResidentPetHost, FileSaver, readPetInvocationContext } from 'pinpawo/host-runtime';
import { createTestModelProfiles } from '../../../../services/host/src/testing/modelProfiles';
import { HostToolkitInventoryStore } from '../../../../services/host/src/toolkits/toolkitInventory';
import type { AgentChannelSetup } from '../../../../services/host/src/agent/agentChannel';
import type { InterruptResume } from '../../../../services/host/src/agent/agentGraphService';

function fixtureReply(text: string) {
  return new AIMessage({ content: text, usage_metadata: {
    input_tokens: 100, output_tokens: 20, total_tokens: 120, input_token_details: { cache_read: 50 },
  } });
}

// Real Host, storage and HTTP paths; only the graph's response is deterministic.
const root = process.env.CHANNEL_HOST_TEST_ROOT ?? await mkdtemp(join(tmpdir(), 'channel-console-browser-'));
const token = 'console-browser-test-only';
const http = createStudioHttpPlugin({ port: Number(process.env.CHANNEL_HOST_TEST_PORT ?? 0), authToken: token, allowedOrigins: ['http://127.0.0.1:5199'] });
const channel = createChannelPlugin();
// Fixture-only entrance to the existing Channel run API. Sending a Timeline
// message remains independent of execution, including in browser regressions.
let removeRunRoute: (() => void) | undefined;
const explicitRuns: StudioPlugin = {
  name: 'browser-channel-runs',
  toolkits: [],
  start: context => {
    removeRunRoute = context.hooks.contribute<StudioHttpRoutesHook>('http', 'routes', routes => routes.register({
      method: 'POST', path: '/test/channel-run', authorization: 'studio',
      handle: async ({ readJson }) => {
        const input = await readJson() as { channelId: string; petId: string; request: string };
        return { kind: 'json', status: 202, body: await channel.run(input.channelId, input.petId, input.request,
          { kind: 'trigger', id: 'browser-fixture' }) };
      },
    }));
  },
  stop: () => { removeRunRoute?.(); removeRunRoute = undefined; },
};
const read = channel.toolkits[0]!.tools.find(entry => entry.tool.name === 'channel_read_context')!.tool;
const petNames = process.env.CHANNEL_HOST_TEST_DUPLICATE_NAMES ? ['Analyst', 'Analyst'] : ['Alpha', 'Beta'];
// The real Console creates an owner Channel first, then assembles independent
// instances from these reusable definitions. Runtime state is keyed by instance.
const definitions = ['alpha', 'beta'].map((definitionId, index) => ({ definitionId, name: petNames[index]! }));
const assemblePet: StudioPetAssembler = async ({ petId, name }) => {
  const runtimeConfig = buildHostRuntimeConfig(join(root, petId));
  const checkpointer = new FileSaver(runtimeConfig.checkpointPath);
  const State = Annotation.Root({ messages: Annotation<BaseMessage[]>({ reducer: (a, b) => [...a, ...b], default: () => [] }) });
  const graph = new StateGraph(State).addNode('reply', async state => {
    const raw = state.messages.at(-1)!.text;
    const input = /^`{3,}json\n/.test(raw) ? readChannelTestTask(raw) : undefined;
    const last = input?.body ?? raw;
    // The Console composer puts a picked @ first; fixture commands follow it.
    const command = last.replace(/^\[@[^\]]*\]\(participant:[^)\s]+\)\s*/, '');
    if (last === 'fail-provider') throw new Error('Deterministic provider denied request (403).');
    if (command === 'review') interrupt({ kind: 'review', review: buildReviewSpec({ id: 'fixture-review',
      view: { kind: 'plain', body: 'Authorize fixture tool?' }, options: [{ id: 'approve', label: 'Approve', decision: { type: 'approve' },
        effects: [{ type: 'graph.authorize_tool_action', scope: 'thread' }] }],
    }) });
    await new Promise(resolve => setTimeout(resolve, last === 'queue-hold' ? 5000 : 300));
    const invocation = readPetInvocationContext()!;
    if (invocation.scope?.namespace !== 'channel') {
      return { messages: [fixtureReply('Standalone deterministic reply. Inspect this Pet session for the result.')] };
    }
    const siblings = (await prepared.studio.pets.list()).filter(pet => pet.channelId === invocation.scope!.id && !pet.closedAt);
    const alpha = siblings.find(pet => pet.definitionId === 'alpha');
    const beta = siblings.find(pet => pet.definitionId === 'beta');
    if (command === 'handoff' && beta) return { messages: [fixtureReply(`[@Beta](participant:pet:${beta.petId}) Please inspect this delivery.`)] };
    if (beta && alpha && last === `[@Beta](participant:pet:${beta.petId}) Please inspect this delivery.`) {
      return { messages: [fixtureReply(`[@Alpha](participant:pet:${alpha.petId}) Inspection complete; deliver the result.`)] };
    }
    if (alpha && last === `[@Alpha](participant:pet:${alpha.petId}) Inspection complete; deliver the result.`) {
      return { messages: [fixtureReply('[@Me](participant:human:local) Result delivered.')] };
    }
    const snapshot = JSON.parse(await read.invoke({ limit: 200 }) as string) as { messages: Array<{ author: { kind: string } }> };
    const prior = snapshot.messages.filter(entry => entry.author.kind === 'pet');
    return { messages: [fixtureReply(`Public delivery from ${petId}.\n\nQuoted request:\n> ${last.replace(/\n/g, '\n> ')}\n\nTask origin: ${input ? `${input.origin.kind}:${input.origin.id}` : 'direct dispatch'}.\n\nSession: ${invocation.sessionId}\n\nPrior public deliveries read: ${prior.length}.\n\nFull handoff evidence: checked the Channel title, members and messages. Remaining work: user acceptance.`)] };
  }).addEdge(START, 'reply').addEdge('reply', END).compile({ checkpointer });
  const config = (setup: AgentChannelSetup) => ({ configurable: { thread_id: setup.input.threadId } });
  const host = await createResidentPetHost({ petId, petName: name, runtimeConfig,
    modelProfiles: createTestModelProfiles(), toolAuthorizationMode: 'require_authorization', autoAuthorizationSafetyLevel: 'strict',
    capabilities: [], toolkitInventory: new HostToolkitInventoryStore(), checkpointer, sessionStatePath: runtimeConfig.tuiSessionPath,
    resolveInvocationContext: async target => prepared.resolveInvocationContext(target),
    graphService: {
      async readThreadState(setup: AgentChannelSetup) {
        const snapshot = await graph.getState(config(setup));
        return { messages: snapshot.values.messages ?? [], pendingInterrupt: readPendingInterrupt(snapshot),
          acceptsResume: snapshot.next.length > 0 || snapshot.tasks.length > 0, currentPlan: null };
      },
      async streamEvents(setup: AgentChannelSetup, resume?: InterruptResume) {
        return graph.streamEvents(resume ? new Command({ resume: { [resume.interruptId]: resume.value } }) : { messages: setup.input.messages },
          { ...config(setup), version: 'v3' });
      },
    } as never,
  });
  return { dispatch: host.resident.dispatch, sessions: host.sessions, close: () => host.close() };
};
const prepared = prepareStudio({ studioId: 'console-browser', plugins: [channel, http, explicitRuns],
  storage: { kind: 'sqlite', path: join(root, 'channel.sqlite') },
  definitions, assemblePet,
});
const studio = prepared.studio;
await prepared.restorePets();
await prepared.activatePlugins();
// Historical fixture data lives only in this temporary database. No model calls.
if (process.env.CHANNEL_HOST_TEST_LAYOUT_SEED) {
  const { channel: seeded } = await channel.service.createChannel({ kind: 'human', id: 'local' },
    { title: 'Layout investigation', description: 'Review public evidence and choose the next round.', pets: [] });
  for (const definition of definitions) await studio.pets.create({ petId: definition.definitionId, definitionId: definition.definitionId,
    name: definition.name, channelId: seeded.channelId });
  // A real removed instance retains its identity and public history.
  await studio.pets.create({ petId: 'retired-pet', definitionId: 'alpha', name: 'retired-pet', channelId: seeded.channelId });
  await channel.service.postMessage({ kind: 'pet', id: 'retired-pet' }, seeded.channelId,
    { body: 'Historical public delivery from a Pet that is no longer registered.' });
  await studio.pets.removeInstance('retired-pet', { confirmStop: true });
}
console.log(JSON.stringify({ ready: true, url: `http://127.0.0.1:${http.address()!.port}`, token }));
let closing = false;
const close = async () => {
  if (closing) return; closing = true;
  await studio.shutdown();
  if (!process.env.CHANNEL_HOST_TEST_ROOT) await rm(root, { recursive: true, force: true });
  process.exit(0);
};
process.on('SIGTERM', () => { void close(); });
process.on('SIGINT', () => { void close(); });
