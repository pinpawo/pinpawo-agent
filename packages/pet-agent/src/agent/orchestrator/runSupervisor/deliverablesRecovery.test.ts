import assert from 'node:assert/strict';
import test from 'node:test';
import { createToolDeliverables, type Deliverable } from '@pinpawo/agent-contracts';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { tool } from '@langchain/core/tools';
import { Command, MemorySaver } from '@langchain/langgraph';
import { z } from 'zod';
import { createOrchestratorGraph } from '../runtime/graph';
import { buildOrchestratorRunInput } from '../state';
import { compileAgentRegistry } from '../registry';
import { readCapabilityExecutions } from '../executionMessages';
import { defineInstructionDocument } from '../../../types/capability';
import { buildReviewSpec } from '../../../types/reviewSpec';

function call(name: string, args: Record<string, unknown>, id: string) {
  return new AIMessage({ content: '', tool_calls: [{ id, name, args }] });
}

class SequenceModel extends BaseChatModel {
  private index = 0;
  constructor(private readonly replies: AIMessage[]) { super({}); }
  _llmType() { return 'deliverable-recovery-sequence'; }
  bindTools() { return this; }
  async _generate() {
    const message = this.replies[this.index++];
    assert.ok(message, 'unexpected model invocation');
    return { generations: [{ message, text: message.text }] };
  }
}

class PublishingModel extends BaseChatModel {
  _llmType() { return 'deliverable-recovery-publisher'; }
  bindTools() { return this; }
  async _generate(messages: BaseMessage[]) {
    const results = messages.filter(ToolMessage.isInstance);
    const message = !results.some(result => result.tool_call_id === 'publish-first')
      ? call('publish_first', {}, 'publish-first')
      : !results.some(result => result.tool_call_id === 'publish-reviewed')
        ? call('publish_reviewed', {}, 'publish-reviewed')
        : new AIMessage('Both reports are ready.');
    return { generations: [{ message, text: message.text }] };
  }
}

const first: Deliverable = { uri: 'artifact://workspace/first', title: 'First report' };
const reviewed: Deliverable = { uri: 'artifact://workspace/reviewed', title: 'Reviewed report' };

function reviewedPublicationSetup() {
  const calls = { first: 0, reviewed: 0 };
  const publishFirst = tool(() => {
    calls.first++;
    return ['First report published.', createToolDeliverables([first])];
  }, { name: 'publish_first', description: 'Publish the first report.', schema: z.object({}), responseFormat: 'content_and_artifact' });
  const publishReviewed = tool(() => {
    calls.reviewed++;
    return ['Reviewed report published.', createToolDeliverables([reviewed])];
  }, { name: 'publish_reviewed', description: 'Publish the reviewed report.', schema: z.object({}), responseFormat: 'content_and_artifact' });
  const registry = compileAgentRegistry({
    toolkits: [{ name: 'reports', description: 'Publish reports.', tools: [
      { tool: publishFirst },
      { tool: publishReviewed, review: { request: () => buildReviewSpec({
        view: { kind: 'plain', body: 'Publish the second report?' },
        options: [
          { id: 'approve', label: 'Approve', decision: { type: 'approve' } },
          { id: 'reject', label: 'Reject', decision: { type: 'reject', message: 'Keep only the first report.' } },
        ],
      }) } },
    ] }],
    capabilities: [{ name: 'general', description: 'Prepare reports.', uses: ['reports'],
      instructions: defineInstructionDocument({ content: 'Publish both requested reports.' }) }],
  });
  const checkpoint = new MemorySaver();
  const config = {
    checkpoint,
    models: {
      answer: new SequenceModel([call('plan_request', { goal: 'Publish both reports.' }, 'entry')]),
      act: new SequenceModel([
        call('submit_plan', { tasks: [{ capability: 'general', objective: 'Publish both reports.' }] }, 'plan'),
        call('delegate_capability', { briefing: 'Publish the first report, then request publication of the reviewed report.' }, 'delegate'),
        call('review_current', { completed: true, reason: 'Both reports were published.' }, 'accept'),
        new AIMessage('Reports complete.'),
      ]),
      subagent: new PublishingModel({}),
    },
  };
  const options = { configurable: {
    thread_id: 'deliverable-recovery', registry,
    reviewCapabilities: { humanReview: true, sessionAuthorization: false },
    globalReviewPolicy: { mode: 'require_authorization' },
  } };
  return { calls, checkpoint, config, options };
}

for (const decision of ['approve', 'reject', 'cancel'] as const) {
  test(`declared references survive parent/child graph rebuild and ${decision}`, async () => {
    const { calls, checkpoint, config, options } = reviewedPublicationSetup();
    const graph = createOrchestratorGraph(config);
    await graph.invoke(buildOrchestratorRunInput([new HumanMessage('Publish both reports.')]), options);
    const paused = await graph.getState(options);
    assert.ok(paused.tasks.some(task => task.interrupts?.length));
    assert.deepEqual(calls, { first: 1, reviewed: 0 });
    let firstCheckpointed = false;
    for await (const saved of checkpoint.list({ configurable: { thread_id: options.configurable.thread_id } })) {
      if (!saved.config.configurable?.checkpoint_ns?.startsWith('capability:')) continue;
      const references = saved.checkpoint.channel_values.deliverables;
      firstCheckpointed ||= Array.isArray(references)
        && references.some(value => value && typeof value === 'object' && 'uri' in value && value.uri === first.uri);
    }
    assert.equal(firstCheckpointed, true, 'the child stores the reference before the later approval interrupt');

    const rebuilt = createOrchestratorGraph(config);
    const resume = decision === 'cancel' ? { action: 'cancel' } : { decisions: [{
      reviewId: 'tool-review:publish_reviewed:publish-reviewed', selectedOptionId: decision,
    }] };
    const output = await rebuilt.invoke(new Command({ resume }), options);
    const result = readCapabilityExecutions(output.messages).at(-1)?.result;
    assert.ok(result);
    assert.deepEqual(result.deliverables, decision === 'approve' ? [first, reviewed] : [first]);
    assert.deepEqual(calls, { first: 1, reviewed: decision === 'approve' ? 1 : 0 });
    assert.equal(result.reviewDecision, decision === 'approve' ? undefined : decision);
    assert.equal(result.status, decision === 'approve' ? 'returned' : 'missing_deliverable');
    const savedResult = readCapabilityExecutions((await rebuilt.getState(options)).values.messages).at(-1)?.result;
    assert.deepEqual(savedResult?.deliverables, result.deliverables);
    const replay = await rebuilt.invoke(null, options);
    assert.deepEqual(calls, { first: 1, reviewed: decision === 'approve' ? 1 : 0 }, 'completed execution is not replayed');
    const replayedExecutions = readCapabilityExecutions(replay.messages);
    assert.equal(replayedExecutions.length, 1);
    assert.deepEqual(replayedExecutions[0].result.deliverables, result.deliverables);
  });
}

test('separate delegations keep their accumulated references isolated', async () => {
  let publications = 0;
  const publish = tool(({ name }) => {
    publications++;
    return [`Published ${name}.`, createToolDeliverables([{ uri: `artifact://workspace/${name}` }])];
  }, { name: 'publish', description: 'Publish one report.', schema: z.object({ name: z.string() }), responseFormat: 'content_and_artifact' });
  const registry = compileAgentRegistry({
    toolkits: [{ name: 'reports', description: 'Publish reports.', tools: [{ tool: publish }] }],
    capabilities: [{ name: 'general', description: 'Prepare reports.', uses: ['reports'],
      instructions: defineInstructionDocument({ content: 'Publish the requested report.' }) }],
  });
  const config = {
    checkpoint: new MemorySaver(),
    models: {
      answer: new SequenceModel([call('plan_request', { goal: 'Publish A and B.' }, 'entry')]),
      act: new SequenceModel([
        call('submit_plan', { tasks: [
          { capability: 'general', objective: 'Publish A.' },
          { capability: 'general', objective: 'Publish B.' },
        ] }, 'plan'),
        call('delegate_capability', { briefing: 'Publish A.' }, 'delegate-A'),
        call('review_current', { completed: true, reason: 'A is ready.' }, 'accept-A'),
        call('delegate_capability', { briefing: 'Publish B.' }, 'delegate-B'),
        call('review_current', { completed: true, reason: 'B is ready.' }, 'accept-B'),
        new AIMessage('Both reports are ready.'),
      ]),
      subagent: new SequenceModel([
        call('publish', { name: 'A' }, 'publish-A'), new AIMessage('A ready.'),
        call('publish', { name: 'B' }, 'publish-B'), new AIMessage('B ready.'),
      ]),
    },
  };
  const options = { configurable: { thread_id: 'deliverable-isolation', registry } };
  const output = await createOrchestratorGraph(config)
    .invoke(buildOrchestratorRunInput([new HumanMessage('Publish A and B.')]), options);
  const executions = readCapabilityExecutions(output.messages);
  assert.equal(executions.length, 2);
  assert.notEqual(executions[0].execution.delegationId, executions[1].execution.delegationId);
  assert.deepEqual(executions.map(({ result }) => result.deliverables), [
    [{ uri: 'artifact://workspace/A' }], [{ uri: 'artifact://workspace/B' }],
  ]);
  assert.equal(publications, 2);
});
