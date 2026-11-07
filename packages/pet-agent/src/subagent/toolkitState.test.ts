import assert from 'node:assert/strict';
import test from 'node:test';
import { HumanMessage, ToolMessage } from '@langchain/core/messages';
import { tool, type ToolRuntime } from '@langchain/core/tools';
import { Command, ReducedValue, StateSchema } from '@langchain/langgraph';
import { createMiddleware, FakeToolCallingModel } from 'langchain';
import { z } from 'zod/v4';
import { createCapabilityExecutor } from '../agent/orchestrator/capabilityExecution';
import { compileAgentRegistry } from '../agent/orchestrator/registry';
import { resolveToolkitExecution } from '../agent/orchestrator/subagentDispatch';
import type { ToolkitReviewRuntimeContext } from '../agent/orchestrator/toolkitReviewMiddleware';
import { defineInstructionDocument } from '../types/capability';
import { defineToolkit } from '../types/toolkit';
import { createSubagent } from './createSubagent';

function context(): ToolkitReviewRuntimeContext {
  return { models: { act: new FakeToolCallingModel() }, messages: [] };
}

// Match the existing native state schemas' Zod type bridge.
function nativeState(fields: Record<string, unknown>): StateSchema<any> {
  return new StateSchema<any>(fields as never);
}

function stateToolkit(name: string, stateSchema: StateSchema<any>) {
  return defineToolkit({ name, description: name, tools: [], instructions: 'Collect execution data.', stateSchema });
}

test('Toolkit state declarations require a native StateSchema', () => {
  const schema = nativeState({ marker: z.string().default('initial') });
  assert.equal(stateToolkit('native', schema).stateSchema, schema);
  assert.throws(() => defineToolkit({
    name: 'invalid-state', description: 'Invalid schema.', tools: [], instructions: 'Collect execution data.',
    // @ts-expect-error Toolkit state uses native StateSchema rather than a Zod object.
    stateSchema: z.object({ marker: z.string() }),
  }), (error: unknown) => error instanceof Error
    && error.message.includes('invalid-state') && error.message.includes('StateSchema'));
});

test('selected Toolkit schemas preserve defaults and reducers through parallel and serial tool updates', async () => {
  const observations: string[][] = [];
  const record = tool(({ path }, runtime: ToolRuntime<{ collectedPaths: string[] }>) => {
    observations.push([...runtime.state.collectedPaths]);
    return new Command({ update: {
      collectedPaths: [path],
      messages: [new ToolMessage({
        content: `Collected ${path}`, name: 'collect_path', tool_call_id: runtime.toolCall!.id!,
      })],
    } });
  }, { name: 'collect_path', description: 'Collect a path.', schema: z.object({ path: z.string() }) });
  const paths = defineToolkit({
    name: 'paths', description: 'Collect paths.', tools: [{ tool: record }],
    stateSchema: nativeState({
      collectedPaths: new ReducedValue<string[], string[]>(z.array(z.string()).default([]) as never, {
        reducer: (current, next) => [...new Set([...current, ...next])],
      }),
    }),
  });
  const marker = stateToolkit('marker', nativeState({ marker: z.string().default('initial') }));
  const unused = stateToolkit('unused', nativeState({ unused: z.boolean().default(true) }));
  const resolved = await resolveToolkitExecution([paths, marker, unused], ['paths', 'marker'], context());
  const result = await createSubagent({
    model: new FakeToolCallingModel({ toolCalls: [
      [
        { id: 'path-a', name: 'collect_path', args: { path: 'a' } },
        { id: 'path-b', name: 'collect_path', args: { path: 'b' } },
        { id: 'path-a-again', name: 'collect_path', args: { path: 'a' } },
      ],
      [{ id: 'path-c', name: 'collect_path', args: { path: 'c' } }],
      [],
    ] }),
    tools: resolved.tools, middleware: resolved.middleware, stateSchema: resolved.stateSchema,
    promptSections: [], messages: [new HumanMessage('Collect paths.')],
  });
  assert.deepEqual(result.state.collectedPaths, ['a', 'b', 'c']);
  assert.equal(result.state.marker, 'initial');
  assert.equal(Object.hasOwn(result.state, 'unused'), false);
  assert.deepEqual(observations, [[], [], [], ['a', 'b']]);
  assert.equal(result.messages.filter(ToolMessage.isInstance).length, 4);
  assert.strictEqual(result.state.messages, result.messages);

  const next = await createSubagent({
    model: new FakeToolCallingModel({ toolCalls: [[]] }), tools: resolved.tools,
    stateSchema: resolved.stateSchema, middleware: resolved.middleware,
    promptSections: [], messages: [new HumanMessage('Start another execution.')],
  });
  assert.deepEqual(next.state.collectedPaths, []);
  assert.notStrictEqual(next.state.collectedPaths, result.state.collectedPaths);
  assert.deepEqual(result.state.collectedPaths, ['a', 'b', 'c']);
});

test('Toolkit field conflicts report both owners only when selected together', async () => {
  const alpha = stateToolkit('alpha', nativeState({ shared: z.string().default('a') }));
  const beta = stateToolkit('beta', nativeState({ shared: z.string().default('b') }));
  await resolveToolkitExecution([alpha, beta], ['alpha'], context());
  await assert.rejects(resolveToolkitExecution([alpha, beta], undefined, context()),
    (error: unknown) => error instanceof Error
      && ['shared', 'alpha', 'beta'].every(value => error.message.includes(value)));
});

test('subagent rejects state fields owned by the framework before calling the model', async () => {
  let modelCalls = 0;
  const observeModel = createMiddleware({
    name: 'ObserveModel', wrapModelCall: (request, handler) => { modelCalls += 1; return handler(request); },
  });
  for (const field of ['messages', 'jumpTo', 'structuredResponse', 'runModelCallCount', 'threadModelCallCount', 'constructor', '__proto__']) {
    await assert.rejects(createSubagent({
      model: new FakeToolCallingModel({ toolCalls: [[]] }), tools: [], promptSections: [],
      messages: [new HumanMessage('Run.')], middleware: [observeModel],
      stateSchema: nativeState({ [field]: z.string().default('collision') }),
    }), (error: unknown) => error instanceof Error && error.message.includes(field));
  }
  assert.equal(modelCalls, 0);
});

for (const [kind, stateSchema] of [
  ['Zod', z.object({ progress: z.number().default(0) })],
  ['StateSchema', nativeState({ progress: z.number().default(0) })],
] as const) {
  test(`subagent rejects collisions with supplied ${kind} middleware state`, async () => {
    const middleware = createMiddleware({ name: 'TaskProgress', stateSchema });
    await assert.rejects(createSubagent({
      model: new FakeToolCallingModel({ toolCalls: [[]] }), tools: [], promptSections: [],
      messages: [new HumanMessage('Run.')], middleware: [middleware],
      stateSchema: nativeState({ progress: z.number().default(1) }),
    }), (error: unknown) => error instanceof Error
      && error.message.includes('progress') && error.message.includes('TaskProgress'));
  });
}

test('Capability uses controls state assembly and registry snapshots its field definitions', async () => {
  const fields = { marker: z.string().default('initial') };
  const selected = stateToolkit('selected', nativeState(fields));
  const unused = stateToolkit('unused', nativeState({ hidden: z.boolean().default(true) }));
  let returnedState: Readonly<Record<string, unknown>> | undefined;
  const registry = compileAgentRegistry({
    toolkits: [selected, unused],
    capabilities: [{
      name: 'general', description: 'Read selected Toolkit state.', uses: ['selected'],
      instructions: defineInstructionDocument({ content: 'Complete the task.' }),
      lifecycle: { finalize: result => { returnedState = result.state; } },
    }],
  });
  fields.marker = z.string().default('changed after compilation');
  const result = await createCapabilityExecutor({
    models: { act: new FakeToolCallingModel({ toolCalls: [[]] }) },
  })({
    capability: registry.capabilities[0],
    delegation: {
      id: 'state-delegation', runId: 'state-run', taskId: 'state-task',
      userRequest: 'Inspect state.', task: 'Inspect selected state.', briefing: 'Return the result.',
    },
    history: [new HumanMessage({ id: 'state-user', content: 'Inspect state.' })],
  }, { review: { authorizations: [] } });
  assert.equal(result.status, 'returned');
  assert.equal(returnedState?.marker, 'initial');
  assert.equal(Object.hasOwn(returnedState!, 'hidden'), false);
});

test('subagents without custom state keep existing messages and output', async () => {
  const result = await createSubagent({
    model: new FakeToolCallingModel({ toolCalls: [[]] }), tools: [], promptSections: [],
    messages: [new HumanMessage('Reply normally.')],
  });
  assert.equal(result.output, result.messages.at(-1)?.text);
  assert.ok(result.output);
  assert.strictEqual(result.state.messages, result.messages);
});
