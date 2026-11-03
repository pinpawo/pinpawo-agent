import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { Deliverable } from '@pinpawo/agent-contracts';
import { defineInstructionDocument, readCapabilityExecutions } from '@pinpawo/pet-agent';
import { createArtifactsToolkit } from '@pinpawo-toolkit/artifacts';
import { createChannelPlugin } from '@pinpawo-plugin/channel';
import { buildHostRuntimeConfig, createResidentPetHost, FileSaver, loadPetDocumentFile } from 'pinpawo/host-runtime';
import { FileArtifactStore } from '../../../services/host/src/artifactStore';
import { readLocalArtifactSource } from '../../../services/host/src/artifactSourceReader';
import { handleAgentSessionHttp } from '../../../services/host/src/wire/agentSessionHttp';
import { createTestModelProfiles } from '../../../services/host/src/testing/modelProfiles';
import { buildHostToolkitInventory, HostToolkitInventoryStore } from '../../../services/host/src/toolkits/toolkitInventory';
import { HostGraphService } from '../../../services/host/src/agent/agentGraphService';
import type { AgentChannelSetup } from '../../../services/host/src/agent/agentChannel';
import { createStudioWithPets } from '../../support/livePets';
import { readChannelTestInput, type ChannelTestInput } from '../../support/channelDispatchInput';
import { createInvocationContextBridge } from './invocationContextBridge';

class ScriptedModel extends BaseChatModel {
  private index = 0;
  constructor(private readonly reply: (messages: BaseMessage[], index: number) => AIMessage | Promise<AIMessage>) { super({}); }
  _llmType() { return 'session-artifacts-integration'; }
  bindTools() { return this; }
  async _generate(messages: BaseMessage[]) {
    const message = await this.reply(messages, this.index++);
    return { generations: [{ message, text: message.text }] };
  }
}

const call = (name: string, args: Record<string, unknown>, id: string) =>
  new AIMessage({ content: '', tool_calls: [{ name, args, id }] });

async function waitFor(done: () => boolean | Promise<boolean>) {
  for (let index = 0; index < 3000; index++) {
    if (await done()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for the published file handoff.');
}

test('published snapshots follow accepted replies through Channel and can be downloaded by another Pet and HTTP client', async () => {
  const root = await mkdtemp(join(tmpdir(), 'session-artifacts-e2e-'));
  const storageRoot = join(root, 'storage');
  const bytes = Buffer.from([0, 1, 2, 255, 0, 128, 10]);
  const publicReply = '[@Reviewer](participant:pet:reviewer) Inspect the completed report.';
  const channel = createChannelPlugin({ httpRoute: false });
  const bridge = createInvocationContextBridge();
  const hosts = new Map<string, Awaited<ReturnType<typeof createResidentPetHost>>>();
  const setups = new Map<string, AgentChannelSetup>();
  const services = new Map<string, HostGraphService>();
  const stores = new Map<string, FileArtifactStore>();
  const liveDeliverables: Deliverable[][] = [];
  let accepted: Deliverable | undefined, rejected: Deliverable | undefined;
  let received: ChannelTestInput | undefined, downloaded: string | undefined;
  let studio: Awaited<ReturnType<typeof createStudioWithPets>> | undefined;
  let server: Server | undefined;
  const httpRequests: Promise<void>[] = [];
  const httpErrors: unknown[] = [];
  const lastTool = (messages: BaseMessage[], name: string) => {
    const result = messages.filter(ToolMessage.isInstance).filter(message => message.name === name).at(-1);
    assert.ok(result, `Missing real ${name} result`);
    return result;
  };
  try {
    for (const petId of ['writer', 'reviewer']) {
      const runtime = buildHostRuntimeConfig(join(root, petId));
      await mkdir(runtime.workdir, { recursive: true });
      await writeFile(join(runtime.workdir, 'PET.md'), `# ${petId}\nProduce and review the requested report.\n`);
      if (petId === 'writer') {
        await writeFile(join(runtime.workdir, 'draft.txt'), 'Earlier draft');
        await writeFile(join(runtime.workdir, 'final.bin'), bytes);
      }
      const petDocument = await loadPetDocumentFile(join(runtime.workdir, 'PET.md'));
      assert.ok(petDocument);
      const store = new FileArtifactStore(storageRoot, basename(runtime.sessionRoot));
      stores.set(petId, store);
      const artifacts = createArtifactsToolkit({ store, sourceReader: readLocalArtifactSource, tempRoot: join(root, 'downloads', petId) });
      const inventory = await buildHostToolkitInventory({ sources: [
        { id: 'artifacts', kind: 'plugin', definitions: [artifacts] },
        { id: 'channel', kind: 'plugin', definitions: channel.toolkits },
      ] });
      const entry = new ScriptedModel(messages => {
        if (petId === 'reviewer') {
          received = readChannelTestInput([...messages].reverse().find(message => message._getType() === 'human')!.text);
          assert.deepEqual(received.deliverables, [accepted]);
        }
        return call('plan_request', { goal: petId === 'writer' ? 'Publish the final report.' : 'Download and inspect the report.' }, `entry-${petId}`);
      });
      const supervisor = new ScriptedModel((messages, index) => {
        if (petId === 'reviewer') return [
          call('submit_plan', { tasks: [{ capability: 'general', objective: 'Download the report.' }] }, 'reviewer-plan'),
          call('delegate_capability', { briefing: 'Download the received report reference and verify its local bytes.' }, 'reviewer-delegate'),
          call('review_current', { completed: true, reason: 'The report was downloaded and checked.' }, 'reviewer-accept'),
          new AIMessage('Downloaded and inspected the report.'),
        ][index]!;
        if (index === 2 || index === 4) {
          const references = JSON.parse(lastTool(messages, 'delegate_capability').text).deliverables as Deliverable[];
          assert.equal(references.length, 1);
          if (index === 2) rejected = references[0]; else accepted = references[0];
        }
        return [
          call('submit_plan', { tasks: [{ capability: 'general', objective: 'Publish the report.' }] }, 'writer-plan'),
          call('delegate_capability', { briefing: 'Publish draft.txt as the initial report.' }, 'writer-first'),
          call('review_current', { completed: false, reason: 'Publish the corrected binary report instead.' }, 'writer-reject'),
          call('delegate_capability', { briefing: 'Publish final.bin as the corrected report.' }, 'writer-final'),
          call('review_current', { completed: true, reason: 'The corrected report is published.' }, 'writer-accept'),
          new AIMessage(publicReply),
        ][index]!;
      });
      const executor = new ScriptedModel(async (messages, index) => {
        if (petId === 'writer') return [
          call('publish_artifact', { path: 'draft.txt', title: 'Draft report' }, 'publish-draft'), new AIMessage('Draft published.'),
          call('publish_artifact', { path: 'final.bin', title: 'Final report' }, 'publish-final'), new AIMessage('Final report published.'),
        ][index]!;
        if (index === 0) return call('list_artifacts', {}, 'list-reviewer');
        if (index === 1) {
          const listing = lastTool(messages, 'list_artifacts');
          assert.equal(listing.status, 'success');
          assert.ok(!listing.text.includes(accepted!.uri), 'the Reviewer cannot list another session publication');
          return call('download_artifact', { uri: accepted!.uri }, 'download-report');
        }
        const result = JSON.parse(lastTool(messages, 'download_artifact').text) as { path: string };
        downloaded = result.path;
        assert.deepEqual(await readFile(result.path), bytes);
        return new AIMessage('Downloaded report bytes match.');
      });
      const service = new HostGraphService();
      services.set(petId, service);
      const withModels = (setup: AgentChannelSetup): AgentChannelSetup => ({ ...setup,
        graphConfig: { ...setup.graphConfig, models: { answer: entry, act: supervisor, subagent: executor } },
      });
      const host = await createResidentPetHost({ petId, petName: petId, runtimeConfig: runtime,
        resolveInvocationContext: bridge.resolveInvocationContext, modelProfiles: createTestModelProfiles(),
        toolAuthorizationMode: 'full_access', autoAuthorizationSafetyLevel: 'strict', petDocument,
        capabilities: [{ name: 'general', description: 'Publish or inspect a report.', uses: ['artifacts'],
          instructions: defineInstructionDocument({ content: 'Use the requested artifact operation and report its result.' }) }],
        toolkitInventory: new HostToolkitInventoryStore(inventory), checkpointer: new FileSaver(runtime.checkpointPath),
        sessionStatePath: runtime.tuiSessionPath,
        graphService: {
          readThreadState: (setup: AgentChannelSetup) => service.readThreadState(withModels(setup)),
          streamEvents: (setup: AgentChannelSetup) => { setups.set(petId, withModels(setup)); return service.streamEvents(withModels(setup)); },
        } as never,
      });
      if (petId === 'writer') host.resident.dispatch.onDispatchLifecycle(event => {
        if (event.state === 'message' && event.message) liveDeliverables.push(event.message.deliverables ?? []);
      });
      hosts.set(petId, host);
    }
    studio = await createStudioWithPets({ studioId: 'published-files', plugins: [channel],
      onPreparedContextResolver: bridge.onPreparedContextResolver,
      storage: { kind: 'sqlite', path: join(root, 'channel.sqlite') },
      pets: [...hosts].map(([petId, host]) => ({ registration: { petId, name: petId }, dispatch: host.resident.dispatch })),
    });
    const me = { kind: 'human' as const, id: 'local' };
    const channelId = (await channel.service.createChannel(me, { title: 'Reports', pets: ['writer', 'reviewer'] }, { studio: true })).channel.channelId;
    await channel.sendMessage(channelId, { body: 'Publish the corrected report and hand it to Reviewer.', mentions: [{ participantId: 'pet:writer' }] }, me);
    await waitFor(async () => downloaded !== undefined && (await channel.service.readContext(me, channelId)).messages.some(message => message.author.id === 'reviewer'));
    assert.ok(accepted && rejected && received && downloaded);
    assert.notEqual(accepted.uri, rejected.uri);
    const sent = (await channel.service.readContext(me, channelId)).messages.find(message => message.author.id === 'writer')!;
    assert.equal(sent.body, publicReply);
    assert.deepEqual(sent.deliverables, [accepted]);
    assert.deepEqual(liveDeliverables.at(-1), [accepted]);
    const state = await services.get('writer')!.readThreadState(setups.get('writer')!);
    assert.deepEqual(readCapabilityExecutions(state.messages).map(record => record.result.deliverables), [[rejected], [accepted]]);
    const binding = (await channel.service.listSessions(me, channelId)).find(session => session.petId === 'writer')!;
    const snapshot = await hosts.get('writer')!.sessions.snapshot(binding.sessionId);
    const visible = snapshot.session.timeline.find(entry => entry.type === 'message' && entry.text === publicReply);
    assert.ok(visible?.type === 'message');
    assert.deepEqual(visible.deliverables, [accepted]);
    const db = new DatabaseSync(join(root, 'channel.sqlite'), { readOnly: true });
    try {
      const row = db.prepare('SELECT data FROM channel_messages WHERE message_id = ?').get(sent.messageId);
      assert.deepEqual(JSON.parse(String(row!.data)).deliverables, [accepted]);
    } finally { db.close(); }
    await rm(join(root, 'writer', 'draft.txt'));
    await rm(join(root, 'writer', 'final.bin'));
    const historical = await stores.get('reviewer')!.fetch(rejected.uri);
    assert.ok('body' in historical);
    assert.equal(await new Response(historical.body).text(), 'Earlier draft', 'rejected publications remain stored');
    server = createServer((request, response) => {
      const operation = handleAgentSessionHttp(request, response, new Map(), 'artifact-test-token', uri => stores.get('reviewer')!.fetch(uri))
        .catch(error => {
          httpErrors.push(error);
          if (response.headersSent) response.destroy(error as Error);
          else { response.writeHead(500); response.end(String(error)); }
        });
      httpRequests.push(operation);
    });
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}/agent-session/artifacts?uri=${encodeURIComponent(accepted.uri)}`;
    assert.equal((await fetch(url)).status, 401);
    const opened = await fetch(url, { headers: { Authorization: 'Bearer artifact-test-token' } });
    assert.equal(opened.status, 200);
    assert.equal(opened.headers.get('content-type'), 'application/octet-stream');
    assert.deepEqual(Buffer.from(await opened.arrayBuffer()), bytes, 'HTTP opens the immutable snapshot after source deletion');
    await Promise.all(httpRequests);
    assert.deepEqual(httpErrors, []);
  } finally {
    await Promise.allSettled(httpRequests);
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); }
    await Promise.all([...hosts.values()].map(host => host.close()));
    await studio?.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
