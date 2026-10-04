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
for (const petId of ['alpha', 'beta']) {
  const runtimeConfig = buildHostRuntimeConfig(join(root, petId));
  const checkpointer = new FileSaver(runtimeConfig.checkpointPath);
  const State = Annotation.Root({ messages: Annotation<BaseMessage[]>({ reducer: (a, b) => [...a, ...b], default: () => [] }) });
  const graph = new StateGraph(State).addNode('reply', async state => {
    const last = state.messages.at(-1)!.text;
    if (last === 'fail-provider') throw new Error('Deterministic provider denied request (403).');
    if (last === 'review') interrupt({ kind: 'review', review: buildReviewSpec({ id: 'fixture-review',
      view: { kind: 'plain', body: 'Authorize fixture tool?' }, options: [{ id: 'approve', label: 'Approve', decision: { type: 'approve' },
        effects: [{ type: 'graph.authorize_tool_action', scope: 'thread' }] }],
    }) });
    await new Promise(resolve => setTimeout(resolve, 300));
    const snapshot = JSON.parse(await read.invoke({ limit: 200 }) as string);
    const prior = snapshot.history.entries.filter((entry: { kind: string; source?: unknown }) => entry.kind === 'message' && entry.source);
    const invocation = readPetInvocationContext()!;
    return { messages: [new AIMessage(`Public delivery from ${petId}.\n\nRequest: ${last}\n\nSession: ${invocation.sessionId}\n\nPrior public deliveries read: ${prior.length}.\n\nFull handoff evidence: checked the current Channel goal and scope. Remaining work: user acceptance.`)] };
  }).addEdge(START, 'reply').addEdge('reply', END).compile({ checkpointer });
  const config = (setup: AgentChannelSetup) => ({ configurable: { thread_id: setup.input.threadId } });
  hosts.push(await createResidentPetHost({ petId, petName: petId, runtimeConfig,
    modelProfiles: createTestModelProfiles(), globalReviewPolicyMode: 'require_authorization', autoAuthorizationSafetyLevel: 'strict',
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
  pets: hosts.map((host, index) => ({ registration: { petId: ['alpha', 'beta'][index]!, name: ['Alpha', 'Beta'][index]! }, dispatch: host.resident.dispatch })),
});
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
