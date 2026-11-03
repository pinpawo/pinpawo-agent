import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage, ToolMessage, mapStoredMessagesToChatMessages } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { tool } from '@langchain/core/tools';
import { Command, MemorySaver } from '@langchain/langgraph';
import type { Checkpoint, CheckpointMetadata } from '@langchain/langgraph-checkpoint';
import { FakeToolCallingModel } from 'langchain';
import { z } from 'zod';
import { mainConversationMessages, setAgentMessageMetadata } from '../messages';
import { defineInstructionDocument } from '../../types/capability';
import type { AgentModels } from '../../types/agent';
import { buildReviewSpec } from '../../types/reviewSpec';
import type { AgentToolkit } from '../../types/toolkit';
import { readCapabilityExecutionRecord, readCapabilityExecutions } from './executionMessages';
import { compileAgentRegistry } from './registry';
import { createOrchestratorGraph } from './runtime/graph';
import { PLAN_REQUEST_TOOL_NAME } from './runtime/nodes/entryAnswer';
import { withScriptedDelegation } from './runSupervisor/testing';
import { buildOrchestratorRunInput, ORCHESTRATOR_STATE_CHANNEL_NAMES, type OrchestratorStateType } from './state';

const historicalRef = {
  id: 'old-report', threadId: 'cleanup-review', capabilityId: 'general',
  delegationId: 'old-delegation', runId: 'old-run', kind: 'report',
  mimeType: 'text/markdown', uri: 'capability-artifact://thread/cleanup-review/artifact/old-report',
  title: 'Earlier report', sizeBytes: 42, createdAt: '2026-06-16T00:00:00.000Z',
  schema: { name: 'ExploreReport', version: 1 }, metadata: { sourceCount: 2 },
};

/** Pre-cleanup execution wire shape, deliberately independent of the current writer. */
function historicalExecution() {
  const metadata = { runId: 'old-run', taskId: 'old-task' };
  const call = setAgentMessageMetadata(new AIMessage({
    id: 'old-request', content: '', tool_calls: [{
      id: 'old-call', name: 'delegate_capability', args: { briefing: 'Inspect the earlier issue.' },
    }],
  }), metadata);
  const result = {
    status: 'returned', artifacts: [historicalRef],
    delivery: {
      id: 'old-delivery', task: 'Inspect the earlier issue.', text: 'Earlier findings.',
      scope: { lane: 'capability:general', runId: 'old-run', taskId: 'old-task', delegationId: 'old-delegation' },
    },
  };
  const response = setAgentMessageMetadata(new ToolMessage({
    id: 'old-response', name: 'delegate_capability', tool_call_id: 'old-call', status: 'success',
    content: JSON.stringify(result), artifact: {
      kind: 'executed', execution: {
        planItemId: 'old-item', delegationId: 'old-delegation', capability: 'general',
        task: 'Inspect the earlier issue.', briefing: 'Inspect the earlier issue.',
      }, result,
    },
  }), metadata);
  return { call, response };
}

test('legacy execution artifacts remain readable in the main conversation', () => {
  const { call, response } = historicalExecution();
  const serialized = JSON.parse(JSON.stringify(response.toDict())) as ReturnType<ToolMessage['toDict']>;
  const restored = mapStoredMessagesToChatMessages([serialized])[0];
  assert.ok(ToolMessage.isInstance(restored));
  const record = readCapabilityExecutionRecord(restored);
  assert.equal(record?.kind, 'executed');
  assert.deepEqual(record?.kind === 'executed' ? record.result.artifacts : [], [historicalRef]);
  const history = mainConversationMessages([call, restored]);
  const executions = readCapabilityExecutions(history);
  assert.equal(executions.length, 1);
  assert.deepEqual(executions[0].result.artifacts, [historicalRef]);
  assert.equal(executions[0].result.delivery?.text, 'Earlier findings.');
});

/**
 * Add the removed channel to saved Root checkpoints, preserving the current
 * production graph and real child Review interrupt. This tests the old state
 * shape against the new graph, not an old runtime binary or cross-process I/O.
 */
class LegacyArtifactCheckpointFixture extends MemorySaver {
  override put(config: RunnableConfig, checkpoint: Checkpoint, metadata: CheckpointMetadata) {
    if ((config.configurable?.checkpoint_ns ?? '') !== '') return super.put(config, checkpoint, metadata);
    return super.put(config, {
      ...checkpoint,
      channel_values: { ...checkpoint.channel_values, sessionCapabilityArtifacts: [historicalRef] },
      channel_versions: {
        ...checkpoint.channel_versions,
        sessionCapabilityArtifacts: checkpoint.channel_versions.messages ?? 1,
      },
    }, metadata);
  }
}

test('rebuilt Root resumes a child Review with the removed artifact state channel', async () => {
  assert.equal(ORCHESTRATOR_STATE_CHANNEL_NAMES.includes('sessionCapabilityArtifacts'), false);
  let toolRuns = 0;
  const probe = tool(() => {
    toolRuns += 1;
    return 'Probe completed.';
  }, { name: 'probe', description: 'Run a mock probe.', schema: z.object({}) });
  const toolkit: AgentToolkit = {
    name: 'local', description: 'Mock local tools.', tools: [{
      tool: probe,
      review: { request: () => buildReviewSpec({
        view: { kind: 'plain', body: 'Approve the mock probe?' },
        options: [{ id: 'approve', label: 'Approve', decision: { type: 'approve' } }],
      }) },
    }],
  };
  const capability = {
    name: 'general', description: 'Perform the probe.', uses: ['local'],
    instructions: defineInstructionDocument({ content: 'Perform the requested probe.' }),
  };
  const subagent = new FakeToolCallingModel({ toolCalls: [
    [{ id: 'probe-call', name: 'probe', args: {} }], [],
  ] });
  const models = {
    act: new FakeToolCallingModel({ toolCalls: [[]] }),
    answer: { bindTools: () => ({ invoke: async () => new AIMessage({
      id: 'entry-route', content: '', tool_calls: [{
        id: 'plan-request', name: PLAN_REQUEST_TOOL_NAME, args: { goal: 'Perform the mock probe.' },
      }],
    }) }) } as unknown as AgentModels['act'],
    subagent,
  };
  const runner = withScriptedDelegation({ invoke: async input => input.state.plan.length === 0
    ? { name: 'submit_plan', args: { tasks: [{ capability: 'general', objective: 'Perform the mock probe.' }] } }
    : { name: 'review_current', args: { completed: true, reason: 'The probe returned its evidence.', reply: 'Completed.' } },
  });
  const checkpoint = new LegacyArtifactCheckpointFixture();
  const before = createOrchestratorGraph({ models, runSupervisorRunner: runner, checkpoint });
  const config = { configurable: {
    thread_id: 'cleanup-review', registry: compileAgentRegistry({ capabilities: [capability], toolkits: [toolkit] }),
  } };
  const { call, response } = historicalExecution();
  const interrupted = await before.invoke(buildOrchestratorRunInput([
    call, response, new HumanMessage({ id: 'new-request', content: 'Perform the mock probe.' }),
  ]), config) as OrchestratorStateType & { __interrupt__?: Array<{ id?: string }> };
  const interruptId = interrupted.__interrupt__?.[0]?.id;
  assert.ok(interruptId, JSON.stringify(interrupted.messages.map(message => ({
    type: message.getType(), content: message.content,
  }))));
  assert.equal(toolRuns, 0);
  const tuple = await checkpoint.getTuple(config);
  assert.deepEqual(tuple?.checkpoint.channel_values.sessionCapabilityArtifacts, [historicalRef]);
  assert.ok(Object.keys(checkpoint.storage['cleanup-review']).some(namespace => namespace !== ''),
    'the child has a real inherited checkpoint namespace');

  const reopened = new MemorySaver();
  reopened.storage = checkpoint.storage;
  reopened.writes = checkpoint.writes;
  const after = createOrchestratorGraph({ models, runSupervisorRunner: runner, checkpoint: reopened });
  subagent.index = 1;
  const resumed = await after.invoke(new Command({ resume: { [interruptId]: {
    decisions: [{ reviewId: 'tool-review:probe:probe-call', selectedOptionId: 'approve' }],
  } } }), config) as OrchestratorStateType & { __interrupt__?: unknown };
  assert.equal(resumed.__interrupt__, undefined);
  assert.equal(toolRuns, 1);
  assert.equal('sessionCapabilityArtifacts' in resumed, false);
  const executions = readCapabilityExecutions(resumed.messages);
  assert.deepEqual(executions.find(item => item.execution.delegationId === 'old-delegation')?.result.artifacts, [historicalRef]);
  assert.equal(executions.length, 2);
  assert.deepEqual(executions.at(-1)?.result.artifacts, []);
  assert.equal(resumed.messages.at(-1)?.text, 'Completed.');
});
