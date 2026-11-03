import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { tool } from '@langchain/core/tools';
import { MemorySaver, messagesStateReducer } from '@langchain/langgraph';
import { createToolDeliverables, type Deliverable } from '@pinpawo/agent-contracts';
import { z } from 'zod';
import { getAgentMessageMetadata, setAgentMessageMetadata } from '../messages';
import { defineInstructionDocument } from '../../types/capability';
import { compactOrchestratorMessages } from './contextCompaction';
import { readCapabilityExecutions } from './executionMessages';
import { readAcceptedRunDeliverables } from './executionReviews';
import { compileAgentRegistry } from './registry';
import { createOrchestratorGraph } from './runtime/graph';
import { buildOrchestratorRunInput, type OrchestratorStateType } from './state';

class ScriptedModel extends BaseChatModel {
  private index = 0;
  constructor(private readonly responses: AIMessage[]) { super({}); }
  _llmType() { return 'accepted-deliverables-test'; }
  bindTools() { return this; }
  async _generate() {
    const message = this.responses[this.index++];
    if (!message) throw new Error('Unexpected extra model turn.');
    return { generations: [{ message, text: message.text }] };
  }
}

function call(name: string, args: Record<string, unknown>, id: string) {
  return new AIMessage({ content: '', tool_calls: [{ name, args, id, type: 'tool_call' }] });
}

function reference(key: string): Deliverable {
  return { uri: `https://deliverables.example.test/${key}`, title: `Deliverable ${key}` };
}

const task = (objective: string) => ({ capability: 'general', objective });

function scenario(supervisorResponses: AIMessage[], executorResponses: AIMessage[]) {
  const published: string[] = [];
  const emit = tool(async ({ key }: { key: string }) => {
    published.push(key);
    return ['Reference declared.', createToolDeliverables([reference(key)])];
  }, {
    name: 'emit_reference', description: 'Declare the requested result reference.',
    schema: z.object({ key: z.string() }), responseFormat: 'content_and_artifact',
  });
  const registry = compileAgentRegistry({
    toolkits: [{ name: 'reports', description: 'Ordinary report tools.', tools: [{ tool: emit }] }],
    capabilities: [{
      name: 'general', description: 'Produce the requested references.', uses: ['reports'],
      instructions: defineInstructionDocument({ content: 'Produce the requested result and return its report.' }),
      lifecycle: { finalize: result => ({ output: `Finalized: ${result.output}` }) },
    }],
  });
  const checkpoint = new MemorySaver();
  const config = {
    checkpoint,
    models: {
      act: new ScriptedModel(supervisorResponses),
      answer: new ScriptedModel([call('plan_request', { goal: 'Produce the requested deliverables.' }, 'entry')]),
      subagent: new ScriptedModel(executorResponses),
    },
  };
  return { checkpoint, config, registry, published, graph: createOrchestratorGraph(config) };
}

function execute(key: string) {
  return [call('emit_reference', { key }, `emit:${key}`), new AIMessage(`Report ${key}.`)];
}

test('accepted tool references survive forced Root compaction and a rebuilt graph before the next acceptance', async () => {
  const fixture = scenario([
    call('submit_plan', { tasks: [task('Produce A.'), task('Produce B.')] }, 'plan'),
    call('delegate_capability', { briefing: 'Produce the first requested deliverable.' }, 'delegate-a'),
    call('review_current', { completed: true, reason: 'The first report is accepted.' }, 'accept-a'),
    call('delegate_capability', { briefing: 'Produce the second requested deliverable.' }, 'delegate-b'),
    call('review_current', { completed: true, reason: 'The second report is accepted.' }, 'accept-b'),
    new AIMessage('Completed both requested reports.'),
  ], [...execute('A'), ...execute('B')]);
  const options = { configurable: { thread_id: 'accepted-across-compaction', registry: fixture.registry } };
  await fixture.graph.invoke(buildOrchestratorRunInput([
    new HumanMessage('Produce two separate deliverables, A and B.'),
  ]), { ...options, interruptAfter: ['capability'] });
  await fixture.graph.invoke(null, { ...options, interruptAfter: ['capability'] });
  const boundary = (await fixture.graph.getState(options)).values as OrchestratorStateType;
  assert.equal(boundary.runSupervisorState.plan[0].status, 'completed');
  assert.equal(boundary.runSupervisorState.plan[1].status, 'pending');
  assert.deepEqual(fixture.published, ['A', 'B']);
  const firstExecution = readCapabilityExecutions(boundary.messages)[0];
  assert.equal(firstExecution.result.delivery?.text, 'Finalized: Report A.');
  assert.deepEqual(firstExecution.result.deliverables, [reference('A')]);
  assert.deepEqual(readAcceptedRunDeliverables(boundary.messages, boundary.runId), [reference('A')]);

  // Force the existing Root compactor at a native saved boundary. This does not
  // claim that every production delegation boundary triggers its watermark.
  const compacted = await compactOrchestratorMessages({
    messages: boundary.messages,
    model: new ScriptedModel([new AIMessage('Earlier evidence was summarized without retaining links.')]),
    options: { keepMessages: 1, taskId: boundary.taskId,
      preservePlanItemIds: [boundary.runSupervisorState.plan[1].id] },
  });
  assert.equal(compacted.compacted, true);
  const compactedMessages = messagesStateReducer(boundary.messages, compacted.messages);
  assert.equal(readCapabilityExecutions(compactedMessages).length, 1,
    'only B, whose delivery still needs acceptance, retains its main execution record');
  assert.equal(readCapabilityExecutions(compactedMessages)[0].result.delivery?.text, 'Finalized: Report B.');
  assert.deepEqual(readAcceptedRunDeliverables(compactedMessages, boundary.runId), [reference('A')],
    'the real private acceptance receipt is self-contained');
  const saved = await fixture.checkpoint.getTuple(options);
  assert.ok(saved);
  await fixture.checkpoint.put({
    ...saved.config,
    configurable: { ...saved.config.configurable,
      checkpoint_id: saved.parentConfig?.configurable?.checkpoint_id },
  }, {
    ...saved.checkpoint,
    channel_values: { ...saved.checkpoint.channel_values, messages: compactedMessages },
  }, saved.metadata!);

  const rebuilt = createOrchestratorGraph(fixture.config);
  const completed = await rebuilt.invoke(null, options);
  assert.deepEqual(fixture.published, ['A', 'B'], JSON.stringify({
    next: (await rebuilt.getState(options)).next,
    messages: completed.messages.map(message => ({ type: message.getType(), text: message.text,
      toolCallId: ToolMessage.isInstance(message) ? message.tool_call_id : undefined })),
  }));
  assert.equal(completed.messages.at(-1)?.text, 'Completed both requested reports.');
  assert.deepEqual(getAgentMessageMetadata(completed.messages.at(-1)!).deliverables,
    [reference('A'), reference('B')]);
  assert.equal(readCapabilityExecutions(completed.messages).length, 1);
  assert.equal(readCapabilityExecutions(completed.messages)[0].result.delivery?.text, 'Finalized: Report B.');
  assert.deepEqual(readCapabilityExecutions(completed.messages)[0].result.deliverables, [reference('B')],
    'the second delegation does not inherit the first delegation collector state');
  const replayed = await rebuilt.invoke(null, options);
  assert.deepEqual(fixture.published, ['A', 'B']);
  assert.deepEqual(getAgentMessageMetadata(replayed.messages.at(-1)!).deliverables,
    [reference('A'), reference('B')]);
});

test('rejected execution references remain evidence while only the accepted rework is published', async () => {
  const fixture = scenario([
    call('submit_plan', { tasks: [task('Produce the report.')] }, 'plan'),
    call('delegate_capability', { briefing: 'Produce the requested report.' }, 'first'),
    call('review_current', { completed: false, reason: 'The first report requires correction.' }, 'reject'),
    call('delegate_capability', { briefing: 'Correct the report and return the replacement.' }, 'redo'),
    call('review_current', { completed: true, reason: 'The replacement is accepted.' }, 'accept'),
    new AIMessage('The corrected report is ready.'),
  ], [...execute('rejected'), ...execute('accepted')]);
  const output = await fixture.graph.invoke(buildOrchestratorRunInput([
    new HumanMessage('Produce a verified report.'),
  ]), { configurable: { thread_id: 'rejected-then-accepted', registry: fixture.registry } });
  assert.deepEqual(fixture.published, ['rejected', 'accepted']);
  assert.deepEqual(readCapabilityExecutions(output.messages).map(({ result }) => result.deliverables),
    [[reference('rejected')], [reference('accepted')]]);
  assert.deepEqual(getAgentMessageMetadata(output.messages.at(-1)!).deliverables, [reference('accepted')]);
  assert.equal(output.messages.at(-1)?.text, 'The corrected report is ready.');
});

test('acceptance requires its ordered successful same-run tool pair and does not carry into a fresh direct reply', async () => {
  const fixture = scenario([
    call('submit_plan', { tasks: [task('Produce the report.')] }, 'plan'),
    call('delegate_capability', { briefing: 'Produce the requested report.' }, 'execute'),
    call('review_current', { completed: true, reason: 'The report is accepted.' }, 'accept'),
    new AIMessage('The report is ready.'),
  ], execute('accepted'));
  const options = { configurable: { thread_id: 'acceptance-run-boundary', registry: fixture.registry } };
  const first = await fixture.graph.invoke(buildOrchestratorRunInput([new HumanMessage('Produce a report.')]), options);
  const receipt = first.messages.find((message): message is ToolMessage => ToolMessage.isInstance(message)
    && message.name === 'review_current' && message.status !== 'error')!;
  assert.ok(receipt);
  const request = first.messages.find((message): message is AIMessage => AIMessage.isInstance(message)
    && Boolean(message.tool_calls?.some(call => call.id === receipt.tool_call_id)))!;
  assert.ok(request);
  assert.deepEqual(readAcceptedRunDeliverables([request, receipt], first.runId), [reference('accepted')]);
  assert.deepEqual(readAcceptedRunDeliverables([receipt], first.runId), []);
  assert.deepEqual(readAcceptedRunDeliverables([receipt, request], first.runId), []);
  const failed = new ToolMessage({ ...receipt, status: 'error' });
  assert.deepEqual(readAcceptedRunDeliverables([request, failed], first.runId), []);
  const foreign = setAgentMessageMetadata(new ToolMessage({ ...receipt }), { runId: 'another-run' });
  assert.deepEqual(readAcceptedRunDeliverables([request, foreign], first.runId), []);

  const next = createOrchestratorGraph({ ...fixture.config, models: {
    ...fixture.config.models, answer: new ScriptedModel([new AIMessage('Hello.')]),
  } });
  const second = await next.invoke(buildOrchestratorRunInput([new HumanMessage('Hello.')]), options);
  assert.notEqual(second.runId, first.runId);
  assert.equal(readCapabilityExecutions(second.messages).length, 1,
    'the earlier execution still exists as history but is not current acceptance');
  assert.deepEqual(getAgentMessageMetadata(second.messages.at(-1)!).deliverables, []);
  assert.deepEqual(fixture.published, ['accepted']);
});
