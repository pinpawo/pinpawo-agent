import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from '@langchain/langgraph';
import { AIMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { FakeToolCallingModel } from 'langchain';
import { z } from 'zod';
import { buildOrchestratorRunInput, buildReviewSpec, compileAgentRegistry, createOrchestratorGraph,
  defineInstructionDocument, readPendingInterrupt, type AgentModels } from '@pinpawo/pet-agent';
import { withScriptedDelegation } from '../../../packages/pet-agent/src/agent/orchestrator/runSupervisor/testing';
import { createChannelPlugin } from '@pinpawo-plugin/channel';

import { buildHostRuntimeConfig, createResidentPetHost, FileSaver } from 'pinpawo/host-runtime';
import { createTestModelProfiles } from '../../../services/host/src/testing/modelProfiles';
import { HostToolkitInventoryStore } from '../../../services/host/src/toolkits/toolkitInventory';
import type { AgentChannelSetup } from '../../../services/host/src/agent/agentChannel';
import type { InterruptResume } from '../../../services/host/src/agent/agentGraphService';
import { createStudioWithPets } from '../../../tests/support/livePets';
import { createInvocationContextBridge } from './invocationContextBridge';

/** The local Host token's Studio client, as a Channel member. */
const me = { kind: 'human' as const, id: 'local' };

async function waitFor(done: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 1000; i++) { if (await done()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error('Timed out waiting for review/dispatch completion.');
}

for (const decision of ['reject', 'cancel'] as const) {
  test(`Channel review ${decision} releases queued messages and replyTo on the same binding`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'channel-review-stop-'));
    const runtimeConfig = buildHostRuntimeConfig(join(root, 'one'));
    const checkpointer = new FileSaver(runtimeConfig.checkpointPath);
    let entryCalls = 0, supervisorCalls = 0, toolRuns = 0, finalizes = 0;
    const rawTool = tool(async () => { toolRuns++; return 'executed'; }, {
      name: 'reviewed_action', description: 'Review action.', schema: z.object({}),
    });
    const registry = compileAgentRegistry({
      toolkits: [{ name: 'local', description: 'Local.', tools: [{ tool: rawTool, review: {
        request: () => buildReviewSpec({ view: { kind: 'plain', body: 'Authorize?' }, options: [
          { id: 'approve', label: 'Approve', decision: { type: 'approve' } },
          { id: 'reject', label: 'Reject', decision: { type: 'reject', message: 'Do not execute.' } },
        ] }),
      } }] }],
      capabilities: [{ name: 'general', description: 'General.', uses: ['local'],
        instructions: defineInstructionDocument({ content: 'Inspect and report.' }),
        lifecycle: { finalize: () => { finalizes++; } },
      }],
    });
    const entry = { bindTools: () => ({ invoke: async () => {
      entryCalls++;
      if (entryCalls === 1) return new AIMessage('Which destination?');
      return new AIMessage({ content: '', tool_calls: [{ id: `entry-${entryCalls}`,
        name: entryCalls === 2 ? 'plan_request' : 'continue',
        args: entryCalls === 2 ? { goal: 'Inspect and report.' } : {},
      }] });
    } }) } as unknown as AgentModels['act'];
    const graph = createOrchestratorGraph({
      models: { act: entry, answer: entry, subagent: new FakeToolCallingModel({
        toolCalls: [[{ id: 'reviewed-action', name: 'reviewed_action', args: {} }]],
      }) }, checkpoint: checkpointer,
      runSupervisorRunner: withScriptedDelegation({ invoke: async (input) => {
        supervisorCalls++;
        if (supervisorCalls === 1) return { name: 'submit_plan', args: { tasks: [
          { capability: 'general', objective: 'Inspect.' }, { capability: 'general', objective: 'Report.' },
        ] } };
        assert.deepEqual(input.state.plan.map(item => item.objective), ['Inspect.', 'Report.']);
        return { reply: `Fresh input ${supervisorCalls}: ${input.userRequest}` };
      } }),
    });
    const config = (setup: AgentChannelSetup) => ({ configurable: { thread_id: setup.input.threadId, registry,
      reviewCapabilities: { humanReview: true, sessionAuthorization: false },
      globalReviewPolicy: { mode: 'require_authorization' },
    } });
    const graphService = {
      async readThreadState(setup: AgentChannelSetup) {
        const snapshot = await graph.getState(config(setup));
        return { messages: snapshot.values.messages ?? [], pendingInterrupt: readPendingInterrupt(snapshot),
          acceptsResume: snapshot.next.length > 0, currentPlan: null };
      },
      streamEvents(setup: AgentChannelSetup, resume?: InterruptResume) {
        return graph.streamEvents(resume ? new Command({ resume: { [resume.interruptId]: resume.value } })
          : buildOrchestratorRunInput(setup.input.messages), { ...config(setup), version: 'v3' });
      },
    };
    const contextBridge = createInvocationContextBridge();
    const host = await createResidentPetHost({ petId: 'one', petName: 'One', runtimeConfig,
      resolveInvocationContext: contextBridge.resolveInvocationContext,
      modelProfiles: createTestModelProfiles(), toolAuthorizationMode: 'require_authorization', autoAuthorizationSafetyLevel: 'strict',
      capabilities: [], toolkitInventory: new HostToolkitInventoryStore(), checkpointer, sessionStatePath: runtimeConfig.tuiSessionPath,
      capabilityArtifactStore: { writeArtifact: async () => { throw Error('unused'); }, readArtifact: async () => { throw Error('unused'); },
        listArtifacts: async () => [], deleteThreadArtifacts: async () => {}, getDownloadUri: async uri => uri },
      graphService: graphService as never,
    });
    const channel = createChannelPlugin({ httpRoute: false });
    const studio = await createStudioWithPets({ studioId: 'review-stop', plugins: [channel],
      onPreparedContextResolver: contextBridge.onPreparedContextResolver,
      storage: { kind: 'sqlite', path: join(root, 'channel.sqlite') },
      pets: [{ registration: { petId: 'one', name: 'One' }, dispatch: host.resident.dispatch }],
    });
    const outputs = async (id: string) => (await channel.service.readContext(me, id)).messages.filter(message => message.author.kind === 'pet');
    const events: Array<{ type: string; payload?: any }> = [];
    studio.subscribe(event => { events.push(event); });
    try {
      const id = (await channel.service.createChannel(me, { title: 'Goal', pets: ['one'] })).channel.channelId;
      const ask = (body: string, replyTo?: string) => channel.sendMessage(id, { body, ...(replyTo ? { replyTo } : {}), mentions: [{ participantId: 'pet:one' }] }, me);
      await ask('Which destination?');
      await waitFor(async () => (await outputs(id)).length === 1);
      const question = (await outputs(id))[0]!;
      const { deliveries: [waiting] } = await ask('Inspect and report.');
      const binding = (await channel.service.getSession(id, 'one'))!;
      assert.equal(waiting!.sessionId, binding.sessionId);
      await waitFor(() => events.some(event => event.type === 'dispatch.waiting' && event.payload.invocationId === waiting!.invocationId));
      assert.equal((await outputs(id)).length, 1, 'a waiting review is not a Channel message');
      await ask('Continue with different constraints.');
      await ask('Use staging.', question.messageId);
      await waitFor(() => host.resident.dispatch.getQueueSnapshot().queuedDispatches === 2);
      assert.deepEqual([entryCalls, supervisorCalls, toolRuns, finalizes], [2, 1, 0, 0]);
      await host.interaction.request({ type: 'session.resume', requestId: 'select', sessionId: binding.sessionId });
      const snapshot = await host.interaction.snapshot();
      if (snapshot.type !== 'session.snapshot.result') throw Error('snapshot');
      const pending = snapshot.snapshot.session.pendingInterrupt;
      assert.ok(pending);
      await host.interaction.request({ type: 'interrupt.resume', requestId: 'decline', interruptId: pending.interruptId,
        value: decision === 'cancel' ? { action: 'cancel' }
          : { decisions: [{ interactionId: 'tool-review:reviewed_action:reviewed-action', selectedOptionId: 'reject' }] },
      });
      await waitFor(async () => (await outputs(id)).length === 4 && host.resident.dispatch.getQueueSnapshot().queuedDispatches === 0);
      assert.deepEqual([entryCalls, supervisorCalls, toolRuns, finalizes], [4, 3, 0, 0]);
      assert.equal((await channel.service.getSession(id, 'one'))?.sessionId, binding.sessionId);
      // The declined dispatch reports its own ending to the Channel before queued work runs.
      const replyOf = (externalRef?: string) => events.find(event => event.type === 'dispatch.message' && event.payload.message.messageId === externalRef)?.payload;
      assert.equal(replyOf((await outputs(id))[1]!.externalRef)?.invocationId, waiting!.invocationId);
      assert.equal(replyOf((await outputs(id))[1]!.externalRef)?.sessionId, binding.sessionId);
      assert.ok(events.some(event => event.type === 'dispatch.completed' && event.payload.invocationId === waiting!.invocationId));
      assert.ok((await outputs(id))[2]!.body.includes('Continue with different constraints.'));
      assert.ok((await outputs(id))[3]!.body.includes('Use staging.'));
      const completed = await host.interaction.snapshot();
      if (completed.type !== 'session.snapshot.result') throw Error('snapshot');
      assert.equal(completed.snapshot.session.pendingInterrupt, null);
    } finally { await host.close(); await studio.shutdown(); await rm(root, { recursive: true, force: true }); }
  });
}
