import assert from 'node:assert/strict';
import test from 'node:test';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { Command, END, MemorySaver, MessagesAnnotation, START, StateGraph } from '@langchain/langgraph';
import { createAgent, createMiddleware, FakeToolCallingModel } from 'langchain';
import { createToolDeliverables } from '@pinpawo/agent-contracts';
import { z } from 'zod';
import { createSubagent } from './createSubagent';
import { resolveToolkitExecution } from '../agent/orchestrator/subagentDispatch';
import { buildReviewSpec } from '../types/reviewSpec';
import { createToolDeliverablesCollector } from './toolDeliverables';

const ref = (key: string) => ({ uri: `https://results.example.test/${key}`, title: key });
const calls = (...names: string[]) => names.map((name, index) => ({ id: `${name}:${index}`, name, args: {} }));
const input = () => [new HumanMessage('Produce the requested result.')];

test('ordinary tools and parallel declarations share one result path and deduplicate in tool order', async () => {
  const emit = (name: string) => tool(() => ['A tool result.', createToolDeliverables([ref(name), ref('shared')])], {
    name, description: 'Declare a reference.', schema: z.object({}), responseFormat: 'content_and_artifact',
  });
  const ordinary = tool(() => 'An ordinary result.', { name: 'ordinary', description: 'Read data.', schema: z.object({}) });
  const result = await createSubagent({
    model: new FakeToolCallingModel({ toolCalls: [calls('first', 'second', 'ordinary'), []] }),
    tools: [emit('first'), emit('second'), ordinary], promptSections: [], messages: input(),
  });
  assert.deepEqual(result.deliverables, [ref('first'), ref('shared'), ref('second')]);
  assert.equal(result.messages.find(message => ToolMessage.isInstance(message) && message.name === 'ordinary')?.text,
    'An ordinary result.');
});

test('collector preserves native ordinary-tool error handling without a pre-existing wrapper', async () => {
  const failure = tool(() => { throw new Error('Expected tool failure.'); }, {
    name: 'failure', description: 'Fail.', schema: z.object({}),
  });
  const baseline = await createAgent({ model: new FakeToolCallingModel({ toolCalls: [calls('failure'), []] }), tools: [failure] })
    .invoke({ messages: input() });
  const result = await createSubagent({ model: new FakeToolCallingModel({ toolCalls: [calls('failure'), []] }),
    tools: [failure], promptSections: [], messages: input() });
  const error = result.messages.find(ToolMessage.isInstance);
  assert.equal(error?.status, 'error');
  assert.equal(error?.text, baseline.messages.find(ToolMessage.isInstance)?.text);
  assert.deepEqual(result.deliverables, []);
});

test('concurrent Capability invocations keep their declared references isolated', async () => {
  const results = await Promise.all(['left', 'right'].map(key => createSubagent({
    model: new FakeToolCallingModel({ toolCalls: [calls('emit'), []] }),
    tools: [tool(() => ['Declared.', createToolDeliverables([ref(key)])], {
      name: 'emit', description: 'Declare.', schema: z.object({}), responseFormat: 'content_and_artifact',
    })], promptSections: [], messages: input(), runtimeContext: { executionScope: {
      threadId: 'parallel', taskId: key, runId: 'run', delegationId: key,
    } },
  })));
  assert.deepEqual(results.map(result => result.deliverables), [[ref('left')], [ref('right')]]);
});

test('a malformed declaration fails the tool result rather than silently collecting partial data', async () => {
  const invalid = tool(() => ['Invalid declaration.', { deliverables: [{ uri: '' }] }], {
    name: 'invalid', description: 'Return an invalid declaration.', schema: z.object({}), responseFormat: 'content_and_artifact',
  });
  const result = await createSubagent({ model: new FakeToolCallingModel({ toolCalls: [calls('invalid'), []] }),
    tools: [invalid], promptSections: [], messages: input() });
  assert.equal(result.messages.find(ToolMessage.isInstance)?.status, 'error');
  assert.deepEqual(result.deliverables, []);
});

test('a pre-existing wrapper may return a declaration while retaining its error policy', async () => {
  const middleware = createMiddleware({ name: 'ExistingResult', wrapToolCall: async request => new ToolMessage({
    name: request.toolCall.name, tool_call_id: request.toolCall.id!, content: 'Synthetic result.',
    artifact: createToolDeliverables([ref('synthetic')]),
  }) });
  const result = await createSubagent({ model: new FakeToolCallingModel({ toolCalls: [calls('noop'), []] }),
    tools: [tool(() => 'unused', { name: 'noop', description: 'Read.', schema: z.object({}) })],
    middleware: [middleware], promptSections: [], messages: input() });
  assert.deepEqual(result.deliverables, [ref('synthetic')]);
  const passThrough = createMiddleware({ name: 'ExistingErrorPolicy', wrapToolCall: (request, handler) => handler(request) });
  const failure = tool(() => { throw new Error('Expected wrapped failure.'); }, {
    name: 'failure', description: 'Fail.', schema: z.object({}),
  });
  await assert.rejects(createAgent({ model: new FakeToolCallingModel({ toolCalls: [calls('failure')] }),
    tools: [failure], middleware: [passThrough] }).invoke({ messages: input() }), /Expected wrapped failure/);
  await assert.rejects(createSubagent({ model: new FakeToolCallingModel({ toolCalls: [calls('failure')] }),
    tools: [failure], middleware: [passThrough], promptSections: [], messages: input() }), /Expected wrapped failure/);
});

for (const tuple of [false, true]) {
  test(`same-graph Command ${tuple ? 'tuple' : 'object'} updates retain their result and declaration`, async () => {
    const reference = ref(`command-${tuple}`);
    const resultTool = tool(() => {
      const messages = [new ToolMessage({ name: 'command', tool_call_id: 'command:0', content: 'Command result.',
        artifact: createToolDeliverables([reference]) })];
      return new Command({ update: tuple ? [['messages', messages]] : { messages } });
    }, { name: 'command', description: 'Return a Command.', schema: z.object({}) });
    const result = await createSubagent({ model: new FakeToolCallingModel({ toolCalls: [calls('command'), []] }),
      tools: [resultTool], promptSections: [], messages: input() });
    assert.deepEqual(result.deliverables, [reference]);
    assert.equal(result.messages.find(ToolMessage.isInstance)?.text, 'Command result.');
  });
}

test('returnDirect stops after the tool and retains its declared reference', async () => {
  const model = new FakeToolCallingModel({ toolCalls: [calls('direct')] });
  const direct = tool(() => ['Direct result.', createToolDeliverables([ref('direct')])], {
    name: 'direct', description: 'Return directly.', schema: z.object({}), returnDirect: true,
    responseFormat: 'content_and_artifact',
  });
  const result = await createSubagent({ model, tools: [direct], promptSections: [], messages: input() });
  assert.equal(result.messages.filter(AIMessage.isInstance).length, 1);
  assert.deepEqual(result.deliverables, [ref('direct')]);
  assert.equal(result.messages.at(-1)?.text, 'Direct result.');
});

test('cross-graph control transfer passes through unchanged without adding child state', async () => {
  const transfer = new Command({ graph: Command.PARENT, goto: END, update: { messages: [new ToolMessage({
    name: 'transfer', tool_call_id: 'transfer:0', content: 'Transfer result.',
    artifact: createToolDeliverables([ref('outside-collector-guarantee')]),
  })] } });
  const transferTool = tool(() => transfer, { name: 'transfer', description: 'Transfer.', schema: z.object({}) });
  const collector = createToolDeliverablesCollector([transferTool], []);
  assert.strictEqual(await collector.tools[0].invoke({ name: 'transfer', id: 'transfer:0', args: {}, type: 'tool_call' }), transfer);
  assert.deepEqual(Object.keys(transfer.update ?? {}), ['messages']);
});

test('private summarization removes an old declaration message without losing accumulated references', async () => {
  const emit = tool(() => ['Reference published.', createToolDeliverables([ref('before-summary')])], {
    name: 'emit', description: 'Declare a reference.', schema: z.object({}), responseFormat: 'content_and_artifact',
  });
  const evidence = tool(() => 'Evidence. '.repeat(180), {
    name: 'evidence', description: 'Read more evidence.', schema: z.object({}),
  });
  const result = await createSubagent({ model: new FakeToolCallingModel({ toolCalls: [
    calls('emit'), calls('evidence'), calls('evidence'), calls('evidence'), [], [],
  ] }), tools: [emit, evidence], promptSections: [], messages: input(), contextWindowTokens: 1500, maxIterations: 8 });
  assert.ok(result.messages.some(message => message.additional_kwargs.lc_source === 'summarization'));
  assert.equal(result.messages.some(message => ToolMessage.isInstance(message) && message.name === 'emit'), false);
  assert.deepEqual(result.deliverables, [ref('before-summary')]);
});

for (const decision of ['approve', 'reject', 'cancel'] as const) {
  test(`parent/child Review ${decision} retains prior declarations across graph reconstruction`, async () => {
    let publications = 0;
    let writes = 0;
    let result: Awaited<ReturnType<typeof createSubagent>> | undefined;
    const emit = tool(() => {
      publications += 1;
      return ['Reference published.', createToolDeliverables([ref(decision)])];
    }, { name: 'emit', description: 'Declare.', schema: z.object({}), responseFormat: 'content_and_artifact' });
    const reviewed = tool(() => { writes += 1; return 'Authorized result.'; }, {
      name: 'reviewed', description: 'Perform an authorized mock action.', schema: z.object({}),
    });
    const model = new FakeToolCallingModel({ toolCalls: [calls('emit'), calls('reviewed'), []] });
    const saver = new MemorySaver();
    const build = (checkpoint: MemorySaver) => new StateGraph(MessagesAnnotation)
      .addNode('execute', async (state, config) => {
        const resolved = await resolveToolkitExecution([{ name: 'reports', description: 'Mock tools.', tools: [
          { tool: emit }, { tool: reviewed, review: { request: () => buildReviewSpec({
            view: { kind: 'plain', body: 'Authorize the mock action?' }, options: [
              { id: 'approve', label: 'Approve', decision: { type: 'approve' } },
              { id: 'reject', label: 'Reject', decision: { type: 'reject' } },
            ],
          }) } },
        ] }], undefined, { models: { act: model }, messages: state.messages,
          reviewCapabilities: { humanReview: true, sessionAuthorization: false } });
        result = await createSubagent({ model, tools: resolved.tools, middleware: resolved.middleware,
          promptSections: [], messages: state.messages, runnableConfig: config,
          runtimeContext: { executionScope: { threadId: `review-${decision}`, taskId: 'task', runId: 'run', delegationId: 'delegation' } },
        });
        return { messages: result.messages };
      }).addEdge(START, 'execute').addEdge('execute', END).compile({ checkpointer: checkpoint });
    const config = { configurable: { thread_id: `review-${decision}` } };
    const before = build(saver);
    await before.invoke({ messages: input() }, config);
    const interruptId = (await before.getState(config)).tasks.flatMap(task => task.interrupts ?? [])[0]?.id;
    assert.ok(interruptId);
    assert.equal(publications, 1);
    assert.equal(writes, 0);
    const namespaces = Object.keys(saver.storage[`review-${decision}`]);
    const checkpoints = await Promise.all(namespaces.map(checkpoint_ns => saver.getTuple({
      configurable: { ...config.configurable, checkpoint_ns },
    })));
    assert.ok(checkpoints.some(tuple => JSON.stringify(tuple?.checkpoint.channel_values.deliverables) === JSON.stringify([ref(decision)])),
      'declarations are in the child checkpoint before the interrupted action');
    const reopened = new MemorySaver();
    reopened.storage = saver.storage;
    reopened.writes = saver.writes;
    const graph = build(reopened);
    await graph.invoke(new Command({ resume: { [interruptId]: decision === 'cancel' ? { action: 'cancel' }
      : { decisions: [{ reviewId: 'tool-review:reviewed:reviewed:0', selectedOptionId: decision }] } } }), config);
    assert.equal(publications, 1);
    assert.equal(writes, decision === 'approve' ? 1 : 0);
    assert.deepEqual(result?.deliverables, [ref(decision)]);
    assert.equal(result?.reviewDecision, decision === 'approve' ? undefined : decision);
    await graph.invoke(null, config);
    assert.equal(publications, 1);
    assert.equal(writes, decision === 'approve' ? 1 : 0);
    const isolated = await createSubagent({ model: new FakeToolCallingModel({ toolCalls: [[]] }), tools: [],
      promptSections: [], messages: input(), runtimeContext: { executionScope: {
        threadId: `review-${decision}`, taskId: 'other', runId: 'run', delegationId: 'other-delegation',
      } } });
    assert.deepEqual(isolated.deliverables, []);
  });
}
