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
import { createChannelPlugin, type ChannelMessage } from '@pinpawo-plugin/channel';
import { createStudio } from '@pinpawo/studio';
import { buildHostRuntimeConfig, createResidentPetHost, FileSaver } from 'pinpawo/host-runtime';
import { createTestModelProfiles } from '../../../services/host/src/testing/modelProfiles';
import { HostToolkitInventoryStore } from '../../../services/host/src/toolkits/toolkitInventory';
import type { AgentChannelSetup } from '../../../services/host/src/agent/agentChannel';
import type { InterruptResume } from '../../../services/host/src/agent/agentGraphService';

async function waitFor(done: () => boolean) {
  for (let i = 0; i < 1000; i++) { if (done()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  throw new Error('Timed out waiting for review/dispatch completion.');
}

for (const decision of ['reject', 'cancel'] as const) {
  test(`Channel review ${decision} releases queued execute and replyTo on the same binding`, async () => {
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
    const host = await createResidentPetHost({ petId: 'one', petName: 'One', runtimeConfig,
      modelProfiles: createTestModelProfiles(), globalReviewPolicyMode: 'require_authorization', autoAuthorizationSafetyLevel: 'strict',
      capabilities: [], toolkitInventory: new HostToolkitInventoryStore(), checkpointer, sessionStatePath: runtimeConfig.tuiSessionPath,
      capabilityArtifactStore: { writeArtifact: async () => { throw Error('unused'); }, readArtifact: async () => { throw Error('unused'); },
        listArtifacts: async () => [], deleteThreadArtifacts: async () => {}, getDownloadUri: async uri => uri },
      graphService: graphService as never,
    });
    const channel = createChannelPlugin({ databasePath: join(root, 'channel.sqlite'), httpRoute: false });
    const studio = await createStudio({ studioId: 'review-stop', entryPetId: 'one', plugins: [channel],
      pets: [{ registration: { petId: 'one', name: 'One' }, dispatch: host.resident.dispatch }],
    });
    const outputs = (id: string) => channel.service.readHistory(id).entries
      .filter((entry): entry is ChannelMessage => entry.kind === 'message' && !!entry.source && !entry.toolCalls);
    try {
      const id = channel.service.createChannel({ title: 'Goal', goal: 'Inspect.', scope: 'Round' }, { kind: 'human', id: 'owner' }).channelId;
      await channel.execute(id, { petId: 'one', body: 'Which destination?' });
      await waitFor(() => outputs(id).length === 1);
      const question = outputs(id)[0]!;
      const { binding } = await channel.execute(id, { petId: 'one', body: 'Inspect and report.' });
      await waitFor(() => channel.service.readInterruptNotifications(id).notifications.length === 1);
      await channel.execute(id, { petId: 'one', body: 'Continue with different constraints.' });
      await channel.execute(id, { replyTo: question.messageId, body: 'Use staging.' });
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
      await waitFor(() => outputs(id).length === 4 && host.resident.dispatch.getQueueSnapshot().queuedDispatches === 0);
      assert.deepEqual([entryCalls, supervisorCalls, toolRuns, finalizes], [4, 3, 0, 0]);
      assert.equal(channel.service.getBinding(id, 'one')?.sessionId, binding.sessionId);
      // The declined dispatch reports its own ending to the Channel before queued work runs.
      const notice = channel.service.readInterruptNotifications(id).notifications[0]!;
      assert.equal(outputs(id)[1]!.source?.invocationId, notice.source.invocationId);
      assert.equal(channel.service.readExecutions(id).executions
        .find(execution => execution.invocationId === notice.source.invocationId)?.state, 'completed');
      assert.ok(outputs(id)[2]!.body.includes('Continue with different constraints.'));
      assert.ok(outputs(id)[3]!.body.includes('Use staging.'));
      assert.equal(channel.service.readInterruptNotifications(id).notifications.length, 1);
      const completed = await host.interaction.snapshot();
      if (completed.type !== 'session.snapshot.result') throw Error('snapshot');
      assert.equal(completed.snapshot.session.pendingInterrupt, null);
    } finally { await host.close(); await studio.shutdown(); await rm(root, { recursive: true, force: true }); }
  });
}
