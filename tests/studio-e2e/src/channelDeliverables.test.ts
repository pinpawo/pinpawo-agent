import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { createToolDeliverables } from '@pinpawo/agent-contracts';
import { defineInstructionDocument, readCapabilityExecutions } from '@pinpawo/pet-agent';
import { createChannelPlugin } from '@pinpawo-plugin/channel';
import { buildHostRuntimeConfig, createResidentPetHost, FileSaver, loadPetDocumentFile, type PetDispatchMessage } from 'pinpawo/host-runtime';
import { createTestModelProfiles } from '../../../services/host/src/testing/modelProfiles';
import { buildHostToolkitInventory, HostToolkitInventoryStore } from '../../../services/host/src/toolkits/toolkitInventory';
import { HostGraphService } from '../../../services/host/src/agent/agentGraphService';
import type { AgentChannelSetup } from '../../../services/host/src/agent/agentChannel';
import { createStudioWithPets } from '../../support/livePets';
import { readChannelTestInput, type ChannelTestInput } from '../../support/channelDispatchInput';
import { createInvocationContextBridge } from './invocationContextBridge';

class ScriptedModel extends BaseChatModel {
  private index = 0;
  constructor(private readonly reply: (messages: BaseMessage[], index: number) => AIMessage) { super({}); }
  _llmType() { return 'channel-deliverables-test'; }
  bindTools() { return this; }
  async _generate(messages: BaseMessage[]) {
    const message = this.reply(messages, this.index++);
    return { generations: [{ message, text: message.text }] };
  }
}

const call = (name: string, args: Record<string, unknown>, id: string) =>
  new AIMessage({ content: '', tool_calls: [{ name, args, id }] });

async function waitFor(done: () => boolean | Promise<boolean>) {
  for (let index = 0; index < 1000; index++) {
    if (await done()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for the structured report handoff.');
}

test('accepted tool deliverables reach Host, SQLite Channel messages and an addressed Pet without prose links', async () => {
  const root = await mkdtemp(join(tmpdir(), 'channel-deliverables-'));
  const me = { kind: 'human' as const, id: 'local' };
  const rejected = { uri: 'artifact://fixture/rejected', title: 'Superseded report' };
  const accepted = { uri: 'artifact://fixture/accepted', title: 'Final report' };
  const publicReply = '[@Reviewer](participant:pet:reviewer) Please inspect the completed report.';
  const publications: string[] = [];
  const publish = tool(({ attempt }) => {
    publications.push(attempt);
    return ['Report published.', createToolDeliverables([attempt === 'first' ? rejected : accepted])];
  }, { name: 'publish_report', description: 'Publish a report reference.', schema: z.object({ attempt: z.enum(['first', 'final']) }),
    responseFormat: 'content_and_artifact' });
  const channel = createChannelPlugin({ httpRoute: false });
  const contextBridge = createInvocationContextBridge();
  const hosts = new Map<string, Awaited<ReturnType<typeof createResidentPetHost>>>();
  const setups = new Map<string, AgentChannelSetup>();
  const savers = new Map<string, FileSaver>();
  const services = new Map<string, HostGraphService>();
  const completions: PetDispatchMessage[] = [];
  let received: ChannelTestInput | undefined;
  let studio: Awaited<ReturnType<typeof createStudioWithPets>> | undefined;
  try {
    const inventory = await buildHostToolkitInventory({ sources: [
      { id: 'reports', kind: 'plugin', definitions: [{ name: 'reports', description: 'Publish reports.', tools: [{ tool: publish }] }] },
      { id: 'channel', kind: 'plugin', definitions: channel.toolkits },
    ] });
    for (const petId of ['writer', 'reviewer']) {
      const config = buildHostRuntimeConfig(join(root, petId));
      await mkdir(config.workdir, { recursive: true });
      const petPath = join(config.workdir, 'PET.md');
      await writeFile(petPath, `# ${petId}\n\nProduce and review the requested report.\n`);
      const petDocument = await loadPetDocumentFile(petPath);
      assert.ok(petDocument);
      const entry = new ScriptedModel(messages => {
        if (petId === 'writer') return call('plan_request', { goal: 'Publish a completed report.' }, 'entry');
        received = readChannelTestInput([...messages].reverse().find(message => message._getType() === 'human')!.text);
        return new AIMessage('Review received.');
      });
      const supervisor = new ScriptedModel((messages, index) => {
        const decisions = [
          call('submit_plan', { tasks: [{ capability: 'general', objective: 'Publish the report.' }] }, 'plan'),
          call('delegate_capability', { briefing: 'Publish a first report.' }, 'delegate-first'),
          call('review_current', { completed: false, reason: 'The report needs the final correction.' }, 'reject-first'),
          call('delegate_capability', { briefing: 'Publish the corrected final report.' }, 'delegate-final'),
          call('review_current', { completed: true, reason: 'The corrected report is complete.' }, 'accept-final'),
          new AIMessage(publicReply),
        ];
        if (index === 4) {
          const result = messages.filter(ToolMessage.isInstance).filter(message => message.name === 'delegate_capability').at(-1)!;
          assert.deepEqual(JSON.parse(result.text).deliverables, [accepted]);
        }
        assert.ok(decisions[index], 'unexpected extra Supervisor invocation');
        return decisions[index]!;
      });
      const executor = new ScriptedModel((_messages, index) => {
        const steps = [call('publish_report', { attempt: 'first' }, 'publish-first'), new AIMessage('First report.'),
          call('publish_report', { attempt: 'final' }, 'publish-final'), new AIMessage('Corrected report.')];
        assert.ok(steps[index], 'unexpected extra Capability invocation');
        return steps[index]!;
      });
      const service = new HostGraphService();
      services.set(petId, service);
      const saver = new FileSaver(config.checkpointPath);
      savers.set(petId, saver);
      const withModels = (setup: AgentChannelSetup): AgentChannelSetup => ({ ...setup,
        graphConfig: { ...setup.graphConfig, models: { answer: entry, act: supervisor, subagent: executor } },
      });
      const host = await createResidentPetHost({ petId, petName: petId === 'writer' ? 'Writer' : 'Reviewer', runtimeConfig: config,
        resolveInvocationContext: contextBridge.resolveInvocationContext, modelProfiles: createTestModelProfiles(),
        toolAuthorizationMode: 'full_access', autoAuthorizationSafetyLevel: 'strict',
        capabilities: petId === 'writer' ? [{ name: 'general', description: 'Produce a report.', uses: ['reports'],
          instructions: defineInstructionDocument({ content: 'Publish the report and return the work completed.' }) }] : [],
        petDocument, toolkitInventory: new HostToolkitInventoryStore(inventory), checkpointer: saver, sessionStatePath: config.tuiSessionPath,
        graphService: {
          readThreadState: (setup: AgentChannelSetup) => service.readThreadState(withModels(setup)),
          streamEvents: (setup: AgentChannelSetup) => { setups.set(petId, withModels(setup)); return service.streamEvents(withModels(setup)); },
        } as never,
      });
      if (petId === 'writer') host.resident.dispatch.onDispatchLifecycle(event => {
        if (event.state === 'message' && event.message) completions.push(event.message);
      });
      hosts.set(petId, host);
    }
    studio = await createStudioWithPets({ studioId: 'deliverables', plugins: [channel],
      onPreparedContextResolver: contextBridge.onPreparedContextResolver,
      storage: { kind: 'sqlite', path: join(root, 'channel.sqlite') },
      pets: [...hosts].map(([petId, host]) => ({ registration: { petId, name: petId === 'writer' ? 'Writer' : 'Reviewer' }, dispatch: host.resident.dispatch })),
    });
    const channelId = (await channel.service.createChannel(me, { title: 'Reports', pets: ['writer', 'reviewer'] }, { studio: true })).channel.channelId;
    await channel.sendMessage(channelId, { body: 'Produce the final report and ask Reviewer to inspect it.', mentions: [{ participantId: 'pet:writer' }] }, me);
    await waitFor(async () => received !== undefined && (await channel.service.readContext(me, channelId)).messages.some(message => message.author.id === 'reviewer'));
    const sent = (await channel.service.readContext(me, channelId)).messages.find(message => message.author.id === 'writer')!;
    assert.equal(sent.body, publicReply);
    assert.ok(!sent.body.includes('artifact://'), 'the public body never needs to contain a reference link');
    assert.deepEqual(sent.deliverables, [accepted]);
    assert.deepEqual(completions.at(-1)?.deliverables, [accepted], 'real Host message.completed carries selected references');
    assert.deepEqual(received?.deliverables, [accepted], 'the addressed Pet receives structured references');
    assert.equal(received?.body, publicReply);
    assert.deepEqual(publications, ['first', 'final']);
    const setup = setups.get('writer')!;
    const state = await services.get('writer')!.readThreadState(setup);
    assert.deepEqual(readCapabilityExecutions(state.messages).map(({ result }) => result.deliverables), [[rejected], [accepted]],
      'both attempts remain execution facts, while only the accepted one is public');
    const reply = state.messages.find(message => message.text === publicReply)!;
    assert.deepEqual((reply.additional_kwargs?.pinpawo as { deliverables?: unknown })?.deliverables, [accepted]);
    const childReferences: unknown[] = [];
    for await (const checkpoint of savers.get('writer')!.list({})) {
      if (checkpoint.config.configurable?.checkpoint_ns?.startsWith('capability:')) {
        const refs = checkpoint.checkpoint.channel_values.deliverables;
        if (Array.isArray(refs) && refs.length) childReferences.push(refs);
      }
    }
    assert.ok(childReferences.some(refs => JSON.stringify(refs) === JSON.stringify([accepted])), 'the Capability child checkpoint owns its accumulated declarations');
    const binding = (await channel.service.listSessions(me, channelId)).find(session => session.petId === 'writer')!;
    const snapshot = await hosts.get('writer')!.sessions.snapshot(binding.sessionId);
    const visible = snapshot.session.timeline.find(entry => entry.type === 'message' && entry.text === publicReply);
    assert.ok(visible?.type === 'message');
    assert.deepEqual(visible.deliverables, [accepted]);
    const db = new DatabaseSync(join(root, 'channel.sqlite'), { readOnly: true });
    try {
      const row = db.prepare('SELECT data FROM channel_messages WHERE message_id = ?').get(sent.messageId);
      assert.ok(typeof row?.data === 'string');
      assert.deepEqual(JSON.parse(row.data).deliverables, [accepted], 'a fresh SQLite reader sees the persisted public references');
    } finally { db.close(); }
  } finally {
    await Promise.all([...hosts.values()].map(host => host.close()));
    await studio?.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
