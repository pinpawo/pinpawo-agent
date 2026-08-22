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
  END,
  MemorySaver,
  START,
  StateGraph,
} from '@langchain/langgraph';
import { z } from 'zod';
import {
  CAPABILITY_PLANNER_CAPABILITY_SEARCH_TOOL_NAME,
} from './fileExplorer';
import type { CapabilityDocumentWorkspace } from './documentWorkspace';
import {
  CapabilityPlannerAgentError,
  createCapabilityPlannerAgent,
} from './agent';
import type { CapabilityPlannerInput } from './runner';
import { isCapabilityPlannerMessage } from './messageContext';

function commitOnly(value: unknown) {
  const result = value as {
    action: unknown;
    tasks: unknown;
    userInputRequest?: unknown;
  };
  return {
    action: result.action,
    tasks: result.tasks,
    ...('userInputRequest' in result
      ? { userInputRequest: result.userInputRequest }
      : {}),
  };
}

type ScriptedToolCall = {
  id?: string;
  name: string;
  args: Record<string, unknown>;
};

type ScriptedStructuredOutput = {
  kind: 'plan' | 'advance' | 'unavailable';
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
  readonly boundToolNameHistory: string[][] = [];
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
    this.boundToolNameHistory.push([...this.boundToolNames]);
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
        : name === 'advance_plan' ? 'advance'
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
    userRequest: 'Research the repository and then prepare a review.',
    messages: [],
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

test('Planner lane persists one trace in root messages and deduplicates boundary inputs', async (t) => {
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
  const config = { configurable: { thread_id: 'planner-lane-root' } };
  const entryA = plannerInput(workspace, {
    inputId: 'trace_started:trace-a',
    traceId: 'trace-a',
    runId: 'run-a1',
    userRequest: 'PRIVATE_TRACE_A_GOAL',
    messages: [
      new HumanMessage('PRIOR_MAIN_CONVERSATION'),
      new HumanMessage('PRIVATE_TRACE_A_GOAL'),
    ],
  });
  const boundaryA = plannerInput(workspace, {
    mode: 'boundary',
    inputId: 'announce:delegation-a:1',
    traceId: 'trace-a',
    runId: 'run-a2',
    userRequest: entryA.userRequest,
    activeDelegation: {
      delegationId: 'delegation-a',
      transcriptRunId: 'transcript-a',
      capability: 'general',
      task: 'Complete trace A.',
    },
    latestAnnounce: {
      messageId: 'announce-a',
      completionReason: 'natural',
    },
    messages: [new AIMessage('Trace A execution is complete.')],
  });

  const entryState = await graph.invoke({ input: entryA }, config);
  assert.deepEqual(commitOnly(entryState.commit), {
    action: 'execute_plan',
    tasks: [{ capability: 'general', task: 'Complete trace A.' }],
  });
  assert.match(model.invocations[0]?.map(readMessageText).join('\n') ?? '', /PRIOR_MAIN_CONVERSATION/);
  const entryMessageUpdates = (
    entryState.commit as { messageUpdates?: BaseMessage[] }
  ).messageUpdates ?? [];
  const boundaryInput = {
    ...boundaryA,
    messages: [...entryA.messages, ...entryMessageUpdates, ...boundaryA.messages],
  };
  const boundaryState = await graph.invoke({ input: boundaryInput }, config);
  assert.deepEqual(commitOnly(boundaryState.commit), { action: 'goal_done', tasks: [] });
  assert.equal(model.invocations.length, 2);
  assert.match(
    model.invocations[1]?.map(readMessageText).join('\n') ?? '',
    /PRIVATE_TRACE_A_GOAL/,
  );
  assert.match(
    model.invocations[1]?.map(readMessageText).join('\n') ?? '',
    /Trace A execution is complete/,
  );
  const boundaryMessageUpdates = (
    boundaryState.commit as { messageUpdates?: BaseMessage[] }
  ).messageUpdates ?? [];
  const completedBoundaryInput = {
    ...boundaryInput,
    messages: [...boundaryInput.messages, ...boundaryMessageUpdates],
  };

  const duplicateState = await graph.invoke({ input: completedBoundaryInput }, config);
  assert.deepEqual(commitOnly(duplicateState.commit), { action: 'goal_done', tasks: [] });
  assert.equal(model.invocations.length, 2, 'duplicate inputId must use the Planner-lane cached commit');

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
  const restartedState = await restartedGraph.invoke({ input: completedBoundaryInput }, config);
  assert.deepEqual(commitOnly(restartedState.commit), { action: 'goal_done', tasks: [] });
  assert.equal(restartedModel.invocations.length, 0, 'a rebuilt Planner must replay the persisted commit');

  const changedRegistryState = await graph.invoke({
    input: { ...completedBoundaryInput, workspace: changedWorkspace },
  }, config);
  assert.deepEqual(commitOnly(changedRegistryState.commit), { action: 'unavailable', tasks: [] });
  assert.equal(model.invocations.length, 3, 'registry changes must invalidate a cached commit');

  const entryB = plannerInput(workspace, {
    inputId: 'trace_started:trace-b',
    traceId: 'trace-b',
    runId: 'run-b1',
    userRequest: 'PRIVATE_TRACE_B_GOAL',
  });
  const traceBState = await graph.invoke({ input: entryB }, config);
  assert.deepEqual(commitOnly(traceBState.commit), { action: 'unavailable', tasks: [] });
  assert.equal(model.invocations.length, 4);
  const traceBMessages = model.invocations[3]?.map(readMessageText).join('\n') ?? '';
  assert.match(traceBMessages, /PRIVATE_TRACE_B_GOAL/);
  assert.doesNotMatch(traceBMessages, /PRIVATE_TRACE_A_GOAL/);
  const traceBUpdates = (
    traceBState.commit as { messageUpdates?: BaseMessage[] }
  ).messageUpdates ?? [];
  assert.ok(traceBUpdates.some((message) =>
    isCapabilityPlannerMessage(message, 'trace-b')));

});

test('Planner supports additional invocation-scoped tools without child persistence', async (t) => {
  const workspace = await createWorkspace(t, {
    general: capabilityDocument({
      name: 'general',
      description: 'Handle ordinary workspace tasks.',
      instructions: 'Complete the requested work.',
    }),
  });
  const inspectPlanner = tool(async () => 'approved', {
    name: 'inspect_planner',
    description: 'Return an invocation-scoped observation.',
    schema: z.object({}).strict(),
  });
  const model = new ScriptedPlannerModel([{
    toolCalls: [{ id: 'inspect', name: 'inspect_planner', args: {} }],
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
    additionalTools: [inspectPlanner],
  });
  const input = plannerInput(workspace, {
    inputId: 'trace_started:trace-interrupt',
    traceId: 'trace-interrupt',
    runId: 'run-interrupt',
    userRequest: 'Continue after an invocation-scoped check.',
  });

  const result = await planner.invoke(input);
  assert.deepEqual(commitOnly(result), {
    action: 'execute_plan',
    tasks: [{ capability: 'general', task: 'Continue after approval.' }],
  });
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
        name: CAPABILITY_PLANNER_CAPABILITY_SEARCH_TOOL_NAME,
        args: { terms: ['research'] },
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

  assert.deepEqual(model.boundToolNameHistory[0]?.slice(0, 1), [
    CAPABILITY_PLANNER_CAPABILITY_SEARCH_TOOL_NAME,
  ]);
  assert.equal(model.boundToolNameHistory[0]?.includes('request_user_input'), true);
  assert.equal(model.boundToolNameHistory[1]?.includes(
    CAPABILITY_PLANNER_CAPABILITY_SEARCH_TOOL_NAME,
  ), true);
  assert.equal(model.boundToolNameHistory[1]?.includes('request_user_input'), true);
  assert.equal(model.structuredOutputToolNames.size, 3);
  assert.ok(model.structuredOutputToolNames.has('plan'));
  assert.ok(model.structuredOutputToolNames.has('advance'));
  assert.ok(model.structuredOutputToolNames.has('unavailable'));
  assert.deepEqual(model.structuredOutputSchemaReferences, []);
  assert.deepEqual(model.structuredOutputPlanLimits, [24]);
  assert.deepEqual(model.structuredOutputCapabilityEnums, []);
  assert.equal(model.boundToolOptions[0]?.tool_choice, undefined);
  assert.equal(model.boundToolOptions[1]?.tool_choice, undefined);
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
  const searchResult = model.invocations[1]?.find((message) =>
    ToolMessage.isInstance(message)
    && message.name === CAPABILITY_PLANNER_CAPABILITY_SEARCH_TOOL_NAME);
  assert.ok(ToolMessage.isInstance(searchResult));
  const searchPayload = JSON.parse(String(searchResult.content)) as {
    exploration?: {
      specificCandidates?: string[];
      defaultCandidateRole?: string;
    };
  };
  assert.deepEqual(searchPayload.exploration?.specificCandidates, ['explore']);
  assert.equal(searchPayload.exploration?.defaultCandidateRole, 'fallback_only');
  assert.deepEqual(commitOnly(result), {
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
        name: CAPABILITY_PLANNER_CAPABILITY_SEARCH_TOOL_NAME,
        args: { terms: ['investigate', 'repository'] },
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
  assert.equal(model.structuredOutputToolNames.size, 3);
  assert.ok(model.structuredOutputToolNames.has('plan'));
  assert.ok(model.structuredOutputToolNames.has('advance'));
  assert.ok(model.structuredOutputToolNames.has('unavailable'));
  assert.ok('tasks' in result);
  assert.equal(
    'tasks' in result ? result.tasks[0]?.task : null,
    'Inspect issue #473 and report the Planner Agent constraints.',
  );
  assert.equal('tasks' in result ? result.tasks.length : 0, 1);
});

test('Planner accepts a detailed task beyond the legacy 500-character limit', async (t) => {
  const workspace = await createWorkspace(t, {
    general: capabilityDocument({
      name: 'general',
      description: 'Handle ordinary tasks.',
      instructions: 'Complete the requested work.',
    }),
  });
  const detailedTask = 'x'.repeat(501);
  const model = new ScriptedPlannerModel([{
    structuredOutput: {
      kind: 'plan',
      args: {
        tasks: [{
          capability: 'general',
          task: detailedTask,
        }],
      },
    },
  }]);

  const result = await createCapabilityPlannerAgent({ model })
    .invoke(plannerInput(workspace));

  assert.deepEqual(commitOnly(result), {
    action: 'execute_plan',
    tasks: [{
      capability: 'general',
      task: detailedTask,
    }],
  });
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

test('Planner closes discovery after two capability_search rounds', async (t) => {
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
        id: 'grep-1',
        name: CAPABILITY_PLANNER_CAPABILITY_SEARCH_TOOL_NAME,
        args: { terms: ['general'] },
      }],
    },
    {
      toolCalls: [{
        id: 'grep-2',
        name: CAPABILITY_PLANNER_CAPABILITY_SEARCH_TOOL_NAME,
        args: { terms: ['workspace'] },
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

  assert.deepEqual(commitOnly(result), {
    action: 'execute_plan',
    tasks: [{
      capability: 'general',
      task: 'Complete the requested workspace task using the discovered Capability.',
    }],
  });
  const searchResults = [...new Map(
    model.invocations.flat().filter(
      (message): message is ToolMessage => message instanceof ToolMessage
        && message.name === CAPABILITY_PLANNER_CAPABILITY_SEARCH_TOOL_NAME,
    ).map((message) => [message.tool_call_id, message]),
  ).values()];
  assert.equal(searchResults.length, 2);
  assert.equal(searchResults.some((message) => message.status === 'error'), false);
  assert.match(String(searchResults[0]?.content), /"status":"open"/);
  assert.match(String(searchResults[0]?.content), /"roundsUsed":1/);
  assert.match(String(searchResults[0]?.content), /"remainingRounds":1/);
  assert.match(String(searchResults[1]?.content), /"status":"closed"/);
  assert.match(String(searchResults[1]?.content), /"roundsUsed":2/);
  assert.match(String(searchResults[1]?.content), /"remainingRounds":0/);
  assert.match(String(searchResults[0]?.content), /"defaultCandidate":"general"/);
  assert.match(String(searchResults[0]?.content), /"specificCandidates":\[\]/);
  assert.match(String(searchResults[0]?.content), /"defaultCandidateRole":"eligible_default"/);
  assert.equal(model.boundToolNameHistory[1]?.includes(
    CAPABILITY_PLANNER_CAPABILITY_SEARCH_TOOL_NAME,
  ), true);
  assert.equal(model.boundToolNameHistory[2]?.includes(
    CAPABILITY_PLANNER_CAPABILITY_SEARCH_TOOL_NAME,
  ), false);
  assert.equal(model.boundToolOptions[1]?.tool_choice, undefined);
  assert.equal(model.boundToolOptions[2]?.tool_choice, 'required');
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
      userRequest: '查看并整理 /Users/mac/Downloads 目录。\n\n用户明确允许使用通用工具。',
    }),
  );

  assert.deepEqual(commitOnly(result), {
    action: 'execute_plan',
    tasks: [{
      capability: 'general',
      task: 'Inspect and organize the requested Downloads directory.',
    }],
  });
  // The default Capability is a workspace property, so it rides the system
  // message rather than the per-turn request block.
  const systemMessage = model.invocations[0]?.[0];
  assert.ok(systemMessage);
  assert.equal(systemMessage._getType(), 'system');
  assert.match(readMessageText(systemMessage), /<default_capability role=/);
  assert.match(readMessageText(systemMessage), /general\/CAPABILITY\.md/);
  assert.match(readMessageText(systemMessage), /通用工具读取和修改工作区/);
  const plannerInputMessage = model.invocations[0]?.find(
    (message) => message instanceof HumanMessage,
  );
  assert.ok(plannerInputMessage instanceof HumanMessage);
  assert.doesNotMatch(readMessageText(plannerInputMessage), /<default_capability role=/);
  assert.equal(model.invocations.flat().some(
    (message) => message instanceof ToolMessage
      && message.name === CAPABILITY_PLANNER_CAPABILITY_SEARCH_TOOL_NAME,
  ), false);
});

test('a first-round miss discloses exact specific names before General becomes eligible', async (t) => {
  const workspace = await createWorkspace(t, {
    explore: capabilityDocument({
      name: 'explore',
      description: 'Inspect code structure and risks.',
      instructions: 'Investigate the repository and report evidence.',
    }),
    general: capabilityDocument({
      name: 'general',
      description: 'Handle ordinary workspace tasks.',
      instructions: 'Complete the requested work.',
    }),
  });
  const search = (id: string, terms: string[]) => ({
    id,
    name: CAPABILITY_PLANNER_CAPABILITY_SEARCH_TOOL_NAME,
    args: { terms },
  });
  const model = new ScriptedPlannerModel([
    { toolCalls: [search('search-miss', ['auth'])] },
    { toolCalls: [search('search-exact', ['explore'])] },
    {
      structuredOutput: {
        kind: 'plan',
        args: {
          tasks: [{
            capability: 'explore',
            task: 'Inspect the auth module structure and risks.',
          }],
        },
      },
    },
  ]);

  const result = await createCapabilityPlannerAgent({ model }).invoke(
    plannerInput(workspace),
  );

  assert.deepEqual(commitOnly(result), {
    action: 'execute_plan',
    tasks: [{
      capability: 'explore',
      task: 'Inspect the auth module structure and risks.',
    }],
  });
  const searchResults = [...new Map(
    model.invocations.flat().filter(
      (message): message is ToolMessage => ToolMessage.isInstance(message)
        && message.name === CAPABILITY_PLANNER_CAPABILITY_SEARCH_TOOL_NAME,
    ).map((message) => [message.tool_call_id, JSON.parse(String(message.content)) as {
      exploration?: {
        specificCandidates?: string[];
        nextSearchCandidates?: string[];
        defaultCandidateRole?: string;
      };
    }]),
  ).values()];
  assert.deepEqual(searchResults[0]?.exploration?.specificCandidates, []);
  assert.deepEqual(searchResults[0]?.exploration?.nextSearchCandidates, ['explore']);
  assert.equal(
    searchResults[0]?.exploration?.defaultCandidateRole,
    'deferred_while_specific_candidates_remain_unchecked',
  );
  assert.deepEqual(searchResults[1]?.exploration?.specificCandidates, ['explore']);
  assert.equal(searchResults[1]?.exploration?.defaultCandidateRole, 'fallback_only');
});

test('a boundary literal match still requires positive unfinished-work scope', async (t) => {
  const workspace = await createWorkspace(t, {
    explore: capabilityDocument({
      name: 'explore',
      description: 'Inspect release readiness without publishing packages.',
      instructions: 'Report readiness evidence; do not publish packages.',
    }),
  });
  const model = new ScriptedPlannerModel([{
    toolCalls: [{
      id: 'boundary-search-miss',
      name: CAPABILITY_PLANNER_CAPABILITY_SEARCH_TOOL_NAME,
      args: { terms: ['publish'] },
    }],
  }, {
    structuredOutput: {
      kind: 'unavailable',
      args: {},
    },
  }]);

  const result = await createCapabilityPlannerAgent({ model }).invoke(
    plannerInput(workspace, {
      mode: 'boundary',
      activeDelegation: {
        delegationId: 'delegation-1',
        transcriptRunId: 'transcript-1',
        capability: 'explore',
        task: 'Inspect package release readiness.',
      },
      remainingPlan: [],
    }),
  );

  assert.deepEqual(commitOnly(result), { action: 'unavailable', tasks: [] });
  const searchResult = model.invocations[1]?.find((message) =>
    ToolMessage.isInstance(message)
    && message.name === CAPABILITY_PLANNER_CAPABILITY_SEARCH_TOOL_NAME);
  assert.ok(ToolMessage.isInstance(searchResult));
  const payload = JSON.parse(String(searchResult.content)) as {
    exploration?: {
      specificCandidates?: string[];
      nextSearchCandidates?: string[];
      specificCandidateStatus?: string;
      planUpdateRule?: string | null;
    };
  };
  assert.deepEqual(payload.exploration?.specificCandidates, ['explore']);
  assert.deepEqual(payload.exploration?.nextSearchCandidates, []);
  assert.equal(
    payload.exploration?.specificCandidateStatus,
    'literal_match_requires_positive_scope_check',
  );
  assert.match(
    payload.exploration?.planUpdateRule ?? '',
    /copying every prior remaining-plan task verbatim/,
  );
});

test('a boundary miss discloses non-active specific names for newly revealed work', async (t) => {
  const workspace = await createWorkspace(t, {
    explore: capabilityDocument({
      name: 'explore',
      description: 'Investigate repositories and report evidence.',
      instructions: 'Inspect the repository without editing documents.',
    }),
    document_writer: capabilityDocument({
      name: 'document_writer',
      description: 'Create and update project documents.',
      instructions: 'Apply evidence-backed documentation changes.',
    }),
    general: capabilityDocument({
      name: 'general',
      description: 'Handle ordinary workspace tasks.',
      instructions: 'Complete the requested work.',
    }),
  });
  const search = (id: string, terms: string[]) => ({
    id,
    name: CAPABILITY_PLANNER_CAPABILITY_SEARCH_TOOL_NAME,
    args: { terms },
  });
  const model = new ScriptedPlannerModel([
    { toolCalls: [search('boundary-miss', ['issue status'])] },
    { toolCalls: [search('boundary-exact', ['document_writer'])] },
    {
      structuredOutput: {
        kind: 'advance',
        args: {
          tasks: [{
            capability: 'document_writer',
            task: 'Update the README with the accepted issue status.',
          }],
        },
      },
    },
  ]);

  const result = await createCapabilityPlannerAgent({ model }).invoke(
    plannerInput(workspace, {
      mode: 'boundary',
      activeDelegation: {
        delegationId: 'delegation-1',
        transcriptRunId: 'transcript-1',
        capability: 'explore',
        task: 'Read the current issue status.',
      },
      remainingPlan: [],
    }),
  );

  assert.deepEqual(commitOnly(result), {
    action: 'advance_plan',
    tasks: [{
      capability: 'document_writer',
      task: 'Update the README with the accepted issue status.',
    }],
  });
  const firstSearchResult = model.invocations[1]?.find((message) =>
    ToolMessage.isInstance(message)
    && message.tool_call_id === 'boundary-miss');
  assert.ok(ToolMessage.isInstance(firstSearchResult));
  const payload = JSON.parse(String(firstSearchResult.content)) as {
    exploration?: { nextSearchCandidates?: string[] };
  };
  assert.deepEqual(payload.exploration?.nextSearchCandidates, ['document_writer']);
});

test('Planner counts parallel capability_search calls as one disclosure round', async (t) => {
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
        name: CAPABILITY_PLANNER_CAPABILITY_SEARCH_TOOL_NAME,
        args: { terms: ['general'] },
      }, {
        id: 'parallel-grep-2',
        name: CAPABILITY_PLANNER_CAPABILITY_SEARCH_TOOL_NAME,
        args: { terms: ['general'] },
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

  assert.deepEqual(commitOnly(result), {
    action: 'execute_plan',
    tasks: [{
      capability: 'general',
      task: 'Complete the requested workspace task using the discovered Capability.',
    }],
  });
  const searchToolCallIds = new Set(
    model.invocations.flat().flatMap((message) =>
      message instanceof ToolMessage
      && message.name === CAPABILITY_PLANNER_CAPABILITY_SEARCH_TOOL_NAME
      ? [message.tool_call_id]
      : [],
    ),
  );
  assert.deepEqual(searchToolCallIds, new Set([
    'parallel-grep-1',
    'parallel-grep-2',
  ]));
  const searchResults = model.invocations[1]?.filter((message) =>
    message instanceof ToolMessage
    && message.name === CAPABILITY_PLANNER_CAPABILITY_SEARCH_TOOL_NAME) ?? [];
  assert.equal(searchResults.length, 2);
  assert.ok(searchResults.every((message) =>
    String(message.content).includes('"status":"open"')));
  assert.ok(searchResults.every((message) =>
    String(message.content).includes('"roundsUsed":1')));
  assert.equal(model.boundToolNameHistory[1]?.includes(
    CAPABILITY_PLANNER_CAPABILITY_SEARCH_TOOL_NAME,
  ), true);
  assert.equal(model.boundToolOptions[1]?.tool_choice, undefined);
});

test('Planner returns to Answer after one capability_search without general', async (t) => {
  const workspace = await createWorkspace(t, {
    explore: capabilityDocument({
      name: 'explore',
      description: 'Investigate repository evidence.',
      instructions: 'Inspect available evidence and report findings.',
    }),
  });
  const model = new ScriptedPlannerModel([
    {
      toolCalls: [{
        id: 'grep-answer-1',
        name: CAPABILITY_PLANNER_CAPABILITY_SEARCH_TOOL_NAME,
        args: { terms: ['explore'] },
      }],
    },
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

  assert.deepEqual(commitOnly(result), {
    action: 'unavailable',
    tasks: [],
  });
});

test('Planner does not retry ordinary text after the second search round closes', async (t) => {
  const workspace = await createWorkspace(t, {
    general: capabilityDocument({
      name: 'general',
      description: 'Handle ordinary workspace tasks.',
      instructions: 'Complete the requested work.',
    }),
  });
  const model = new ScriptedPlannerModel([{
    toolCalls: [{
      id: 'search-telecom-1',
      name: CAPABILITY_PLANNER_CAPABILITY_SEARCH_TOOL_NAME,
      args: { terms: ['telecom license', '增值电信', '审查'] },
    }],
  }, {
    toolCalls: [{
      id: 'search-telecom-2',
      name: CAPABILITY_PLANNER_CAPABILITY_SEARCH_TOOL_NAME,
      args: { terms: ['license review'] },
    }],
  }, {
    content: 'The general Capability can handle this request.',
  }]);

  const result = await createCapabilityPlannerAgent({ model }).invoke(
    plannerInput(workspace),
  );

  assert.ok('plannerStatus' in result);
  if (!('plannerStatus' in result)) assert.fail('expected an incomplete Planner result');
  assert.equal(result.plannerStatus, 'incomplete');
  assert.equal(model.invocations.length, 3);
  assert.match(readMessageText(model.invocations[2]?.[0] as BaseMessage), /status="closed"/);
  assert.equal(model.boundToolNameHistory[2]?.includes(
    CAPABILITY_PLANNER_CAPABILITY_SEARCH_TOOL_NAME,
  ), false);
  assert.equal(model.boundToolOptions[2]?.tool_choice, 'required');
});

test('a submitted plan commits once without a final ordinary-text reply', async (t) => {
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

  assert.deepEqual(commitOnly(result), { action: 'execute_plan', tasks: submittedTasks });
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
      name: CAPABILITY_PLANNER_CAPABILITY_SEARCH_TOOL_NAME,
      args: { terms: ['unrelated task'] },
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

  assert.deepEqual(commitOnly(result), {
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

  const result = await createCapabilityPlannerAgent({ model }).invoke(
    plannerInput(workspace),
  );

  assert.deepEqual(commitOnly(result), {
    action: 'execute_plan',
    tasks: [{
      capability: 'general',
      task: 'Research the repository and prepare the review.',
    }],
  });
  assert.equal(model.invocations.length, 2);
  assert.ok(model.invocations[1]?.some((message) =>
    ToolMessage.isInstance(message)
    && message.status === 'error'
    && readMessageText(message).includes('outside the immutable workspace')));
});

test('Planner allows every search in one parallel disclosure round', async (t) => {
  const workspace = await createWorkspace(t, {
    general: capabilityDocument({
      name: 'general',
      description: 'Handle ordinary tasks.',
      instructions: 'Complete the requested work.',
    }),
  });
  const search = (id: string) => ({
    id,
    name: CAPABILITY_PLANNER_CAPABILITY_SEARCH_TOOL_NAME,
    args: { terms: ['ordinary'] },
  });
  const model = new ScriptedPlannerModel([
    {
      toolCalls: [
        search('grep-1'),
        search('grep-2'),
        search('grep-3'),
        search('grep-4'),
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

  assert.deepEqual(commitOnly(result), {
    action: 'execute_plan',
    tasks: [{
      capability: 'general',
      task: 'Complete the requested repository update.',
    }],
  });
  const successfulSearches = model.invocations[1]?.filter((message) =>
    message instanceof ToolMessage
    && message.name === CAPABILITY_PLANNER_CAPABILITY_SEARCH_TOOL_NAME
    && message.status !== 'error') ?? [];
  assert.equal(successfulSearches.length, 4);
  assert.ok(successfulSearches.every((message) =>
    String(message.content).includes('"status":"open"')));
  assert.ok(successfulSearches.every((message) =>
    String(message.content).includes('"roundsUsed":1')));
  assert.equal(model.boundToolNameHistory[1]?.includes(
    CAPABILITY_PLANNER_CAPABILITY_SEARCH_TOOL_NAME,
  ), true);
  assert.equal(model.boundToolOptions[1]?.tool_choice, undefined);
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

  assert.equal(model.structuredOutputToolNames.size, 3);
  assert.equal(model.structuredOutputToolNames.has('plan'), true);
  assert.equal(model.structuredOutputToolNames.has('advance'), true);
  assert.ok(model.structuredOutputToolNames.has('unavailable'));
  assert.deepEqual(commitOnly(result), {
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
        kind: 'advance',
        args: {
          tasks: [],
        },
      },
    },
    {
      toolCalls: [{
        id: 'grep-general',
        name: CAPABILITY_PLANNER_CAPABILITY_SEARCH_TOOL_NAME,
        args: { terms: ['ordinary', 'task'] },
      }],
    },
    {
      structuredOutput: {
        kind: 'advance',
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
        transcriptRunId: 'transcript-1',
        capability: 'explore',
        task: 'Research the repository.',
      },
      latestAnnounce: {
        messageId: 'announce-1',
        completionReason: 'natural',
      },
      messages: [new AIMessage(fullHandoff)],
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
      kind: 'advance',
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
        transcriptRunId: 'transcript-1',
        capability: 'explore',
        task: 'Read the issue #587 status.',
      },
      latestAnnounce: {
        messageId: 'announce-1',
        completionReason: 'natural',
      },
      messages: [new AIMessage('issue #587 is open; the README section is stale.')],
      remainingPlan: [],
    }),
  );

  // An empty remaining plan is not by itself a terminal state: the latest
  // result may still require follow-up work.
  assert.deepEqual(commitOnly(result), {
    action: 'advance_plan',
    tasks: [{
      capability: 'general',
      task: 'Update the README section for issue #587.',
    }],
  });
});

test('boundary Planner continues without replacing the active task', async (t) => {
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
  const model = new ScriptedPlannerModel([{
    toolCalls: [{
      id: 'continue-current',
      name: 'continue_current',
      args: {},
    }],
  }]);

  const result = await createCapabilityPlannerAgent({ model }).invoke(
    plannerInput(workspace, {
      mode: 'boundary',
      activeDelegation: {
        delegationId: 'delegation-1',
        transcriptRunId: 'transcript-1',
        capability: 'explore',
        task: 'Inspect the repository.',
      },
      latestAnnounce: {
        messageId: 'announce-1',
        completionReason: 'natural',
      },
      messages: [new AIMessage('The dependency evidence is still incomplete.')],
    }),
  );

  assert.deepEqual(commitOnly(result), {
    action: 'continue_current',
    tasks: [],
  });
  assert.equal(model.invocations.length, 1);
});

test('entry Planner can request a user-owned choice with a structured question', async (t) => {
  const workspace = await createWorkspace(t, {
    general: capabilityDocument({
      name: 'general',
      description: 'Handle ordinary tasks.',
      instructions: 'Complete and verify the requested work.',
    }),
  });
  const model = new ScriptedPlannerModel([{
    toolCalls: [{
      id: 'request-environment',
      name: 'request_user_input',
      args: { question: 'Should I deploy to production or staging?' },
    }],
  }]);

  const result = await createCapabilityPlannerAgent({ model }).invoke(
    plannerInput(workspace, {
      userRequest: 'Deploy the service to production or staging; I will choose the target.',
    }),
  );

  assert.deepEqual(commitOnly(result), {
    action: 'user_input_required',
    tasks: [],
    userInputRequest: { question: 'Should I deploy to production or staging?' },
  });
  assert.equal(model.invocations.length, 1);
});

test('boundary Planner can stop for user confirmation with a structured question', async (t) => {
  const workspace = await createWorkspace(t, {
    general: capabilityDocument({
      name: 'general',
      description: 'Handle ordinary tasks.',
      instructions: 'Complete and verify the requested work.',
    }),
  });
  const model = new ScriptedPlannerModel([{
    toolCalls: [{
      id: 'request-target-confirmation',
      name: 'request_user_input',
      args: { question: 'Should I review PR #663 instead?' },
    }],
  }]);

  const result = await createCapabilityPlannerAgent({ model }).invoke(
    plannerInput(workspace, {
      mode: 'boundary',
      activeDelegation: {
        delegationId: 'delegation-review-662',
        transcriptRunId: 'transcript-review-662',
        capability: 'general',
        task: 'Review PR #662.',
      },
      latestAnnounce: {
        messageId: 'announce-review-662',
        completionReason: 'natural',
      },
      messages: [new AIMessage(
        'PR #662 does not exist. PR #663 may be related but is not the requested target.',
      )],
    }),
  );

  assert.deepEqual(commitOnly(result), {
    action: 'user_input_required',
    tasks: [],
    userInputRequest: { question: 'Should I review PR #663 instead?' },
  });
  assert.equal(model.invocations.length, 1);
});

test('boundary Planner repairs submit_plan to advance_plan', async (t) => {
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
  const tasks = [{
    capability: 'general',
    task: 'Implement the change supported by the accepted investigation.',
  }];
  const model = new ScriptedPlannerModel([{
    structuredOutput: {
      kind: 'plan',
      args: { tasks },
    },
  }, {
    structuredOutput: {
      kind: 'advance',
      args: { tasks },
    },
  }]);

  const result = await createCapabilityPlannerAgent({ model }).invoke(
    plannerInput(workspace, {
      mode: 'boundary',
      activeDelegation: {
        delegationId: 'delegation-1',
        transcriptRunId: 'transcript-1',
        capability: 'explore',
        task: 'Inspect the repository.',
      },
      latestAnnounce: {
        messageId: 'announce-1',
        completionReason: 'natural',
      },
      messages: [new AIMessage(
        'The investigation is complete and identifies the required change.',
      )],
    }),
  );

  assert.deepEqual(commitOnly(result), { action: 'advance_plan', tasks });
  assert.equal(model.invocations.length, 2);
  assert.ok(model.invocations[1]?.some((message) =>
    ToolMessage.isInstance(message)
    && message.status === 'error'
    && readMessageText(message).includes('invalid at a boundary')));
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
      name: CAPABILITY_PLANNER_CAPABILITY_SEARCH_TOOL_NAME,
      args: { terms: ['investigate'] },
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

test('Planner reports an incomplete result when it exits without a commit', async (t) => {
  const workspace = await createWorkspace(t, {});
  const model = new ScriptedPlannerModel([{
    content: 'The user needs to choose a target first.',
  }]);

  const result = await createCapabilityPlannerAgent({ model }).invoke(plannerInput(workspace));
  assert.ok('plannerStatus' in result);
  if (!('plannerStatus' in result)) assert.fail('expected an incomplete Planner result');
  assert.equal(result.plannerStatus, 'incomplete');
  assert.equal(result.reason, 'terminal_commit_missing');
  assert.equal(model.invocations.length, 1);
  assert.equal(result.messageUpdates?.some((message) =>
    ToolMessage.isInstance(message)
    && message.name === 'report_unavailable'), false);
});

test('Planner does not invent General when closed exploration ends without a commit', async (t) => {
  const workspace = await createWorkspace(t, {
    general: capabilityDocument({
      name: 'general',
      description: 'Handle ordinary workspace tasks.',
      instructions: 'Complete the requested work.',
    }),
  });
  const search = (id: string) => ({
    id,
    name: CAPABILITY_PLANNER_CAPABILITY_SEARCH_TOOL_NAME,
    args: { terms: ['ordinary'] },
  });
  const model = new ScriptedPlannerModel([
    { toolCalls: [search('search-1')] },
    { toolCalls: [search('search-2')] },
    { content: 'I have finished looking for capabilities.' },
  ]);

  const result = await createCapabilityPlannerAgent({ model }).invoke(plannerInput(workspace, {
    userRequest: 'Current request.',
  }));

  assert.ok('plannerStatus' in result);
  if (!('plannerStatus' in result)) assert.fail('expected an incomplete Planner result');
  assert.equal(result.plannerStatus, 'incomplete');
  assert.equal(result.reason, 'terminal_commit_missing');
  assert.equal(model.invocations.length, 3);
  assert.equal(model.boundToolNameHistory[2]?.includes(
    CAPABILITY_PLANNER_CAPABILITY_SEARCH_TOOL_NAME,
  ), false);
  assert.equal(model.boundToolOptions[2]?.tool_choice, 'required');
  assert.equal(result.messageUpdates?.some((message) =>
    ToolMessage.isInstance(message)
    && message.name === 'submit_plan'
    && String(message.content).includes('execute_plan')), false);
});

test('boundary Planner reports incomplete without accepting its delegation', async (t) => {
  const workspace = await createWorkspace(t, {
    general: capabilityDocument({
      name: 'general',
      description: 'Handle ordinary workspace tasks.',
      instructions: 'Complete the requested work.',
    }),
  });
  const model = new ScriptedPlannerModel([
    { content: 'The current task should be handed over.' },
    { content: 'Still no terminal tool call.' },
  ]);

  const result = await createCapabilityPlannerAgent({ model }).invoke(plannerInput(workspace, {
    mode: 'boundary',
    userRequest: 'Finish the remaining request.',
    activeDelegation: {
      delegationId: 'delegation-1',
      transcriptRunId: 'transcript-1',
      capability: 'explore',
      task: 'Inspect the repository.',
    },
  }));

  assert.ok('plannerStatus' in result);
  if (!('plannerStatus' in result)) assert.fail('expected an incomplete Planner result');
  assert.equal(result.plannerStatus, 'incomplete');
  assert.equal(result.reason, 'terminal_commit_missing');
  assert.equal(result.messageUpdates?.some((message) =>
    ToolMessage.isInstance(message) && message.name === 'advance_plan'), false);
});

test('Planner Agent validates maxSearchRounds', () => {
  assert.throws(
    () => createCapabilityPlannerAgent({
      model: new ScriptedPlannerModel([]),
      maxSearchRounds: 0,
    }),
    /maxSearchRounds must be a positive integer/,
  );
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
