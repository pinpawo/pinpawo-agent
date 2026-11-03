import assert from 'node:assert/strict';
import test from 'node:test';
import { createToolDeliverables } from '@pinpawo/agent-contracts';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { tool } from '@langchain/core/tools';
import { Command, END, MemorySaver, MessagesAnnotation, START, StateGraph } from '@langchain/langgraph';
import { z } from 'zod';
import { createSubagent } from './createSubagent';
import { createToolkitReviewMiddleware } from '../agent/orchestrator/toolkitReviewMiddleware';
import { buildReviewSpec } from '../types/reviewSpec';

const declaration = createToolDeliverables([
  { uri: 'artifact://workspace/report', title: 'Inspection report' },
]);

class PublishingModel extends BaseChatModel {
  constructor(private readonly callId: string) { super({}); }
  _llmType() { return 'publishing-review-fixture'; }
  bindTools() { return this; }
  async _generate(messages: BaseMessage[]) {
    const message = messages.some(value => ToolMessage.isInstance(value)
      && value.tool_call_id === this.callId)
      ? new AIMessage('Report ready.')
      : new AIMessage({ content: '', tool_calls: [
        { id: this.callId, name: 'publish_report', args: {} },
      ] });
    return { generations: [{ message, text: message.text }] };
  }
}

async function publishedReportMessages() {
  const publish = tool(async () => ['Report published.', declaration], {
    name: 'publish_report',
    description: 'Publish the inspection report.',
    schema: z.object({}),
    responseFormat: 'content_and_artifact',
  });
  const result = await createSubagent({
    model: new PublishingModel('publish-report'),
    tools: [publish],
    messages: [new HumanMessage('Publish the report.')],
    promptSections: [],
  });
  const message = result.messages.find((value): value is ToolMessage =>
    ToolMessage.isInstance(value) && value.tool_call_id === 'publish-report');
  assert.ok(message);
  assert.deepEqual(message.artifact, declaration);
  return { messages: result.messages, publication: message };
}

test('context summarization preserves a recent tool deliverable declaration with its message', async () => {
  const { messages, publication } = await publishedReportMessages();
  const result = await createSubagent({
    model: new FakeListChatModel({ responses: ['Earlier investigation summarized.', 'Current result.'], sleep: 0 }),
    tools: [],
    promptSections: [],
    contextWindowTokens: 1000,
    messages: [
      new HumanMessage(`Earlier investigation.\n${'x'.repeat(1600)}`),
      new AIMessage(`Earlier evidence.\n${'y'.repeat(1600)}`),
      ...messages,
      new HumanMessage('Use the recent report.'),
    ],
  });

  assert.ok(result.messages.some(message => message.additional_kwargs?.lc_source === 'summarization'));
  const retained = result.messages.find(message => message.id === publication.id);
  assert.ok(retained && ToolMessage.isInstance(retained));
  assert.deepEqual(retained.artifact, declaration);
});

test('context summarization can remove an older tool deliverable declaration from returned messages', async () => {
  const { messages, publication } = await publishedReportMessages();
  const result = await createSubagent({
    model: new FakeListChatModel({ responses: ['Earlier investigation summarized.', 'Current result.'], sleep: 0 }),
    tools: [],
    promptSections: [],
    contextWindowTokens: 1000,
    messages: [
      ...messages,
      new HumanMessage(`Later investigation.\n${'x'.repeat(800)}`),
      new AIMessage(`Later evidence.\n${'y'.repeat(800)}`),
      new HumanMessage(`Another investigation.\n${'z'.repeat(800)}`),
      new AIMessage(`Another finding.\n${'w'.repeat(800)}`),
      new HumanMessage('Finish the investigation.'),
    ],
  });

  assert.ok(result.messages.some(message => message.additional_kwargs?.lc_source === 'summarization'));
  assert.equal(result.messages.some(message => message.id === publication.id), false);
  assert.equal(result.messages.some(message => ToolMessage.isInstance(message)
    && message.tool_call_id === publication.tool_call_id), false);
  // A new invocation does not rebuild collector state from historical messages.
  assert.deepEqual(result.deliverables, []);
});

test('approval resume executes the publishing tool once and checkpoints its deliverable declaration', async () => {
  let publications = 0;
  const publish = tool(async () => {
    publications++;
    return ['Report published.', declaration];
  }, {
    name: 'publish_report',
    description: 'Publish the inspection report.',
    schema: z.object({}),
    responseFormat: 'content_and_artifact',
  });
  const model = new PublishingModel('publish-reviewed-report');
  const graph = new StateGraph(MessagesAnnotation).addNode('delegate', async (state, config) => {
    const review = createToolkitReviewMiddleware([{
      toolkit: { name: 'publishing', description: 'Report publishing.', tools: [{ tool: publish }] },
      toolName: 'publish_report',
      reviewPolicy: { request: () => buildReviewSpec({
        view: { kind: 'plain', body: 'Publish this report?' },
        options: [{ id: 'approve', label: 'Approve', decision: { type: 'approve' } }],
      }) },
    }], {
      models: { act: model },
      messages: state.messages,
      reviewCapabilities: { humanReview: true, sessionAuthorization: false },
      globalReviewPolicy: { mode: 'require_authorization' },
    });
    assert.ok(review);
    const result = await createSubagent({
      model, tools: [publish], middleware: [review], promptSections: [],
      messages: state.messages, runnableConfig: config,
    });
    return { messages: result.messages };
  }).addEdge(START, 'delegate').addEdge('delegate', END).compile({ checkpointer: new MemorySaver() });
  const config = { configurable: { thread_id: 'deliverable-review-resume' } };

  await graph.invoke({ messages: [new HumanMessage('Publish the report.')] }, config);
  const paused = await graph.getState(config);
  assert.ok(paused.tasks.some(task => task.interrupts?.length));
  assert.equal(publications, 0);

  const output = await graph.invoke(new Command({ resume: { decisions: [{
    reviewId: 'tool-review:publish_report:publish-reviewed-report', selectedOptionId: 'approve',
  }] } }), config);
  assert.equal(publications, 1);
  assert.equal(output.messages.at(-1)?.text, 'Report ready.');
  const checkpoint = await graph.getState(config);
  assert.deepEqual(checkpoint.next, []);
  const results = checkpoint.values.messages.filter((message: BaseMessage): message is ToolMessage =>
    ToolMessage.isInstance(message) && message.tool_call_id === 'publish-reviewed-report');
  assert.equal(results.length, 1);
  assert.deepEqual(results[0].artifact, declaration);
});
