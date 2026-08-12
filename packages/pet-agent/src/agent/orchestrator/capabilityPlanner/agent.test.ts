import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  AIMessage,
  HumanMessage,
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { tool, type StructuredTool } from '@langchain/core/tools';
import {
  Annotation,
  Command,
  END,
  interrupt,
  MemorySaver,
  START,
  StateGraph,
} from '@langchain/langgraph';
import { z } from 'zod';
import {
  CAPABILITY_PLANNER_GREP_SEARCH_TOOL_NAME,
} from './fileExplorer';
import type { CapabilityDocumentWorkspace } from './documentWorkspace';
import {
  CapabilityPlannerAgentError,
  createCapabilityPlannerAgent,
} from './agent';
import type { CapabilityPlannerInput } from './runner';

type ScriptedToolCall = {
  id?: string;
  name: string;
  args: Record<string, unknown>;
};

type ScriptedStructuredOutput = {
  kind: 'plan' | 'unavailable';
  args: Record<string, unknown>;
};

function collectJsonSchemaReferences(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(collectJsonSchemaReferences);
  }
  if (!value || typeof value !== 'object') {
    return [];
  }
  return Object.entries(value).flatMap(([key, child]) => {
    if (key === '$ref' && typeof child === 'string') {
      return [child];
    }
    return collectJsonSchemaReferences(child);
  });
}

function readMessageText(message: BaseMessage): string {
  if (typeof message.content === 'string') {
    return message.content;
  }
  return message.content.map((item) => {
    if (typeof item === 'string') return item;
    return typeof item === 'object' && item !== null && 'text' in item
      && typeof item.text === 'string'
      ? item.text
      : '';
  }).join('');
}

class ScriptedPlannerModel extends BaseChatModel {
  readonly invocations: BaseMessage[][] = [];
  readonly boundToolNames: string[] = [];
  readonly boundToolOptions: Array<Record<string, unknown> | undefined> = [];
  readonly structuredOutputToolNames = new Map<string, string>();
  readonly structuredOutputSchemaReferences: string[] = [];
  readonly structuredOutputPlanLimits: number[] = [];
  readonly structuredOutputCapabilityEnums: string[][] = [];
  #responseIndex = 0;

  constructor(
    private readonly responses: ReadonlyArray<{
      content?: string;
      toolCalls?: readonly ScriptedToolCall[];
      structuredOutput?: ScriptedStructuredOutput;
    }>,
  ) {
    super({});
  }

  _llmType() {
    return 'scripted-capability-planner';
  }

  bindTools(tools: StructuredTool[], options?: Record<string, unknown>) {
    this.boundToolOptions.push(options);
    const toolEntries = tools as unknown as Array<{
      name?: string;
      schema?: {
        shape?: Record<string, unknown>;
      };
      function?: {
        name?: string;
        parameters?: Record<string, unknown>;
      };
    }>;
    this.boundToolNames.splice(
      0,
      this.boundToolNames.length,
      ...toolEntries.flatMap((entry) => {
        const name = entry.name ?? entry.function?.name;
        return name ? [name] : [];
      }),
    );
    this.structuredOutputToolNames.clear();
    this.structuredOutputSchemaReferences.splice(
      0,
      this.structuredOutputSchemaReferences.length,
    );
    this.structuredOutputPlanLimits.splice(
      0,
      this.structuredOutputPlanLimits.length,
    );
    this.structuredOutputCapabilityEnums.splice(
      0,
      this.structuredOutputCapabilityEnums.length,
    );
    for (const entry of toolEntries) {
      const name = entry.name ?? entry.function?.name;
      const parameters = entry.function?.parameters;
      const kind = name === 'submit_plan'
        ? 'plan'
        : name === 'report_unavailable' ? 'unavailable' : null;
      if (name && kind) {
        this.structuredOutputToolNames.set(kind, name);
        this.structuredOutputSchemaReferences.push(
          ...collectJsonSchemaReferences(parameters),
        );
        const tasks = entry.schema?.shape?.tasks as {
          _def?: {
            maxLength?: { value?: unknown } | null;
            type?: {
              shape?: Record<string, unknown>;
            };
          };
        } | undefined;
        const maxItems = tasks?._def?.maxLength?.value;
        if (kind === 'plan' && typeof maxItems === 'number') {
          this.structuredOutputPlanLimits.push(maxItems);
        }
        const capability = tasks?._def?.type?.shape?.capability as {
          _def?: { values?: unknown };
        } | undefined;
        const capabilityEnum = capability?._def?.values;
        if (kind === 'plan' && Array.isArray(capabilityEnum)) {
          this.structuredOutputCapabilityEnums.push(
            capabilityEnum.filter((name): name is string => typeof name === 'string'),
          );
        }
      }
    }
    return this;
  }

  async _generate(messages: BaseMessage[]) {
    this.invocations.push([...messages]);
    const response = this.responses[this.#responseIndex] ?? { content: 'done' };
    this.#responseIndex += 1;
    const structuredToolCall = response.structuredOutput
      ? [{
          id: `structured-${String(this.#responseIndex)}`,
          name: this.structuredOutputToolNames.get(
            response.structuredOutput.kind,
          ) ?? `missing-${response.structuredOutput.kind}-output-tool`,
          args: response.structuredOutput.kind === 'unavailable'
            ? {}
            : response.structuredOutput.args,
        }]
      : undefined;
    const message = new AIMessage({
      content: response.content ?? '',
      tool_calls: (response.toolCalls ?? structuredToolCall)?.map((call) => ({
        ...call,
        type: 'tool_call' as const,
      })),
    });
    return { generations: [{ message, text: String(message.content) }] };
  }
}

class DelayedStructuredPlannerModel extends ScriptedPlannerModel {
  override async _generate(messages: BaseMessage[]) {
    const result = await super._generate(messages);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 30);
    });
    return result;
  }
}

class SlowPlannerModel extends BaseChatModel {
  _llmType() {
    return 'slow-capability-planner';
  }

  bindTools() {
    return this;
  }

  async _generate(
    _messages: BaseMessage[],
    options: this['ParsedCallOptions'],
  ) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 5_000);
      timer.unref();
      options.signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(options.signal?.reason ?? new Error('aborted'));
      }, { once: true });
    });
    const message = new AIMessage('late');
    return { generations: [{ message, text: 'late' }] };
  }
}

function sha256(content: string) {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

async function createWorkspace(
  t: test.TestContext,
  documents: Record<string, string>,
): Promise<CapabilityDocumentWorkspace> {
  const rootPath = await mkdtemp(join(tmpdir(), 'capability-planner-agent-'));
  t.after(() => rm(rootPath, { recursive: true, force: true }));
  const entries = [];
  for (const capabilityName of Object.keys(documents).sort()) {
    const content = documents[capabilityName] as string;
    const relativePath = `${capabilityName}/CAPABILITY.md`;
    await mkdir(join(rootPath, capabilityName));
    await writeFile(join(rootPath, relativePath), content, 'utf8');
    entries.push(Object.freeze({
      capabilityName,
      relativePath,
      documentDigest: sha256(content),
      provenance: 'authored' as const,
    }));
  }
  return Object.freeze({
    rootPath,
    registryDigest: sha256(JSON.stringify(
      entries.map(({ capabilityName, documentDigest }) => ({
        capabilityName,
        documentDigest,
      })),
    )),
    capabilityNames: Object.freeze(entries.map(({ capabilityName }) => capabilityName)),
    entries: Object.freeze(entries),
    reused: false,
  });
}

function capabilityDocument(params: {
  name: string;
  description: string;
  instructions: string;
}) {
  return [
    '---',
    `name: ${params.name}`,
    `description: ${params.description}`,
    'uses: []',
    'version: 1',
    '---',
    '',
    params.instructions,
    '',
  ].join('\n');
}

function plannerInput(
  workspace: CapabilityDocumentWorkspace,
  overrides: Partial<CapabilityPlannerInput> = {},
): CapabilityPlannerInput {
  const base = {
    inputId: 'trace_started:trace-test',
    traceId: 'trace-test',
    runId: 'run-test',
    userGoal: {
      objective: 'Research the repository and then prepare a review.',
      context: null,
    },
    latestUserMessage: null,
    activeDelegation: null,
    latestAnnounce: null,
    remainingPlan: [],
    workspace,
  };
  if (overrides.mode === 'boundary') {
    return {
      ...base,
      ...overrides,
      mode: 'boundary',
    } as CapabilityPlannerInput;
  }
  return {
    ...base,
    mode: 'entry',
    ...overrides,
  } as CapabilityPlannerInput;
}

function submitArgs(
  capabilityName: string,
) {
  return {
    tasks: [{
      capability: capabilityName,
      task: 'Research the repository.',
    }, {
      capability: 'general',
      task: 'Prepare the review from the findings.',
    }],
  };
}

test('nested Planner checkpoint persists one trace privately and deduplicates boundary inputs', async (t) => {
  const workspace = await createWorkspace(t, {
    general: capabilityDocument({
      name: 'general',
      description: 'Handle ordinary workspace tasks.',
      instructions: 'Complete the requested work.',
    }),
  });
  const changedWorkspace = await createWorkspace(t, {
    general: capabilityDocument({
      name: 'general',
      description: 'Handle updated workspace tasks.',
      instructions: 'Use the updated Capability contract.',
    }),
  });
  const model = new ScriptedPlannerModel([{
    structuredOutput: {
      kind: 'plan',
      args: {
        tasks: [{ capability: 'general', task: 'Complete trace A.' }],
      },
    },
  }, {
    toolCalls: [{ id: 'done-a', name: 'complete_goal', args: {} }],
  }, {
    toolCalls: [{ id: 'unavailable-b', name: 'report_unavailable', args: {} }],
  }, {
    toolCalls: [{ id: 'unavailable-c', name: 'report_unavailable', args: {} }],
  }]);
  const planner = createCapabilityPlannerAgent({ model });
  const HarnessState = Annotation.Root({
    input: Annotation<CapabilityPlannerInput>({
      reducer: (_previous, next) => next,
    }),
    commit: Annotation<unknown>({
      reducer: (_previous, next) => next,
      default: () => null,
    }),
  });
  const checkpointer = new MemorySaver();
  const graph = new StateGraph(HarnessState)
    .addNode('planner', async (state, config) => ({
      commit: await planner.invoke(state.input, config),
    }))
    .addEdge(START, 'planner')
    .addEdge('planner', END)
    .compile({ checkpointer });
  const config = { configurable: { thread_id: 'private-planner-checkpoint' } };
  const entryA = plannerInput(workspace, {
    inputId: 'trace_started:trace-a',
    traceId: 'trace-a',
    runId: 'run-a1',
    userGoal: { objective: 'PRIVATE_TRACE_A_GOAL', context: null },
  });
  const boundaryA = plannerInput(workspace, {
    mode: 'boundary',
    inputId: 'announce:delegation-a:1',
    traceId: 'trace-a',
    runId: 'run-a2',
    userGoal: entryA.userGoal,
    activeDelegation: {
      delegationId: 'delegation-a',
      capability: 'general',
      task: 'Complete trace A.',
    },
    latestAnnounce: {
      messageId: 'announce-a',
      text: 'Trace A execution is complete.',
      completionReason: 'natural',
    },
  });

  const entryState = await graph.invoke({ input: entryA }, config);
  assert.deepEqual(entryState.commit, {
    action: 'execute_plan',
    tasks: [{ capability: 'general', task: 'Complete trace A.' }],
  });
  const boundaryState = await graph.invoke({ input: boundaryA }, config);
  assert.deepEqual(boundaryState.commit, { action: 'goal_done', tasks: [] });
  assert.equal(model.invocations.length, 2);
  const checkpointNamespaces = Object.keys(
    checkpointer.storage['private-planner-checkpoint'] ?? {},
  );
  assert.ok(
    checkpointNamespaces.includes('privateCapabilityPlanner_trace-a'),
    `expected stable Planner namespace; found ${JSON.stringify(checkpointNamespaces)}`,
  );
  const plannerCheckpoint = await checkpointer.getTuple({
    configurable: {
      thread_id: 'private-planner-checkpoint',
      checkpoint_ns: 'privateCapabilityPlanner_trace-a',
    },
  });
  assert.equal(
    plannerCheckpoint?.checkpoint.channel_values.committedInputId,
    boundaryA.inputId,
  );
  assert.match(
    model.invocations[1]?.map(readMessageText).join('\n') ?? '',
    /PRIVATE_TRACE_A_GOAL/,
  );

  const duplicateState = await graph.invoke({ input: boundaryA }, config);
  assert.deepEqual(duplicateState.commit, { action: 'goal_done', tasks: [] });
  assert.equal(model.invocations.length, 2, 'duplicate inputId must use the private cached commit');

  const restartedModel = new ScriptedPlannerModel([{
    toolCalls: [{ id: 'must-not-run', name: 'report_unavailable', args: {} }],
  }]);
  const restartedPlanner = createCapabilityPlannerAgent({ model: restartedModel });
  const restartedGraph = new StateGraph(HarnessState)
    .addNode('planner', async (state, runnableConfig) => ({
      commit: await restartedPlanner.invoke(state.input, runnableConfig),
    }))
    .addEdge(START, 'planner')
    .addEdge('planner', END)
    .compile({ checkpointer });
  const restartedState = await restartedGraph.invoke({ input: boundaryA }, config);
  assert.deepEqual(restartedState.commit, { action: 'goal_done', tasks: [] });
  assert.equal(restartedModel.invocations.length, 0, 'a rebuilt Planner must replay the persisted commit');

  const changedRegistryState = await graph.invoke({
    input: { ...boundaryA, workspace: changedWorkspace },
  }, config);
  assert.deepEqual(changedRegistryState.commit, { action: 'unavailable', tasks: [] });
  assert.equal(model.invocations.length, 3, 'registry changes must invalidate a cached commit');

  const entryB = plannerInput(workspace, {
    inputId: 'trace_started:trace-b',
    traceId: 'trace-b',
    runId: 'run-b1',
    userGoal: { objective: 'PRIVATE_TRACE_B_GOAL', context: null },
  });
  const traceBState = await graph.invoke({ input: entryB }, config);
  assert.deepEqual(traceBState.commit, { action: 'unavailable', tasks: [] });
  assert.equal(model.invocations.length, 4);
  const traceBMessages = model.invocations[3]?.map(readMessageText).join('\n') ?? '';
  assert.match(traceBMessages, /PRIVATE_TRACE_B_GOAL/);
  assert.doesNotMatch(traceBMessages, /PRIVATE_TRACE_A_GOAL/);
  assert.equal('messages' in traceBState, false, 'private Planner messages must not enter root state');

  await assert.rejects(
    graph.invoke({
      input: plannerInput(workspace, {
        mode: 'boundary',
        inputId: 'announce:missing:1',
        traceId: 'trace-missing',
        runId: 'run-missing',
        activeDelegation: {
          delegationId: 'missing',
          capability: 'general',
          task: 'Cannot resume without a Planner checkpoint.',
        },
      }),
    }, config),
    (error: unknown) => error instanceof CapabilityPlannerAgentError
      && error.code === 'planner_checkpoint_missing',
  );
  assert.equal(model.invocations.length, 4);

  await assert.rejects(
    restartedGraph.invoke({ input: boundaryA }, {
      configurable: { thread_id: 'private-planner-other-thread' },
    }),
    (error: unknown) => error instanceof CapabilityPlannerAgentError
      && error.code === 'planner_checkpoint_missing',
    'the same traceId in another conversation thread must not see private state',
  );
  assert.equal(restartedModel.invocations.length, 0);
});

test('Planner compacts only its private checkpoint and preserves trace context', async (t) => {
  const workspace = await createWorkspace(t, {
    general: capabilityDocument({
      name: 'general',
      description: 'Handle ordinary workspace tasks.',
      instructions: 'Complete the requested work.',
    }),
  });
  const model = new ScriptedPlannerModel([{
    structuredOutput: {
      kind: 'plan',
      args: { tasks: [{ capability: 'general', task: 'Complete the long task.' }] },
    },
  }, ...Array.from({ length: 4 }, (_, index) => ({
    toolCalls: [{ id: `done-${String(index)}`, name: 'complete_goal', args: {} }],
  }))]);
  const planner = createCapabilityPlannerAgent({
    model,
    privateContextMaxChars: 500,
    privateContextKeepInputs: 2,
  });
  const HarnessState = Annotation.Root({
    input: Annotation<CapabilityPlannerInput>({
      reducer: (_previous, next) => next,
    }),
    commit: Annotation<unknown>({
      reducer: (_previous, next) => next,
      default: () => null,
    }),
  });
  const checkpointer = new MemorySaver();
  const graph = new StateGraph(HarnessState)
    .addNode('planner', async (state, config) => ({
      commit: await planner.invoke(state.input, config),
    }))
    .addEdge(START, 'planner')
    .addEdge('planner', END)
    .compile({ checkpointer });
  const config = { configurable: { thread_id: 'private-planner-compaction' } };
  const userGoal = {
    objective: `PRIVATE_COMPACTION_GOAL ${'context '.repeat(80)}`,
    context: null,
  };
  await graph.invoke({
    input: plannerInput(workspace, {
      inputId: 'trace_started:trace-compaction',
      traceId: 'trace-compaction',
      runId: 'run-0',
      userGoal,
    }),
  }, config);
  for (let index = 1; index <= 4; index += 1) {
    await graph.invoke({
      input: plannerInput(workspace, {
        mode: 'boundary',
        inputId: `announce:delegation:${String(index)}`,
        traceId: 'trace-compaction',
        runId: `run-${String(index)}`,
        userGoal,
        activeDelegation: {
          delegationId: 'delegation',
          capability: 'general',
          task: 'Complete the long task.',
        },
        latestAnnounce: {
          messageId: `announce-${String(index)}`,
          text: `Execution result ${String(index)} ${'evidence '.repeat(40)}`,
          completionReason: 'natural',
        },
      }),
    }, config);
  }

  const plannerCheckpoint = await checkpointer.getTuple({
    configurable: {
      thread_id: 'private-planner-compaction',
      checkpoint_ns: 'privateCapabilityPlanner_trace-compaction',
    },
  });
  const values = plannerCheckpoint?.checkpoint.channel_values as {
    messages?: BaseMessage[];
    compactionCount?: number;
  } | undefined;
  assert.ok((values?.compactionCount ?? 0) > 0);
  assert.ok(values?.messages?.some((message) => {
    const text = readMessageText(message);
    return text.includes('<private_planner_compaction>')
      && text.includes('PRIVATE_COMPACTION_GOAL');
  }));
  assert.ok(model.invocations.at(-1)?.some((message) =>
    readMessageText(message).includes('<private_planner_compaction>')));
  const rootState = await graph.getState(config);
  assert.equal('messages' in rootState.values, false);
});

test('parent bare Command resume continues an in-flight private Planner interrupt', async (t) => {
  const workspace = await createWorkspace(t, {
    general: capabilityDocument({
      name: 'general',
      description: 'Handle ordinary workspace tasks.',
      instructions: 'Complete the requested work.',
    }),
  });
  const pausePlanner = tool(async () => interrupt({
    kind: 'private_planner_test_pause',
  }), {
    name: 'pause_planner',
    description: 'Pause the private Planner for a host decision.',
    schema: z.object({}).strict(),
  });
  const model = new ScriptedPlannerModel([{
    toolCalls: [{ id: 'pause', name: 'pause_planner', args: {} }],
  }, {
    structuredOutput: {
      kind: 'plan',
      args: {
        tasks: [{ capability: 'general', task: 'Continue after approval.' }],
      },
    },
  }]);
  const planner = createCapabilityPlannerAgent({
    model,
    additionalPrivateTools: [pausePlanner],
  });
  const HarnessState = Annotation.Root({
    input: Annotation<CapabilityPlannerInput>({
      reducer: (_previous, next) => next,
    }),
    commit: Annotation<unknown>({
      reducer: (_previous, next) => next,
      default: () => null,
    }),
  });
  const graph = new StateGraph(HarnessState)
    .addNode('planner', async (state, config) => ({
      commit: await planner.invoke(state.input, config),
    }))
    .addEdge(START, 'planner')
    .addEdge('planner', END)
    .compile({ checkpointer: new MemorySaver() });
  const config = { configurable: { thread_id: 'private-planner-interrupt' } };
  const input = plannerInput(workspace, {
    inputId: 'trace_started:trace-interrupt',
    traceId: 'trace-interrupt',
    runId: 'run-interrupt',
    userGoal: { objective: 'Continue after private approval.', context: null },
  });

  const interrupted = await graph.invoke({ input }, config) as {
    __interrupt__?: unknown[];
  };
  assert.equal(interrupted.__interrupt__?.length, 1);
  assert.equal(model.invocations.length, 1);

  const resumed = await graph.invoke(
    new Command({ resume: 'approved' }),
    config,
  );
  assert.deepEqual(resumed.commit, {
    action: 'execute_plan',
    tasks: [{ capability: 'general', task: 'Continue after approval.' }],
  });
  assert.equal(resumed.input.runId, 'run-interrupt');
  assert.equal(resumed.input.traceId, 'trace-interrupt');
  assert.equal(model.invocations.length, 2);
  assert.match(
    model.invocations[1]?.map(readMessageText).join('\n') ?? '',
    /approved/,
  );
});

test('Planner Agent explores CAPABILITY.md files and returns a compact ordered task plan', async (t) => {
  const workspace = await createWorkspace(t, {
    explore: capabilityDocument({
      name: 'explore',
      description: 'Investigate repositories and gather evidence.',
      instructions: 'Research files and return a verified evidence summary.',
    }),
    general: capabilityDocument({
      name: 'general',
      description: 'Handle ordinary tasks.',
      instructions: 'Complete a general task.',
    }),
  });
  const model = new ScriptedPlannerModel([
    {
      toolCalls: [{
        id: 'grep',
        name: CAPABILITY_PLANNER_GREP_SEARCH_TOOL_NAME,
        args: { query: 'research' },
      }],
    },
    {
      structuredOutput: {
        kind: 'plan',
        args: submitArgs('explore'),
      },
    },
  ]);
  const result = await createCapabilityPlannerAgent({ model })
    .invoke(plannerInput(workspace));

  assert.deepEqual(model.boundToolNames.slice(0, 1), [
    CAPABILITY_PLANNER_GREP_SEARCH_TOOL_NAME,
  ]);
  assert.equal(model.structuredOutputToolNames.size, 2);
  assert.ok(model.structuredOutputToolNames.has('plan'));
  assert.ok(model.structuredOutputToolNames.has('unavailable'));
  assert.deepEqual(model.structuredOutputSchemaReferences, []);
  assert.deepEqual(model.structuredOutputPlanLimits, [24]);
  assert.deepEqual(model.structuredOutputCapabilityEnums, []);
  assert.ok(model.boundToolOptions.every((options) =>
    options?.tool_choice === undefined));
  assert.equal(model.invocations.length, 2);
  assert.equal(model.invocations.flat().some((message) =>
    message._getType() === 'system'
    && String(message.content).includes(workspace.rootPath)), false);
  assert.ok(model.invocations[0]?.some((message) =>
    message instanceof HumanMessage
    && String(message.content).includes('Research the repository and then prepare a review.')));
  const firstInvocationTexts = model.invocations[0]?.map((message) => String(message.content)) ?? [];
  const plannerInputIndex = firstInvocationTexts.findIndex(
    (text) => text.includes('Research the repository and then prepare a review.'),
  );
  assert.ok(plannerInputIndex >= 0);
  assert.deepEqual(result, {
    action: 'execute_plan',
    tasks: [{
      capability: 'explore',
      task: 'Research the repository.',
    }, {
      capability: 'general',
      task: 'Prepare the review from the findings.',
    }],
  });
});

test('entry mode forms one executable task after Capability exploration', async (t) => {
  const workspace = await createWorkspace(t, {
    explore: capabilityDocument({
      name: 'explore',
      description: 'Investigate repositories.',
      instructions: 'Inspect files and report evidence.',
    }),
  });
  const model = new ScriptedPlannerModel([
    {
      toolCalls: [{
        id: 'grep',
        name: CAPABILITY_PLANNER_GREP_SEARCH_TOOL_NAME,
        args: { query: 'investigate|repository' },
      }],
    },
    {
      structuredOutput: {
        kind: 'plan',
        args: {
          tasks: [{
            capability: 'explore',
            task: 'Inspect issue #473 and report the Planner Agent constraints.',
          }],
        },
      },
    },
  ]);

  const result = await createCapabilityPlannerAgent({ model })
    .invoke(plannerInput(workspace));

  assert.equal(model.invocations.length, 2);
  assert.equal(model.structuredOutputToolNames.size, 2);
  assert.ok(model.structuredOutputToolNames.has('plan'));
  assert.ok(model.structuredOutputToolNames.has('unavailable'));
  assert.ok('tasks' in result);
  assert.equal(
    'tasks' in result ? result.tasks[0]?.task : null,
    'Inspect issue #473 and report the Planner Agent constraints.',
  );
  assert.equal('tasks' in result ? result.tasks.length : 0, 1);
});

test('Planner accepts consecutive tasks from one Capability when the model keeps distinct boundaries', async (t) => {
  const workspace = await createWorkspace(t, {
    general: capabilityDocument({
      name: 'general',
      description: 'Handle ordinary workspace tasks.',
      instructions: 'Complete the requested work.',
    }),
  });
  const model = new ScriptedPlannerModel([
    {
      structuredOutput: {
        kind: 'plan',
        args: {
          tasks: [{
            capability: 'general',
            task: 'Inspect the failing release and identify the exact package boundary.',
          }, {
            capability: 'general',
            task: 'Apply the accepted findings, verify the package, and publish it.',
          }],
        },
      },
    },
  ]);

  const result = await createCapabilityPlannerAgent({ model })
    .invoke(plannerInput(workspace));

  assert.ok('tasks' in result);
  assert.deepEqual('tasks' in result ? result.tasks : [], [{
    capability: 'general',
    task: 'Inspect the failing release and identify the exact package boundary.',
  }, {
    capability: 'general',
    task: 'Apply the accepted findings, verify the package, and publish it.',
  }]);
});

test('Planner closes discovery through general after three grep_search calls', async (t) => {
  const workspace = await createWorkspace(t, {
    general: capabilityDocument({
      name: 'general',
      description: 'Handle ordinary workspace tasks.',
      instructions: 'Complete the requested work.',
    }),
  });
  const model = new ScriptedPlannerModel([
    ...[1, 2, 3].map((attempt) => ({
      toolCalls: [{
        id: `grep-${String(attempt)}`,
        name: CAPABILITY_PLANNER_GREP_SEARCH_TOOL_NAME,
        args: { query: 'general' },
      }],
    })),
    {
      structuredOutput: {
        kind: 'plan',
        args: {
          tasks: [{
            capability: 'general',
            task: 'Complete the requested workspace task using the discovered Capability.',
          }],
        },
      },
    },
  ]);

  const result = await createCapabilityPlannerAgent({ model }).invoke(
    plannerInput(workspace),
  );

  assert.deepEqual(result, {
    action: 'execute_plan',
    tasks: [{
      capability: 'general',
      task: 'Complete the requested workspace task using the discovered Capability.',
    }],
  });
  const grepResults = [...new Map(
    model.invocations.flat().filter(
      (message): message is ToolMessage => message instanceof ToolMessage
        && message.name === CAPABILITY_PLANNER_GREP_SEARCH_TOOL_NAME,
    ).map((message) => [message.tool_call_id, message]),
  ).values()];
  assert.equal(grepResults.length, 3);
  assert.equal(grepResults.some((message) => message.status === 'error'), false);
});

test('Planner receives verified General before discovery starts', async (t) => {
  const workspace = await createWorkspace(t, {
    general: capabilityDocument({
      name: 'general',
      description: '处理不需要更具体 Capability 的通用任务。',
      instructions: '使用通用工具读取和修改工作区。',
    }),
  });
  const model = new ScriptedPlannerModel([{
    structuredOutput: {
      kind: 'plan',
      args: {
        tasks: [{
          capability: 'general',
          task: 'Inspect and organize the requested Downloads directory.',
        }],
      },
    },
  }]);

  const result = await createCapabilityPlannerAgent({ model }).invoke(
    plannerInput(workspace, {
      userGoal: {
        objective: '查看并整理 /Users/mac/Downloads 目录。',
        context: '用户明确允许使用通用工具。',
      },
    }),
  );

  assert.deepEqual(result, {
    action: 'execute_plan',
    tasks: [{
      capability: 'general',
      task: 'Inspect and organize the requested Downloads directory.',
    }],
  });
  const privateInput = model.invocations[0]?.find(
    (message) => message instanceof HumanMessage,
  );
  assert.ok(privateInput instanceof HumanMessage);
  assert.match(readMessageText(privateInput), /<default_capability/);
  assert.match(readMessageText(privateInput), /general\/CAPABILITY\.md/);
  assert.match(readMessageText(privateInput), /通用工具读取和修改工作区/);
  assert.equal(model.invocations.flat().some(
    (message) => message instanceof ToolMessage
      && message.name === CAPABILITY_PLANNER_GREP_SEARCH_TOOL_NAME,
  ), false);
});

test('Planner handles parallel grep_search calls without concurrent state updates', async (t) => {
  const workspace = await createWorkspace(t, {
    general: capabilityDocument({
      name: 'general',
      description: 'Handle ordinary workspace tasks.',
      instructions: 'Complete the requested work.',
    }),
  });
  const model = new ScriptedPlannerModel([
    {
      toolCalls: [{
        id: 'parallel-grep-1',
        name: CAPABILITY_PLANNER_GREP_SEARCH_TOOL_NAME,
        args: { query: 'general' },
      }, {
        id: 'parallel-grep-2',
        name: CAPABILITY_PLANNER_GREP_SEARCH_TOOL_NAME,
        args: { query: 'general' },
      }],
    },
    {
      toolCalls: [{
        id: 'parallel-grep-3',
        name: CAPABILITY_PLANNER_GREP_SEARCH_TOOL_NAME,
        args: { query: 'general' },
      }],
    },
    {
      structuredOutput: {
        kind: 'plan',
        args: {
          tasks: [{
            capability: 'general',
            task: 'Complete the requested workspace task using the discovered Capability.',
          }],
        },
      },
    },
  ]);

  const result = await createCapabilityPlannerAgent({ model }).invoke(
    plannerInput(workspace),
  );

  assert.deepEqual(result, {
    action: 'execute_plan',
    tasks: [{
      capability: 'general',
      task: 'Complete the requested workspace task using the discovered Capability.',
    }],
  });
  const grepToolCallIds = new Set(
    model.invocations.flat().flatMap((message) =>
      message instanceof ToolMessage
      && message.name === CAPABILITY_PLANNER_GREP_SEARCH_TOOL_NAME
      ? [message.tool_call_id]
      : [],
    ),
  );
  assert.deepEqual(grepToolCallIds, new Set([
    'parallel-grep-1',
    'parallel-grep-2',
    'parallel-grep-3',
  ]));
});

test('Planner returns to Answer after three grep_search calls without general', async (t) => {
  const workspace = await createWorkspace(t, {
    explore: capabilityDocument({
      name: 'explore',
      description: 'Investigate repository evidence.',
      instructions: 'Inspect available evidence and report findings.',
    }),
  });
  const model = new ScriptedPlannerModel([
    ...[1, 2, 3].map((attempt) => ({
      toolCalls: [{
        id: `grep-answer-${String(attempt)}`,
        name: CAPABILITY_PLANNER_GREP_SEARCH_TOOL_NAME,
        args: { query: 'explore' },
      }],
    })),
    {
      structuredOutput: {
        kind: 'unavailable',
        args: {
          reason: 'The available Capability evidence does not define an executable task.',
          context: 'The Planner completed its bounded Capability search and needs a user decision.',
        },
      },
    },
  ]);

  const result = await createCapabilityPlannerAgent({ model }).invoke(
    plannerInput(workspace),
  );

  assert.deepEqual(result, {
    action: 'unavailable',
    tasks: [],
  });
});

test('a submitted plan becomes private Planner state for the final reply', async (t) => {
  const workspace = await createWorkspace(t, {
    general: capabilityDocument({
      name: 'general',
      description: 'Handle ordinary tasks.',
      instructions: 'Complete the requested work.',
    }),
  });
  const submittedTasks = [{
    capability: 'general',
    task: 'Apply the requested repository change, verify it, and report the result.',
  }];
  const model = new ScriptedPlannerModel([{
    structuredOutput: {
      kind: 'plan',
      args: { tasks: submittedTasks },
    },
  }, {
    content: 'The plan has been submitted.',
  }]);

  const result = await createCapabilityPlannerAgent({ model }).invoke(
    plannerInput(workspace),
  );

  assert.deepEqual(result, { action: 'execute_plan', tasks: submittedTasks });
  assert.equal(model.invocations.length, 1);
});

test('Planner can return bounded facts to Answer without submitting a plan', async (t) => {
  const workspace = await createWorkspace(t, {
    explore: capabilityDocument({
      name: 'explore',
      description: 'Investigate repositories.',
      instructions: 'Inspect files and report evidence.',
    }),
  });
  const model = new ScriptedPlannerModel([{
    toolCalls: [{
      id: 'grep',
      name: CAPABILITY_PLANNER_GREP_SEARCH_TOOL_NAME,
      args: { query: 'unrelated task' },
    }],
  }, {
    structuredOutput: {
      kind: 'unavailable',
      args: {
        reason: 'No matching Capability is available in this scoped workspace.',
        context: 'The scoped workspace contains only the explore Capability.',
        question: 'Should I broaden the Capability scope?',
      },
    },
  }]);

  const result = await createCapabilityPlannerAgent({ model })
    .invoke(plannerInput(workspace));

  assert.deepEqual(result, {
    action: 'unavailable',
    tasks: [],
  });
  assert.ok(model.structuredOutputToolNames.has('unavailable'));
  assert.deepEqual(model.structuredOutputCapabilityEnums, []);
});

test('an unknown Capability returns tool feedback and can be repaired in-loop', async (t) => {
  const workspace = await createWorkspace(t, {
    general: capabilityDocument({
      name: 'general',
      description: 'Handle ordinary tasks.',
      instructions: 'Complete the requested work.',
    }),
  });
  const model = new ScriptedPlannerModel([
    {
      structuredOutput: {
        kind: 'plan',
        args: submitArgs('missing'),
      },
    },
    {
      structuredOutput: {
        kind: 'plan',
        args: {
          tasks: [{
            capability: 'general',
            task: 'Research the repository and prepare the review.',
          }],
        },
      },
    },
  ]);

  await assert.rejects(
    createCapabilityPlannerAgent({ model }).invoke(plannerInput(workspace)),
    /outside the immutable workspace/,
  );
});

test('Planner caps a parallel grep_search batch with standard middleware', async (t) => {
  const workspace = await createWorkspace(t, {
    general: capabilityDocument({
      name: 'general',
      description: 'Handle ordinary tasks.',
      instructions: 'Complete the requested work.',
    }),
  });
  const grep = (id: string) => ({
    id,
    name: CAPABILITY_PLANNER_GREP_SEARCH_TOOL_NAME,
    args: { query: 'ordinary' },
  });
  const model = new ScriptedPlannerModel([
    {
      toolCalls: [
        grep('grep-1'),
        grep('grep-2'),
        grep('grep-3'),
        grep('grep-4'),
      ],
    },
    {
      structuredOutput: {
        kind: 'plan',
        args: {
          tasks: [{
            capability: 'general',
            task: 'Complete the requested repository update.',
          }],
        },
      },
    },
  ]);

  const result = await createCapabilityPlannerAgent({ model }).invoke(
    plannerInput(workspace),
  );

  assert.deepEqual(result, {
    action: 'execute_plan',
    tasks: [{
      capability: 'general',
      task: 'Complete the requested repository update.',
    }],
  });
  const limitFeedback = model.invocations[1]?.find((message) =>
    message instanceof ToolMessage && message.tool_call_id === 'grep-4');
  assert.ok(limitFeedback instanceof ToolMessage);
  assert.equal(limitFeedback.status, 'error');
  assert.match(String(limitFeedback.content), /tool call limit exceeded/i);
  const successfulSearches = model.invocations[1]?.filter((message) =>
    message instanceof ToolMessage
    && message.name === CAPABILITY_PLANNER_GREP_SEARCH_TOOL_NAME
    && message.status !== 'error') ?? [];
  assert.equal(successfulSearches.length, 3);
});

test('an empty workspace can return truthful facts to Answer', async (t) => {
  const workspace = await createWorkspace(t, {});
  const model = new ScriptedPlannerModel([{
    structuredOutput: {
      kind: 'unavailable',
      args: {
        reason: 'The current workspace contains no Capability documents.',
        context: 'There are no registered Capability documents to execute browser automation.',
      },
    },
  }]);

  const result = await createCapabilityPlannerAgent({ model }).invoke(
    plannerInput(workspace),
  );

  assert.equal(model.structuredOutputToolNames.size, 2);
  assert.equal(model.structuredOutputToolNames.has('plan'), true);
  assert.ok(model.structuredOutputToolNames.has('unavailable'));
  assert.deepEqual(result, {
    action: 'unavailable',
    tasks: [],
  });
});

test('boundary mode rejects an empty executable plan', async (t) => {
  const workspace = await createWorkspace(t, {
    explore: capabilityDocument({
      name: 'explore',
      description: 'Investigate repositories.',
      instructions: 'Inspect repository evidence.',
    }),
    general: capabilityDocument({
      name: 'general',
      description: 'Handle ordinary tasks.',
      instructions: 'Complete the requested work.',
    }),
  });
  const model = new ScriptedPlannerModel([
    {
      structuredOutput: {
        kind: 'plan',
        args: {
          tasks: [],
        },
      },
    },
    {
      toolCalls: [{
        id: 'grep-general',
        name: CAPABILITY_PLANNER_GREP_SEARCH_TOOL_NAME,
        args: { query: 'ordinary|task' },
      }],
    },
    {
      structuredOutput: {
        kind: 'plan',
        args: {
          tasks: [{
            capability: 'general',
            task: 'Prepare the review from the completed research.',
          }],
        },
      },
    },
  ]);
  const fullHandoff = `Research completed. ${'Evidence detail. '.repeat(40)}Final constraint: preserve the public API.`;

  await assert.rejects(
    createCapabilityPlannerAgent({ model }).invoke(plannerInput(workspace, {
      mode: 'boundary',
      activeDelegation: {
        delegationId: 'delegation-1',
        capability: 'explore',
        task: 'Research the repository.',
      },
      latestAnnounce: {
        messageId: 'announce-1',
        text: fullHandoff,
        completionReason: 'natural',
      },
      remainingPlan: [{
        capability: 'general',
        task: 'Prepare the review from the findings.',
      }],
    })),
    /Array must contain at least 1 element/,
  );
});

test('a boundary with an exhausted plan can still submit newly required work', async (t) => {
  const workspace = await createWorkspace(t, {
    general: capabilityDocument({
      name: 'general',
      description: 'Handle ordinary tasks.',
      instructions: 'Complete the requested work.',
    }),
  });
  const model = new ScriptedPlannerModel([{
    structuredOutput: {
      kind: 'plan',
      args: {
        tasks: [{
          capability: 'general',
          task: 'Update the README section for issue #587.',
        }],
      },
    },
  }]);

  const result = await createCapabilityPlannerAgent({ model }).invoke(
    plannerInput(workspace, {
      mode: 'boundary',
      activeDelegation: {
        delegationId: 'delegation-1',
        capability: 'explore',
        task: 'Read the issue #587 status.',
      },
      latestAnnounce: {
        messageId: 'announce-1',
        text: 'issue #587 is open; the README section is stale.',
        completionReason: 'natural',
      },
      remainingPlan: [],
    }),
  );

  // An empty remaining plan is not by itself a terminal state: the latest
  // result may still require follow-up work.
  assert.deepEqual(result, {
    action: 'execute_plan',
    tasks: [{
      capability: 'general',
      task: 'Update the README section for issue #587.',
    }],
  });
});

test('oversized discovery is reported as planning_limit_reached', async (t) => {
  const workspace = await createWorkspace(t, {
    explore: capabilityDocument({
      name: 'explore',
      description: 'Investigate repositories.',
      instructions: 'Inspect files and report evidence.',
    }),
  });
  const model = new ScriptedPlannerModel([{
    toolCalls: [{
      id: 'grep',
      name: CAPABILITY_PLANNER_GREP_SEARCH_TOOL_NAME,
      args: { query: 'investigate' },
    }],
  }, { content: '' }]);

  await assert.rejects(
    createCapabilityPlannerAgent({
      model,
      maxDocumentReadBytes: 1,
    }).invoke(plannerInput(workspace)),
    (error: unknown) =>
      error instanceof CapabilityPlannerAgentError
      && error.code === 'planning_limit_reached',
  );
});

test('natural language completion cannot escape the commit protocol', async (t) => {
  const workspace = await createWorkspace(t, {});
  const model = new ScriptedPlannerModel([{
    content: 'The user needs to choose a target first.',
  }]);

  await assert.rejects(
    createCapabilityPlannerAgent({ model }).invoke(plannerInput(workspace)),
    (error: unknown) => error instanceof CapabilityPlannerAgentError
      && error.code === 'submission_required',
  );
  assert.equal(model.invocations.length, 1);
});

test('missing structured output and direct text is rejected', async (t) => {
  const workspace = await createWorkspace(t, {});
  const model = new ScriptedPlannerModel([{ content: '' }]);

  await assert.rejects(
    createCapabilityPlannerAgent({ model }).invoke(plannerInput(workspace, {
      userGoal: {
        objective: 'Current request.',
        context: null,
      },
    })),
    (error: unknown) =>
      error instanceof CapabilityPlannerAgentError
      && error.code === 'submission_required',
  );
  assert.equal(model.invocations.length, 1);
});

test('Planner Agent enforces a total timeout', async (t) => {
  const workspace = await createWorkspace(t, {});

  await assert.rejects(
    createCapabilityPlannerAgent({
      model: new SlowPlannerModel({}),
      timeoutMs: 10,
    }).invoke(plannerInput(workspace)),
    (error: unknown) =>
      error instanceof CapabilityPlannerAgentError
      && error.code === 'planning_timeout',
  );
});

test('Planner Agent rejects a structured result produced after timeout', async (t) => {
  const workspace = await createWorkspace(t, {});
  const model = new DelayedStructuredPlannerModel([{
    structuredOutput: {
      kind: 'unavailable',
      args: {
        reason: 'The workspace is empty.',
        context: 'No Capability documents are available.',
      },
    },
  }]);

  await assert.rejects(
    createCapabilityPlannerAgent({
      model,
      timeoutMs: 10,
    }).invoke(plannerInput(workspace)),
    (error: unknown) =>
      error instanceof CapabilityPlannerAgentError
      && error.code === 'planning_timeout',
  );
});
