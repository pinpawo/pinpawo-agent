import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { Command } from '@langchain/langgraph';
import { uuid6 } from '@langchain/langgraph-checkpoint';
import { z } from 'zod';
import {
  buildAgentRunnableConfig,
  buildOrchestratorRunInput,
  buildReviewSpec,
  compileAgentRegistry,
  createOrchestratorGraph,
  defineInstructionDocument,
  readCapabilityExecutions,
  readPendingInterrupt,
  type AgentModels,
} from '../../../packages/pet-agent/src/index';
import { setAgentMessageMetadata } from '../../../packages/pet-agent/src/agent/messages';
import { withScriptedDelegation } from '../../../packages/pet-agent/src/agent/orchestrator/runSupervisor/testing';
import { FileSaver } from './fileSaver';
import { HOST_CHECKPOINT_CONTRACT } from './config/runtimeConfig';

class AnswerModel extends BaseChatModel {
  calls = 0;
  _llmType() { return 'artifact-retirement-answer-fixture'; }
  bindTools() { return this; }
  async _generate() {
    this.calls += 1;
    const message = new AIMessage(`Answer ${this.calls.toString()}.`);
    return { generations: [{ message, text: message.text }] };
  }
}

function temporaryCheckpoint(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'pinpawo-artifact-retirement-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(HOST_CHECKPOINT_CONTRACT, 'capability-v5');
  return join(root, `checkpoints-${HOST_CHECKPOINT_CONTRACT}.json`);
}

function legacyArtifact(threadId: string): Record<string, unknown> {
  return {
    id: 'historical-ref', threadId, capabilityId: 'general', delegationId: 'legacy-nonempty',
    runId: 'legacy-run', kind: 'report', mimeType: 'text/plain',
    uri: `capability-artifact://thread/${threadId}/delegation/legacy-nonempty/artifact/historical-ref`,
    title: 'Historical report', sizeBytes: 4, createdAt: '2026-01-01T00:00:00Z',
    metadata: { retained: true },
  };
}

/** Persist the old executed-record shape, independently of the new record writer. */
function legacyExecutionPair(suffix: string, artifacts: Record<string, unknown>[]): BaseMessage[] {
  const callId = `legacy-call-${suffix}`;
  const delegationId = `legacy-${suffix}`;
  const metadata = { runId: 'legacy-run', taskId: 'legacy-task' };
  const execution = { planItemId: `legacy-plan-${suffix}`, delegationId, capability: 'general',
    task: `Historical ${suffix} task`, briefing: 'Historical execution.' };
  const result = { status: 'returned', delivery: { id: `legacy-delivery-${suffix}`, task: execution.task,
    text: `Historical ${suffix} result.`, scope: { ...metadata, lane: 'capability:general', delegationId } }, artifacts };
  return [
    setAgentMessageMetadata(new AIMessage({ id: `legacy-request-${suffix}`, content: '', tool_calls: [
      { id: callId, name: 'delegate_capability', args: { briefing: execution.briefing }, type: 'tool_call' },
    ] }), metadata),
    setAgentMessageMetadata(new ToolMessage({ id: `legacy-result-${suffix}`, name: 'delegate_capability',
      tool_call_id: callId, status: 'success', content: JSON.stringify(result),
      artifact: { kind: 'executed', execution, result } }), metadata),
  ];
}

function configuration(threadId: string, registry = compileAgentRegistry({ capabilities: [], toolkits: [] })) {
  return buildAgentRunnableConfig({ threadId, messages: [], globalReviewPolicy: { mode: 'require_authorization' } }, {
    registry, reviewCapabilities: { humanReview: true, sessionAuthorization: false },
  });
}

async function seedOldRecords(path: string, threadId: string) {
  const model = new AnswerModel({});
  const saver = new FileSaver(path);
  const graph = createOrchestratorGraph({ models: { act: model }, checkpoint: saver });
  const config = configuration(threadId);
  await graph.invoke(buildOrchestratorRunInput([new HumanMessage('An earlier conversation.')]), config);
  const artifact = legacyArtifact(threadId);
  await graph.updateState(config, { messages: [
    ...legacyExecutionPair('empty', []), ...legacyExecutionPair('nonempty', [artifact]),
  ] });
  // Persist an old checkpoint-only channel without reintroducing it into the current graph schema.
  const tuple = await saver.getTuple(config);
  assert.ok(tuple?.metadata);
  const step = tuple.metadata.step + 1;
  await saver.put(tuple.config, {
    ...tuple.checkpoint, id: uuid6(step), ts: new Date().toISOString(),
    channel_values: { ...tuple.checkpoint.channel_values, sessionCapabilityArtifacts: [artifact] },
    channel_versions: { ...tuple.checkpoint.channel_versions, sessionCapabilityArtifacts: 1 },
  }, { ...tuple.metadata, source: 'update', step });
  assert.deepEqual((await saver.getTuple(config))?.checkpoint.channel_values.sessionCapabilityArtifacts, [artifact]);
  await saver.collectThreadGarbage(threadId);
  return artifact;
}

function assertOldRecords(values: { messages: BaseMessage[] }, artifact: Record<string, unknown>) {
  assert.equal(Object.hasOwn(values, 'sessionCapabilityArtifacts'), false, 'the retired index is not restored into graph state');
  const old = readCapabilityExecutions(values.messages).filter(item => item.metadata.runId === 'legacy-run');
  assert.equal(old.length, 2);
  assert.deepEqual(old.map(item => item.result.artifacts), [[], [artifact]]);
}

test('the real v5 orchestrator reads old executions and resumes a checkpoint containing the retired index', async (t) => {
  const path = temporaryCheckpoint(t);
  const threadId = 'artifact-retirement-session';
  const artifact = await seedOldRecords(path, threadId);
  const config = configuration(threadId);
  const model = new AnswerModel({});
  const saver = new FileSaver(path);
  const graph = createOrchestratorGraph({ models: { act: model }, checkpoint: saver });
  assertOldRecords((await graph.getState(config)).values, artifact);
  const result = await graph.invoke(buildOrchestratorRunInput([new HumanMessage('Continue normally.')]), config);
  assert.equal(model.calls, 1);
  assertOldRecords(result, artifact);
  await saver.collectThreadGarbage(threadId);

  const restoredSaver = new FileSaver(path);
  const restoredGraph = createOrchestratorGraph({ models: { act: model }, checkpoint: restoredSaver });
  const restored = await restoredGraph.getState(config);
  assertOldRecords(restored.values, artifact);
  assert.deepEqual(restored.next, []);
  const persisted = await restoredSaver.getTuple(config);
  assert.ok(persisted);
  assert.equal(Object.hasOwn(persisted.checkpoint.channel_values, 'sessionCapabilityArtifacts'), false);
});

test('a real Capability approval resumes after rebuild without replaying completed tools or losing historical execution records', async (t) => {
  const path = temporaryCheckpoint(t);
  const threadId = 'artifact-retirement-approval';
  const artifact = await seedOldRecords(path, threadId);
  let entryCalls = 0;
  let supervisorCalls = 0;
  let modelCalls = 0;
  let completedReads = 0;
  let approvedWrites = 0;
  const readOnce = tool(async () => { completedReads += 1; return 'Read completed.'; }, {
    name: 'read_once', description: 'Read a local fixture.', schema: z.object({}),
  });
  const writeAfterApproval = tool(async () => { approvedWrites += 1; return 'Write completed.'; }, {
    name: 'write_after_approval', description: 'Write only after approval.', schema: z.object({}),
  });
  const registry = compileAgentRegistry({
    capabilities: [{ name: 'general', description: 'Fixture work', uses: ['fixture'],
      instructions: defineInstructionDocument({ content: 'Read, then perform the reviewed action.' }) }],
    toolkits: [{ name: 'fixture', description: 'Local fixture tools', tools: [
      { tool: readOnce },
      { tool: writeAfterApproval, review: { request: () => buildReviewSpec({
        view: { kind: 'plain', body: 'Approve the fixture write?' }, options: [
          { id: 'approve', label: 'Approve', decision: { type: 'approve' } },
          { id: 'reject', label: 'Reject', decision: { type: 'reject', message: 'Do not write.' } },
        ],
      }) } },
    ] }],
  });
  class CapabilityModel extends BaseChatModel {
    _llmType() { return 'artifact-retirement-review-fixture'; }
    bindTools() { return this; }
    async _generate() {
      modelCalls += 1;
      const name = modelCalls === 1 ? 'read_once' : modelCalls === 2 ? 'write_after_approval' : null;
      const message = name ? new AIMessage({ content: '', tool_calls: [
        { id: `action-${modelCalls.toString()}`, name, args: {}, type: 'tool_call' },
      ] }) : new AIMessage('Fixture work completed.');
      return { generations: [{ message, text: message.text }] };
    }
  }
  const capabilityModel = new CapabilityModel({});
  const entry = { bindTools: () => ({ invoke: async () => {
    entryCalls += 1;
    return new AIMessage({ content: '', tool_calls: [
      { id: 'entry-plan', name: 'plan_request', args: { goal: 'Complete fixture work.' } },
    ] });
  } }) } as unknown as AgentModels['act'];
  const config = configuration(threadId, registry);
  const makeGraph = (saver: FileSaver) => createOrchestratorGraph({
    models: { act: entry, subagent: capabilityModel }, checkpoint: saver,
    runSupervisorRunner: withScriptedDelegation({ invoke: async () => {
      supervisorCalls += 1;
      return supervisorCalls === 1
        ? { name: 'submit_plan', args: { tasks: [{ capability: 'general', objective: 'Complete fixture work.' }] } }
        : { name: 'review_current', args: { completed: true, reason: 'The fixture tools completed.', reply: 'Accepted.' } };
    } }),
  });
  const initialSaver = new FileSaver(path);
  const initialGraph = makeGraph(initialSaver);
  await initialGraph.invoke(buildOrchestratorRunInput([new HumanMessage('Complete fixture work.')]), config);
  const paused = await initialGraph.getState(config);
  const pending = readPendingInterrupt(paused);
  assert.ok(pending);
  assertOldRecords(paused.values, artifact);
  assert.equal(completedReads, 1);
  assert.equal(approvedWrites, 0);
  assert.equal(modelCalls, 2);
  assert.equal(entryCalls, 1);
  assert.equal(supervisorCalls, 1);
  await initialSaver.collectThreadGarbage(threadId);

  const resumedSaver = new FileSaver(path);
  const resumedGraph = makeGraph(resumedSaver);
  const restoredPause = await resumedGraph.getState(config);
  assert.equal(readPendingInterrupt(restoredPause)?.interruptId, pending.interruptId);
  assertOldRecords(restoredPause.values, artifact);
  const reviewId = pending.payload.reviews[0]?.id;
  assert.ok(reviewId);
  const finished = await resumedGraph.invoke(new Command({ resume: { [pending.interruptId]: {
    decisions: [{ reviewId, selectedOptionId: 'approve' }],
  } } }), config);
  assert.equal(completedReads, 1, 'the completed pre-review tool must not replay');
  assert.equal(approvedWrites, 1);
  assert.equal(modelCalls, 3, 'resume must continue after the persisted tool-call response');
  assert.equal(entryCalls, 1);
  assert.equal(supervisorCalls, 2);
  assertOldRecords(finished, artifact);
  const current = readCapabilityExecutions(finished.messages).filter(item => item.metadata.runId !== 'legacy-run');
  assert.equal(current.length, 1);
  assert.equal(Object.hasOwn(current[0]!.result, 'artifacts'), false, 'new records do not write the retired field');
  await resumedSaver.collectThreadGarbage(threadId);

  const finalSaver = new FileSaver(path);
  const final = await makeGraph(finalSaver).getState(config);
  assertOldRecords(final.values, artifact);
  assert.equal(readPendingInterrupt(final), null);
  assert.deepEqual(final.next, []);
  const persisted = await finalSaver.getTuple(config);
  assert.ok(persisted);
  assert.equal(Object.hasOwn(persisted.checkpoint.channel_values, 'sessionCapabilityArtifacts'), false);
});
