import { readChannelTestInput } from '../../../../tests/support/channelDispatchInput';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import { Annotation, Command, END, START, StateGraph, interrupt } from '@langchain/langgraph';
import { buildReviewSpec, readPendingInterrupt } from '@pinpawo/pet-agent';
import { createStudio } from '@pinpawo/studio';
import { createStudioHttpPlugin } from '@pinpawo-plugin/studio-http';
import { createChannelPlugin } from '../../../../plugins/channel/src/channelPlugin';
import { buildHostRuntimeConfig, createResidentPetHost, FileSaver, readPetInvocationContext } from 'pinpawo/host-runtime';
import { createTestModelProfiles } from '../../../../services/host/src/testing/modelProfiles';
import { HostToolkitInventoryStore } from '../../../../services/host/src/toolkits/toolkitInventory';
import type { AgentChannelSetup } from '../../../../services/host/src/agent/agentChannel';
import type { InterruptResume } from '../../../../services/host/src/agent/agentGraphService';

// Real Host, storage and HTTP paths; only the graph's response is deterministic.
const root = process.env.CHANNEL_HOST_TEST_ROOT ?? await mkdtemp(join(tmpdir(), 'channel-console-browser-'));
const token = 'console-browser-test-only';
const http = createStudioHttpPlugin({ port: Number(process.env.CHANNEL_HOST_TEST_PORT ?? 0), authToken: token, allowedOrigins: ['http://127.0.0.1:5199'] });
const channel = createChannelPlugin({ databasePath: join(root, 'channel.sqlite') });
const read = channel.toolkits[0]!.tools.find(entry => entry.tool.name === 'channel_read_context')!.tool;
const hosts: Awaited<ReturnType<typeof createResidentPetHost>>[] = [];
const petNames = process.env.CHANNEL_HOST_TEST_DUPLICATE_NAMES ? ['Analyst', 'Analyst'] : ['Alpha', 'Beta'];
for (const petId of ['alpha', 'beta']) {
  const runtimeConfig = buildHostRuntimeConfig(join(root, petId));
  const checkpointer = new FileSaver(runtimeConfig.checkpointPath);
  const State = Annotation.Root({ messages: Annotation<BaseMessage[]>({ reducer: (a, b) => [...a, ...b], default: () => [] }) });
  const graph = new StateGraph(State).addNode('reply', async state => {
    const raw = state.messages.at(-1)!.text;
    const input = /^`{3,}json\n/.test(raw) ? readChannelTestInput(raw) : undefined;
    const last = input?.body ?? raw;
    if (last === 'fail-provider') throw new Error('Deterministic provider denied request (403).');
    if (last === 'review') interrupt({ kind: 'review', review: buildReviewSpec({ id: 'fixture-review',
      view: { kind: 'plain', body: 'Authorize fixture tool?' }, options: [{ id: 'approve', label: 'Approve', decision: { type: 'approve' },
        effects: [{ type: 'graph.authorize_tool_action', scope: 'thread' }] }],
    }) });
    await new Promise(resolve => setTimeout(resolve, last === 'queue-hold' ? 5000 : 300));
    const invocation = readPetInvocationContext()!;
    if (invocation.scope?.namespace !== 'channel') {
      return { messages: [new AIMessage('Standalone deterministic reply. Inspect this Pet session for the result.')] };
    }
    if (last === 'handoff' || last === 'handoff [@Alpha](participant:pet:alpha)') return { messages: [new AIMessage('[@Beta](participant:pet:beta) Please inspect this delivery.')] };
    if (last === '[@Beta](participant:pet:beta) Please inspect this delivery.') {
      return { messages: [new AIMessage('[@Alpha](participant:pet:alpha) Inspection complete; deliver the result.')] };
    }
    if (last === '[@Alpha](participant:pet:alpha) Inspection complete; deliver the result.') {
      return { messages: [new AIMessage('[@Me](participant:human:studio-operator) Result delivered.')] };
    }
    const snapshot = JSON.parse(await read.invoke({ limit: 200 }) as string);
    const prior = snapshot.history.entries.filter((entry: { kind: string; source?: unknown }) => entry.kind === 'message' && entry.source);
    return { messages: [new AIMessage(`Public delivery from ${petId}.\n\nQuoted request:\n> ${last.replace(/\n/g, '\n> ')}\n\nInput source: ${input?.author.participantId}. Message: ${input?.messageId}. Referenced message: ${input?.replyTo?.messageId ?? 'none'}.\n\nSession: ${invocation.sessionId}\n\nPrior public deliveries read: ${prior.length}.\n\nFull handoff evidence: checked the current Channel goal and scope. Remaining work: user acceptance.`)] };
  }).addEdge(START, 'reply').addEdge('reply', END).compile({ checkpointer });
  const config = (setup: AgentChannelSetup) => ({ configurable: { thread_id: setup.input.threadId } });
  hosts.push(await createResidentPetHost({ petId, petName: petId, runtimeConfig,
    modelProfiles: createTestModelProfiles(), toolAuthorizationMode: 'require_authorization', autoAuthorizationSafetyLevel: 'strict',
    capabilities: [], toolkitInventory: new HostToolkitInventoryStore(), checkpointer, sessionStatePath: runtimeConfig.tuiSessionPath,
    capabilityArtifactStore: { writeArtifact: async () => { throw Error('unused'); }, readArtifact: async () => { throw Error('unused'); },
      listArtifacts: async () => [], deleteThreadArtifacts: async () => {}, getDownloadUri: async uri => uri },
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
  }));
}
const studio = await createStudio({ studioId: 'console-browser', entryPetId: 'alpha', plugins: [channel, http],
  pets: hosts.map((host, index) => ({ registration: { petId: ['alpha', 'beta'][index]!, name: petNames[index]! },
    dispatch: host.resident.dispatch, sessions: host.sessions })),
});
// Historical fixture data lives only in this temporary database. No model calls.
if (process.env.CHANNEL_HOST_TEST_LAYOUT_SEED) {
  const goal = channel.service.createChannel({ title: 'Layout investigation', goal: 'Review public evidence and choose the next round.', scope: 'Keep real request and output associations visible.' }, { kind: 'human', id: 'studio-operator' });
  const binding = channel.service.reserveBinding(goal.channelId, 'retired-pet', () => 'retired-session');
  channel.service.confirmBinding(binding);
  const source = { petId: binding.petId, sessionId: binding.sessionId, invocationId: 'retired-invocation' };
  channel.service.recordExecution(goal.channelId, source, 'completed', new Date().toISOString());
  channel.service.recordOutput(goal.channelId, source, 'Historical public delivery from a Pet that is no longer registered.');
}
console.log(JSON.stringify({ ready: true, url: `http://127.0.0.1:${http.address()!.port}`, token }));
let closing = false;
const close = async () => {
  if (closing) return; closing = true;
  await Promise.all(hosts.map(host => host.close())); await studio.shutdown();
  if (!process.env.CHANNEL_HOST_TEST_ROOT) await rm(root, { recursive: true, force: true });
  process.exit(0);
};
process.on('SIGTERM', () => { void close(); });
process.on('SIGINT', () => { void close(); });
