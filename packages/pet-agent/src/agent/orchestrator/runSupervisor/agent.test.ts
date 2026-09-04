import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
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
  RUN_SUPERVISOR_CAPABILITY_SEARCH_TOOL_NAME,
} from './fileExplorer';
import type { CapabilityDocumentWorkspace } from './documentWorkspace';
import {
  RunSupervisorAgentError,
  createRunSupervisorAgent,
} from './agent';
import type { RunSupervisorInput } from './runner';
import { createCapabilityDisclosureState } from './capabilityDisclosure';
import { createRunSupervisorSession } from './session';
import { CAPABILITY_ROUTING_MANIFEST_COMMIT_TOOL_NAME } from './routingManifest';
import {
  setAgentMessageDelegationScope,
  setAgentMessageMetadata,
} from '../../messages';

function commandOnly(value: unknown) {
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

class ScriptedSupervisorModel extends BaseChatModel {
  readonly invocations: BaseMessage[][] = [];
  readonly boundToolNames: string[] = [];
  readonly boundToolNameHistory: string[][] = [];
  readonly boundToolOptions: Array<Record<string, unknown> | undefined> = [];
  readonly structuredOutputToolNames = new Map<string, string>();
  readonly structuredOutputSchemaReferences: string[] = [];
  readonly structuredOutputPlanLimits: number[] = [];
  readonly structuredOutputCapabilityEnums: string[][] = [];
  #responseIndex = 0;
  #routingManifestInitializationBound = false;

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
    return 'scripted-capability-supervisor';
  }

  bindTools(tools: StructuredTool[], options?: Record<string, unknown>) {
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
    const boundNames = toolEntries.flatMap((entry) => {
      const name = entry.name ?? entry.function?.name;
      return name ? [name] : [];
    });
    if (
      boundNames.length === 1
      && boundNames[0] === CAPABILITY_ROUTING_MANIFEST_COMMIT_TOOL_NAME
    ) {
      this.#routingManifestInitializationBound = true;
      return this;
    }
    this.boundToolOptions.push(options);
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
    if (this.#routingManifestInitializationBound) {
      this.#routingManifestInitializationBound = false;
      const input = readMessageText(messages.at(-1)!);
      const sourceText = input.match(
        /<capability_registry_manifest[^>]*>\n<!\[CDATA\[\n([\s\S]*)\n\]\]>\n<\/capability_registry_manifest>/,
      )?.[1]?.replaceAll(']]]]><![CDATA[>', ']]>');
      const source = JSON.parse(sourceText ?? '{}') as {
        default?: string | null;
        capabilities?: Array<{ name: string; description: string }>;
      };
      const message = new AIMessage({
        content: '',
        tool_calls: [{
          id: 'routing-manifest-commit',
          name: CAPABILITY_ROUTING_MANIFEST_COMMIT_TOOL_NAME,
          args: {
            default: source.default ?? null,
            capabilities: (source.capabilities ?? []).map((capability) => ({
              name: capability.name,
              purpose: capability.description,
              cues: [
                capability.name,
                `${capability.name} task`,
                `${capability.name} work`,
              ],
            })),
          },
          type: 'tool_call' as const,
        }],
      });
      return { generations: [{ message, text: '' }] };
    }
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

class DelayedStructuredSupervisorModel extends ScriptedSupervisorModel {
  override async _generate(messages: BaseMessage[]) {
    const result = await super._generate(messages);
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 30);
    });
    return result;
  }
}

class SlowSupervisorModel extends BaseChatModel {
  _llmType() {
    return 'slow-capability-supervisor';
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
  const rootPath = await mkdtemp(join(tmpdir(), 'capability-supervisor-agent-'));
  t.after(() => rm(rootPath, { recursive: true, force: true }));
  const entries = [];
  for (const capabilityName of Object.keys(documents).sort()) {
    const content = documents[capabilityName] as string;
    const relativePath = `${capabilityName}/CAPABILITY.md`;
    await mkdir(join(rootPath, capabilityName));
    await writeFile(join(rootPath, relativePath), content, 'utf8');
    entries.push(Object.freeze({
      capabilityName,
      description: content.match(/^description:\s*(.+)$/m)?.[1]?.trim()
        .replace(/^['"]|['"]$/g, '') ?? `${capabilityName} capability`,
      toolkits: [],
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

function supervisorInput(
  workspace: CapabilityDocumentWorkspace,
  overrides: Partial<RunSupervisorInput> = {},
): RunSupervisorInput {
  const base = {
    inputId: 'trace_started:trace-test',
    traceId: 'trace-test',
    runId: 'run-test',
    userRequest: 'Research the repository and then prepare a review.',
    messages: [],
    activeDelegation: null,
    latestAnnounce: null,
    announceAttempts: [],
    remainingPlan: [],
    workspace,
    capabilityDisclosure: createCapabilityDisclosureState({
      workspace,
      maxEmptySearchRounds: 2,
    }),
  };
  const input = overrides.mode === 'boundary' ? {
      ...base,
      ...overrides,
      mode: 'boundary',
    } as RunSupervisorInput : {
    ...base,
    mode: 'entry',
    ...overrides,
  } as RunSupervisorInput;
  const boundaryNames = input.mode === 'boundary' ? [
    input.activeDelegation.capability,
    ...input.remainingPlan.map(({ capability }) => capability),
  ] : [];
  const capabilityDisclosure = overrides.capabilityDisclosure
    ?? {
      ...input.capabilityDisclosure,
      disclosedCapabilityNames: [...new Set([
        ...input.capabilityDisclosure.disclosedCapabilityNames,
        ...boundaryNames.filter((name) => workspace.capabilityNames.includes(name)),
      ])],
    };
  return {
    ...input,
    capabilityDisclosure,
    announceAttempts: input.mode === 'boundary'
      ? overrides.announceAttempts ?? (input.latestAnnounce ? [{
        ...input.latestAnnounce,
        result: 'result' in input.latestAnnounce
          ? String(input.latestAnnounce.result)
          : '',
      }] : [])
      : [],
    supervisorSession: overrides.supervisorSession ?? createRunSupervisorSession({
      runId: input.runId,
      plan: input.remainingPlan,
      capabilityDisclosure,
    }),
  };
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

test('Supervisor replays a typed run-scoped command without persisting provider messages', async (t) => {
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
  const model = new ScriptedSupervisorModel([{
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
  const supervisor = createRunSupervisorAgent({ model });
  const HarnessState = Annotation.Root({
    input: Annotation<RunSupervisorInput>({
      reducer: (_previous, next) => next,
    }),
    command: Annotation<unknown>({
      reducer: (_previous, next) => next,
      default: () => null,
    }),
  });
  const checkpointer = new MemorySaver();
  const graph = new StateGraph(HarnessState)
    .addNode('supervisor', async (state, config) => ({
      command: await supervisor.invoke(state.input, config),
    }))
    .addEdge(START, 'supervisor')
    .addEdge('supervisor', END)
    .compile({ checkpointer });
  const config = { configurable: { thread_id: 'supervisor-lane-root' } };
  const entryA = supervisorInput(workspace, {
    inputId: 'trace_started:trace-a',
    traceId: 'trace-a',
    runId: 'run-a1',
    userRequest: 'PRIVATE_TRACE_A_GOAL',
    messages: [
      new HumanMessage('PRIOR_MAIN_CONVERSATION'),
      new HumanMessage('PRIVATE_TRACE_A_GOAL'),
    ],
  });
  const boundaryA = supervisorInput(workspace, {
    mode: 'boundary',
    inputId: 'announce:delegation-a:1',
    traceId: 'trace-a',
    runId: 'run-a2',
    userRequest: entryA.userRequest,
    activeDelegation: {
      delegationId: 'delegation-a',
      runId: 'run-a',
      capability: 'general',
      task: 'Complete trace A.',
    },
    latestAnnounce: {
      messageId: 'announce-a',
      completionReason: 'natural',
      result: 'Trace A execution is complete.',
    },
    announceAttempts: [{
      messageId: 'announce-a',
      completionReason: 'natural',
      result: 'Trace A execution is complete.',
    }],
    messages: [],
  });

  const entryState = await graph.invoke({ input: entryA }, config);
  assert.deepEqual(commandOnly(entryState.command), {
    action: 'execute_plan',
    tasks: [{ capability: 'general', task: 'Complete trace A.' }],
  });
  assert.match(model.invocations[0]?.map(readMessageText).join('\n') ?? '', /PRIOR_MAIN_CONVERSATION/);
  const boundaryInput = {
    ...boundaryA,
    messages: [...entryA.messages],
  };
  const boundaryState = await graph.invoke({ input: boundaryInput }, config);
  assert.deepEqual(commandOnly(boundaryState.command), { action: 'goal_done', tasks: [] });
  assert.equal(model.invocations.length, 2);
  assert.match(
    model.invocations[1]?.map(readMessageText).join('\n') ?? '',
    /PRIVATE_TRACE_A_GOAL/,
  );
  assert.match(
    model.invocations[1]?.map(readMessageText).join('\n') ?? '',
    /Trace A execution is complete/,
  );
  const boundaryCommand = commandOnly(boundaryState.command) as {
    action: 'goal_done';
    tasks: [];
  };
  const completedBoundaryInput = {
    ...boundaryInput,
    supervisorSession: {
      ...boundaryInput.supervisorSession,
      lastCommand: {
        inputId: boundaryInput.inputId,
        registryDigest: boundaryInput.workspace.registryDigest,
        command: boundaryCommand,
      },
    },
  };

  const duplicateState = await graph.invoke({ input: completedBoundaryInput }, config);
  assert.deepEqual(commandOnly(duplicateState.command), { action: 'goal_done', tasks: [] });
  assert.equal(model.invocations.length, 2, 'duplicate inputId must use the typed cached command');

  const restartedModel = new ScriptedSupervisorModel([{
    toolCalls: [{ id: 'must-not-run', name: 'report_unavailable', args: {} }],
  }]);
  const restartedSupervisor = createRunSupervisorAgent({ model: restartedModel });
  const restartedGraph = new StateGraph(HarnessState)
    .addNode('supervisor', async (state, runnableConfig) => ({
      command: await restartedSupervisor.invoke(state.input, runnableConfig),
    }))
    .addEdge(START, 'supervisor')
    .addEdge('supervisor', END)
    .compile({ checkpointer });
  const restartedState = await restartedGraph.invoke({ input: completedBoundaryInput }, config);
  assert.deepEqual(commandOnly(restartedState.command), { action: 'goal_done', tasks: [] });
  assert.equal(restartedModel.invocations.length, 0, 'a rebuilt Supervisor must replay the persisted command');

  const changedRegistryState = await graph.invoke({
    input: { ...completedBoundaryInput, workspace: changedWorkspace },
  }, config);
  assert.deepEqual(commandOnly(changedRegistryState.command), { action: 'unavailable', tasks: [] });
  assert.equal(model.invocations.length, 3, 'registry changes must invalidate a cached command');

  const entryB = supervisorInput(workspace, {
    inputId: 'trace_started:trace-b',
    traceId: 'trace-b',
    runId: 'run-b1',
    userRequest: 'PRIVATE_TRACE_B_GOAL',
  });
  const traceBState = await graph.invoke({ input: entryB }, config);
  assert.deepEqual(commandOnly(traceBState.command), { action: 'unavailable', tasks: [] });
  assert.equal(model.invocations.length, 4);
  const traceBMessages = model.invocations[3]?.map(readMessageText).join('\n') ?? '';
  assert.match(traceBMessages, /PRIVATE_TRACE_B_GOAL/);
  assert.doesNotMatch(traceBMessages, /PRIVATE_TRACE_A_GOAL/);
  assert.equal('messageUpdates' in (traceBState.command as object), false);

});

test('Supervisor supports additional invocation-scoped tools without child persistence', async (t) => {
  const workspace = await createWorkspace(t, {
    general: capabilityDocument({
      name: 'general',
      description: 'Handle ordinary workspace tasks.',
      instructions: 'Complete the requested work.',
    }),
  });
  const inspectSupervisor = tool(async () => 'approved', {
    name: 'inspect_supervisor',
    description: 'Return an invocation-scoped observation.',
    schema: z.object({}).strict(),
  });
  const model = new ScriptedSupervisorModel([{
    toolCalls: [{ id: 'inspect', name: 'inspect_supervisor', args: {} }],
  }, {
    structuredOutput: {
      kind: 'plan',
      args: {
        tasks: [{ capability: 'general', task: 'Continue after approval.' }],
      },
    },
  }]);
  const supervisor = createRunSupervisorAgent({
    model,
    additionalTools: [inspectSupervisor],
  });
  const input = supervisorInput(workspace, {
    inputId: 'trace_started:trace-interrupt',
    traceId: 'trace-interrupt',
    runId: 'run-interrupt',
    userRequest: 'Continue after an invocation-scoped check.',
  });

  const result = await supervisor.invoke(input);
  assert.deepEqual(commandOnly(result), {
    action: 'execute_plan',
    tasks: [{ capability: 'general', task: 'Continue after approval.' }],
  });
  assert.equal(model.invocations.length, 2);
  assert.match(
    model.invocations[1]?.map(readMessageText).join('\n') ?? '',
    /approved/,
  );
});

test('Supervisor Agent explores CAPABILITY.md files and returns a compact ordered task plan', async (t) => {
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
  const model = new ScriptedSupervisorModel([
    {
      toolCalls: [{
        id: 'grep',
        name: RUN_SUPERVISOR_CAPABILITY_SEARCH_TOOL_NAME,
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
  const result = await createRunSupervisorAgent({ model })
    .invoke(supervisorInput(workspace));

  assert.deepEqual(model.boundToolNameHistory[0]?.slice(0, 1), [
    RUN_SUPERVISOR_CAPABILITY_SEARCH_TOOL_NAME,
  ]);
  assert.equal(model.boundToolNameHistory[0]?.includes('request_user_input'), true);
  assert.equal(model.boundToolNameHistory[0]?.includes('submit_plan'), true);
  assert.equal(model.boundToolNameHistory[0]?.includes('continue_current'), false);
  assert.equal(model.boundToolNameHistory[0]?.includes('advance_plan'), false);
  assert.equal(model.boundToolNameHistory[0]?.includes('complete_goal'), false);
  assert.equal(model.boundToolNameHistory[1]?.includes(
    RUN_SUPERVISOR_CAPABILITY_SEARCH_TOOL_NAME,
  ), true);
  assert.equal(model.boundToolNameHistory[1]?.includes('request_user_input'), true);
  assert.equal(model.structuredOutputToolNames.size, 2);
  assert.ok(model.structuredOutputToolNames.has('plan'));
  assert.equal(model.structuredOutputToolNames.has('advance'), false);
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
  const supervisorInputIndex = firstInvocationTexts.findIndex(
    (text) => text.includes('Research the repository and then prepare a review.'),
  );
  assert.ok(supervisorInputIndex >= 0);
  const searchResult = model.invocations[1]?.find((message) =>
    ToolMessage.isInstance(message)
    && message.name === RUN_SUPERVISOR_CAPABILITY_SEARCH_TOOL_NAME);
  assert.ok(ToolMessage.isInstance(searchResult));
  const searchPayload = JSON.parse(String(searchResult.content)) as {
    capabilityDiscovery?: {
      newlyDisclosedCapabilityNames?: string[];
      disclosedCapabilityNames?: string[];
    };
  };
  assert.deepEqual(
    searchPayload.capabilityDiscovery?.newlyDisclosedCapabilityNames,
    ['explore'],
  );
  assert.deepEqual(
    searchPayload.capabilityDiscovery?.disclosedCapabilityNames,
    ['explore'],
  );
  assert.deepEqual(commandOnly(result), {
    action: 'execute_plan',
    tasks: [{
      capability: 'explore',
      task: 'Research the repository.',
    }, {
      capability: 'general',
      task: 'Prepare the review from the findings.',
    }],
  });
  assert.deepEqual(result.capabilityDisclosure?.disclosedCapabilityNames, [
    'explore',
  ]);
  assert.equal(result.capabilityDisclosure?.emptySearchRounds, 0);
});

test('entry mode forms one executable task after Capability exploration', async (t) => {
  const workspace = await createWorkspace(t, {
    explore: capabilityDocument({
      name: 'explore',
      description: 'Investigate repositories.',
      instructions: 'Inspect files and report evidence.',
    }),
  });
  const model = new ScriptedSupervisorModel([
    {
      toolCalls: [{
        id: 'grep',
        name: RUN_SUPERVISOR_CAPABILITY_SEARCH_TOOL_NAME,
        args: { terms: ['investigate', 'repository'] },
      }],
    },
    {
      structuredOutput: {
        kind: 'plan',
        args: {
          tasks: [{
            capability: 'explore',
            task: 'Inspect issue #473 and report the Supervisor Agent constraints.',
          }],
        },
      },
    },
  ]);

  const result = await createRunSupervisorAgent({ model })
    .invoke(supervisorInput(workspace));

  assert.equal(model.invocations.length, 2);
  assert.equal(model.structuredOutputToolNames.size, 2);
  assert.ok(model.structuredOutputToolNames.has('plan'));
  assert.equal(model.structuredOutputToolNames.has('advance'), false);
  assert.ok(model.structuredOutputToolNames.has('unavailable'));
  assert.ok('tasks' in result);
  assert.equal(
    'tasks' in result ? result.tasks[0]?.task : null,
    'Inspect issue #473 and report the Supervisor Agent constraints.',
  );
  assert.equal('tasks' in result ? result.tasks.length : 0, 1);
});

test('Supervisor accepts a detailed task beyond the legacy 500-character limit', async (t) => {
  const workspace = await createWorkspace(t, {
    general: capabilityDocument({
      name: 'general',
      description: 'Handle ordinary tasks.',
      instructions: 'Complete the requested work.',
    }),
  });
  const detailedTask = 'x'.repeat(501);
  const model = new ScriptedSupervisorModel([{
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

  const result = await createRunSupervisorAgent({ model })
    .invoke(supervisorInput(workspace));

  assert.deepEqual(commandOnly(result), {
    action: 'execute_plan',
    tasks: [{
      capability: 'general',
      task: detailedTask,
    }],
  });
});

test('Supervisor accepts consecutive tasks from one Capability when the model keeps distinct boundaries', async (t) => {
  const workspace = await createWorkspace(t, {
    general: capabilityDocument({
      name: 'general',
      description: 'Handle ordinary workspace tasks.',
      instructions: 'Complete the requested work.',
    }),
  });
  const model = new ScriptedSupervisorModel([
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

  const result = await createRunSupervisorAgent({ model })
    .invoke(supervisorInput(workspace));

  assert.ok('tasks' in result);
  assert.deepEqual('tasks' in result ? result.tasks : [], [{
    capability: 'general',
    task: 'Inspect the failing release and identify the exact package boundary.',
  }, {
    capability: 'general',
    task: 'Apply the accepted findings, verify the package, and publish it.',
  }]);
});

test('Supervisor reports closed discovery after two empty rounds while keeping search auto', async (t) => {
  const workspace = await createWorkspace(t, {
    general: capabilityDocument({
      name: 'general',
      description: 'Handle ordinary workspace tasks.',
      instructions: 'Complete the requested work.',
    }),
  });
  const model = new ScriptedSupervisorModel([
    {
      toolCalls: [{
        id: 'grep-1',
        name: RUN_SUPERVISOR_CAPABILITY_SEARCH_TOOL_NAME,
        args: { terms: ['missing-responsibility-one'] },
      }],
    },
    {
      toolCalls: [{
        id: 'grep-2',
        name: RUN_SUPERVISOR_CAPABILITY_SEARCH_TOOL_NAME,
        args: { terms: ['missing-responsibility-two'] },
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

  const result = await createRunSupervisorAgent({ model }).invoke(
    supervisorInput(workspace),
  );

  assert.deepEqual(commandOnly(result), {
    action: 'execute_plan',
    tasks: [{
      capability: 'general',
      task: 'Complete the requested workspace task using the discovered Capability.',
    }],
  });
  const searchResults = [...new Map(
    model.invocations.flat().filter(
      (message): message is ToolMessage => message instanceof ToolMessage
        && message.name === RUN_SUPERVISOR_CAPABILITY_SEARCH_TOOL_NAME,
    ).map((message) => [message.tool_call_id, message]),
  ).values()];
  assert.equal(searchResults.length, 2);
  assert.equal(searchResults.some((message) => message.status === 'error'), false);
  assert.match(String(searchResults[0]?.content), /"status":"open"/);
  assert.match(String(searchResults[0]?.content), /"emptySearchRounds":1/);
  assert.match(String(searchResults[0]?.content), /"remainingEmptyRounds":1/);
  assert.match(String(searchResults[1]?.content), /"status":"closed"/);
  assert.match(String(searchResults[1]?.content), /"emptySearchRounds":2/);
  assert.match(String(searchResults[1]?.content), /"remainingEmptyRounds":0/);
  assert.match(String(searchResults[0]?.content), /"disclosedCapabilityNames":\[\]/);
  assert.match(String(searchResults[0]?.content), /"newlyDisclosedCapabilityNames":\[\]/);
  assert.equal(model.boundToolNameHistory[1]?.includes(
    RUN_SUPERVISOR_CAPABILITY_SEARCH_TOOL_NAME,
  ), true);
  assert.equal(model.boundToolNameHistory[2]?.includes(
    RUN_SUPERVISOR_CAPABILITY_SEARCH_TOOL_NAME,
  ), true);
  assert.equal(model.boundToolOptions[1]?.tool_choice, undefined);
  assert.equal(model.boundToolOptions[2]?.tool_choice, undefined);
});

test('Supervisor receives General routing metadata without preloading its document', async (t) => {
  const workspace = await createWorkspace(t, {
    general: capabilityDocument({
      name: 'general',
      description: '处理不需要更具体 Capability 的通用任务。',
      instructions: '使用通用工具读取和修改工作区。',
    }),
  });
  const model = new ScriptedSupervisorModel([{
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

  const result = await createRunSupervisorAgent({ model }).invoke(
    supervisorInput(workspace, {
      userRequest: '查看并整理 /Users/mac/Downloads 目录。\n\n用户明确允许使用通用工具。',
    }),
  );

  assert.deepEqual(commandOnly(result), {
    action: 'execute_plan',
    tasks: [{
      capability: 'general',
      task: 'Inspect and organize the requested Downloads directory.',
    }],
  });
  // Dynamic Capability documents are projected into the invocation Human
  // message; the stable system prompt contains no workspace content.
  const systemMessage = model.invocations[0]?.[0];
  assert.ok(systemMessage);
  assert.equal(systemMessage._getType(), 'system');
  assert.doesNotMatch(readMessageText(systemMessage), /<capability_context/);
  assert.doesNotMatch(readMessageText(systemMessage), /通用工具读取和修改工作区/);
  const supervisorInputMessage = model.invocations[0]?.find(
    (message) => message instanceof HumanMessage,
  );
  assert.ok(supervisorInputMessage instanceof HumanMessage);
  assert.match(readMessageText(supervisorInputMessage), /<capability name="general">/);
  assert.match(readMessageText(supervisorInputMessage), /处理不需要更具体 Capability 的通用任务/);
  assert.doesNotMatch(readMessageText(supervisorInputMessage), /通用工具读取和修改工作区/);
  assert.equal(model.invocations.flat().some(
    (message) => message instanceof ToolMessage
      && message.name === RUN_SUPERVISOR_CAPABILITY_SEARCH_TOOL_NAME,
  ), false);
});

test('boundary projects the current lane announce into the standard model-visible shape', async (t) => {
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
  const currentAnnounce = new AIMessage({
    id: 'announce-current',
    content: 'The repository inspection is incomplete; dependency evidence is missing.',
  });
  setAgentMessageDelegationScope(currentAnnounce, {
    lane: 'capability:explore',
    runId: 'run-current',
    delegationId: 'delegation-current',
  });
  const privateLaneMessage = new AIMessage('PRIVATE_RAW_EXECUTOR_TRANSCRIPT');
  setAgentMessageMetadata(privateLaneMessage, {
    lane: 'capability:explore',
    runId: 'run-current',
    delegationId: 'delegation-current',
  });
  const priorMainRequest = new HumanMessage({
    id: 'main-prior-request',
    content: 'First establish the repository constraints.',
  });
  const priorMainReply = new AIMessage({
    id: 'main-prior-reply',
    content: 'The repository constraints are established.',
  });
  const currentMainRequest = new HumanMessage({
    id: 'main-current-request',
    content: 'Inspect the repository and implement the required changes.',
  });
  const currentMainContext = new AIMessage({
    id: 'main-current-context',
    content: 'The current repository constraint remains user-visible context.',
  });
  const model = new ScriptedSupervisorModel([{
    toolCalls: [{
      id: 'continue-current',
      name: 'continue_current',
      args: {},
    }],
  }]);

  await createRunSupervisorAgent({ model }).invoke(
    supervisorInput(workspace, {
      mode: 'boundary',
      activeDelegation: {
        delegationId: 'delegation-current',
        runId: 'run-current',
        capability: 'explore',
        task: 'Inspect repository dependencies.',
      },
      latestAnnounce: {
        messageId: 'announce-current',
        completionReason: 'limit_reached',
        result: 'The repository inspection is incomplete; dependency evidence is missing.',
      },
      messages: [
        priorMainRequest,
        priorMainReply,
        currentMainRequest,
        currentMainContext,
        privateLaneMessage,
        currentAnnounce,
      ],
      remainingPlan: [{
        capability: 'general',
        task: 'Implement the verified dependency changes.',
      }],
    }),
  );

  const invocationText = model.invocations[0]?.map(readMessageText).join('\n') ?? '';
  assert.match(invocationText, /<supervision_boundary_event role="task_boundary" source="orchestrator_state">/);
  assert.match(invocationText, /evaluation_target="announce-current"/);
  assert.match(invocationText, /completion_reason="limit_reached"/);
  assert.match(invocationText, /Inspect repository dependencies\./);
  assert.match(invocationText, /dependency evidence is missing/);
  assert.equal(model.invocations[0]?.some((message) => message.id === 'announce-current'), false);
  assert.equal(currentAnnounce.content, 'The repository inspection is incomplete; dependency evidence is missing.');
  assert.equal(model.invocations[0]?.includes(privateLaneMessage), false);
  assert.equal(model.invocations[0]?.some((message) =>
    readMessageText(message).includes('PRIVATE_RAW_EXECUTOR_TRANSCRIPT')), false);
  assert.equal(model.invocations[0]?.includes(priorMainRequest), true);
  assert.equal(model.invocations[0]?.includes(priorMainReply), true);
  assert.equal(model.invocations[0]?.includes(currentMainRequest), true);
  assert.equal(model.invocations[0]?.includes(currentMainContext), true);
  const boundaryInput = [...(model.invocations[0] ?? [])].reverse().find(
    (message) => message instanceof HumanMessage,
  );
  assert.ok(boundaryInput instanceof HumanMessage);
  assert.match(readMessageText(boundaryInput), /<run_user_request[^>]*>/);
  assert.match(readMessageText(boundaryInput), /<capability_context[^>]*>/);
  assert.match(readMessageText(boundaryInput), /<supervision_boundary[^>]*>/);
});

test('Supervisor identifies the configured default without preloading its document', async (t) => {
  const workspace = await createWorkspace(t, {
    general: capabilityDocument({
      name: 'general',
      description: 'Handle ordinary work.',
      instructions: 'Use general tools.',
    }),
    kanban_planning: capabilityDocument({
      name: 'kanban_planning',
      description: 'Plan work on the Kanban board.',
      instructions: 'Decompose the goal and create Kanban tasks.',
    }),
  });
  const model = new ScriptedSupervisorModel([{
    structuredOutput: {
      kind: 'plan',
      args: {
        tasks: [{
          capability: 'kanban_planning',
          task: 'Create a task plan on the board.',
        }],
      },
    },
  }]);

  const result = await createRunSupervisorAgent({
    model,
    defaultCapabilityName: 'kanban_planning',
  }).invoke(supervisorInput(workspace, {
    capabilityDisclosure: createCapabilityDisclosureState({
      workspace,
      maxEmptySearchRounds: 2,
    }),
  }));

  assert.deepEqual(commandOnly(result), {
    action: 'execute_plan',
    tasks: [{
      capability: 'kanban_planning',
      task: 'Create a task plan on the board.',
    }],
  });
  const supervisorInputMessage = model.invocations[0]?.find(
    (message) => message instanceof HumanMessage,
  );
  assert.ok(supervisorInputMessage instanceof HumanMessage);
  assert.match(
    readMessageText(supervisorInputMessage),
    /<capability name="kanban_planning">/,
  );
  assert.match(readMessageText(supervisorInputMessage), /Plan work on the Kanban board/);
  assert.doesNotMatch(readMessageText(supervisorInputMessage), /create Kanban tasks/);
  assert.doesNotMatch(readMessageText(supervisorInputMessage), /Use general tools/);
});

test('an explicit second search discloses a specific Capability after a miss', async (t) => {
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
    name: RUN_SUPERVISOR_CAPABILITY_SEARCH_TOOL_NAME,
    args: { terms },
  });
  const model = new ScriptedSupervisorModel([
    { toolCalls: [search('search-miss', ['auth'])] },
    { toolCalls: [search('search-exact', ['explore repository structure inspect code'])] },
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

  const result = await createRunSupervisorAgent({ model }).invoke(
    supervisorInput(workspace),
  );

  assert.deepEqual(commandOnly(result), {
    action: 'execute_plan',
    tasks: [{
      capability: 'explore',
      task: 'Inspect the auth module structure and risks.',
    }],
  });
  const searchResults = [...new Map(
    model.invocations.flat().filter(
      (message): message is ToolMessage => ToolMessage.isInstance(message)
        && message.name === RUN_SUPERVISOR_CAPABILITY_SEARCH_TOOL_NAME,
    ).map((message) => [message.tool_call_id, JSON.parse(String(message.content)) as {
      capabilityDiscovery?: {
        status?: string;
        remainingEmptyRounds?: number;
        newlyDisclosedCapabilityNames?: string[];
        disclosedCapabilityNames?: string[];
      };
    }]),
  ).values()];
  assert.deepEqual(
    searchResults[0]?.capabilityDiscovery?.newlyDisclosedCapabilityNames,
    [],
  );
  assert.deepEqual(
    searchResults[0]?.capabilityDiscovery?.disclosedCapabilityNames,
    [],
  );
  assert.equal(searchResults[0]?.capabilityDiscovery?.status, 'open');
  assert.equal(searchResults[0]?.capabilityDiscovery?.remainingEmptyRounds, 1);
  assert.deepEqual(
    searchResults[1]?.capabilityDiscovery?.newlyDisclosedCapabilityNames,
    ['explore'],
  );
  // A matching search does not consume discovery budget: only wholly empty
  // model rounds count toward closure.
  assert.equal(searchResults[1]?.capabilityDiscovery?.status, 'open');
  assert.equal(searchResults[1]?.capabilityDiscovery?.remainingEmptyRounds, 1);
});

test('General is disclosed through the same search path as other Capabilities', async (t) => {
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
  const model = new ScriptedSupervisorModel([{
    toolCalls: [{
      id: 'search-default-only',
      name: RUN_SUPERVISOR_CAPABILITY_SEARCH_TOOL_NAME,
      args: { terms: ['ordinary'] },
    }],
  }, {
    structuredOutput: {
      kind: 'plan',
      args: {
        tasks: [{
          capability: 'general',
          task: 'Complete the ordinary workspace task.',
        }],
      },
    },
  }]);

  await createRunSupervisorAgent({ model }).invoke(supervisorInput(workspace));

  const searchResult = model.invocations[1]?.find((message) =>
    ToolMessage.isInstance(message)
    && message.tool_call_id === 'search-default-only');
  assert.ok(ToolMessage.isInstance(searchResult));
  const payload = JSON.parse(String(searchResult.content)) as {
    data?: { matches?: unknown[] };
    capabilityDiscovery?: {
      newlyDisclosedCapabilityNames?: string[];
      disclosedCapabilityNames?: string[];
      emptySearchRounds?: number;
    };
    planningObjective?: string;
  };
  assert.equal(payload.data?.matches?.length, 1);
  assert.deepEqual(
    payload.capabilityDiscovery?.newlyDisclosedCapabilityNames,
    ['general'],
  );
  assert.deepEqual(
    payload.capabilityDiscovery?.disclosedCapabilityNames,
    ['general'],
  );
  assert.equal(payload.capabilityDiscovery?.emptySearchRounds, 0);
  assert.match(payload.planningObjective ?? '', /newly disclosed Capability/);
});

test('a boundary search does not redisclose its active Capability', async (t) => {
  const workspace = await createWorkspace(t, {
    explore: capabilityDocument({
      name: 'explore',
      description: 'Inspect release readiness without publishing packages.',
      instructions: 'Report readiness evidence; do not publish packages.',
    }),
  });
  const model = new ScriptedSupervisorModel([{
    toolCalls: [{
      id: 'boundary-search-miss',
      name: RUN_SUPERVISOR_CAPABILITY_SEARCH_TOOL_NAME,
      args: { terms: ['publish'] },
    }],
  }, {
    structuredOutput: {
      kind: 'unavailable',
      args: {},
    },
  }]);

  const result = await createRunSupervisorAgent({ model }).invoke(
    supervisorInput(workspace, {
      mode: 'boundary',
      activeDelegation: {
        delegationId: 'delegation-1',
        runId: 'run-1',
        capability: 'explore',
        task: 'Inspect package release readiness.',
      },
      remainingPlan: [],
    }),
  );

  assert.deepEqual(commandOnly(result), { action: 'unavailable', tasks: [] });
  const searchResult = model.invocations[1]?.find((message) =>
    ToolMessage.isInstance(message)
    && message.name === RUN_SUPERVISOR_CAPABILITY_SEARCH_TOOL_NAME);
  assert.ok(ToolMessage.isInstance(searchResult));
  const payload = JSON.parse(String(searchResult.content)) as {
    data?: { matches?: unknown[] };
    capabilityDiscovery?: {
      status?: string;
      remainingEmptyRounds?: number;
      emptySearchRounds?: number;
      newlyDisclosedCapabilityNames?: string[];
      disclosedCapabilityNames?: string[];
    };
  };
  assert.deepEqual(payload.data?.matches, []);
  assert.deepEqual(payload.capabilityDiscovery?.newlyDisclosedCapabilityNames, []);
  assert.deepEqual(
    payload.capabilityDiscovery?.disclosedCapabilityNames,
    ['explore'],
  );
  assert.equal(payload.capabilityDiscovery?.status, 'open');
  assert.equal(payload.capabilityDiscovery?.emptySearchRounds, 1);
  assert.equal(payload.capabilityDiscovery?.remainingEmptyRounds, 1);
});

test('a boundary can disclose a non-active Capability after a miss', async (t) => {
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
    name: RUN_SUPERVISOR_CAPABILITY_SEARCH_TOOL_NAME,
    args: { terms },
  });
  const model = new ScriptedSupervisorModel([
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

  const result = await createRunSupervisorAgent({ model }).invoke(
    supervisorInput(workspace, {
      mode: 'boundary',
      activeDelegation: {
        delegationId: 'delegation-1',
        runId: 'run-1',
        capability: 'explore',
        task: 'Read the current issue status.',
      },
      remainingPlan: [],
    }),
  );

  assert.deepEqual(commandOnly(result), {
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
  const firstPayload = JSON.parse(String(firstSearchResult.content)) as {
    capabilityDiscovery?: {
      newlyDisclosedCapabilityNames?: string[];
      emptySearchRounds?: number;
    };
  };
  assert.deepEqual(firstPayload.capabilityDiscovery?.newlyDisclosedCapabilityNames, []);
  assert.equal(firstPayload.capabilityDiscovery?.emptySearchRounds, 1);
  const secondSearchResult = model.invocations[2]?.find((message) =>
    ToolMessage.isInstance(message)
    && message.tool_call_id === 'boundary-exact');
  assert.ok(ToolMessage.isInstance(secondSearchResult));
  const secondPayload = JSON.parse(String(secondSearchResult.content)) as {
    capabilityDiscovery?: {
      newlyDisclosedCapabilityNames?: string[];
      disclosedCapabilityNames?: string[];
    };
  };
  assert.deepEqual(
    secondPayload.capabilityDiscovery?.newlyDisclosedCapabilityNames,
    ['document_writer'],
  );
  assert.deepEqual(
    secondPayload.capabilityDiscovery?.disclosedCapabilityNames,
    ['explore', 'document_writer'],
  );
});

test('a Boundary search does not redisclose its seeded active General', async (t) => {
  const workspace = await createWorkspace(t, {
    general: capabilityDocument({
      name: 'general',
      description: 'Handle ordinary workspace tasks.',
      instructions: 'Complete and verify the requested work.',
    }),
  });
  const model = new ScriptedSupervisorModel([{
    toolCalls: [{
      id: 'search-active-default',
      name: RUN_SUPERVISOR_CAPABILITY_SEARCH_TOOL_NAME,
      args: { terms: ['ordinary'] },
    }],
  }, {
    toolCalls: [{
      id: 'continue-active-default',
      name: 'continue_current',
      args: {},
    }],
  }]);

  const result = await createRunSupervisorAgent({ model }).invoke(
    supervisorInput(workspace, {
      mode: 'boundary',
      activeDelegation: {
        delegationId: 'delegation-general',
        runId: 'run-general',
        capability: 'general',
        task: 'Complete the ordinary workspace task.',
      },
      remainingPlan: [],
    }),
  );

  assert.deepEqual(commandOnly(result), { action: 'continue_current', tasks: [] });
  const searchResult = model.invocations[1]?.find((message) =>
    ToolMessage.isInstance(message)
    && message.tool_call_id === 'search-active-default');
  assert.ok(ToolMessage.isInstance(searchResult));
  const payload = JSON.parse(String(searchResult.content)) as {
    data?: { matches?: unknown[] };
    capabilityDiscovery?: {
      newlyDisclosedCapabilityNames?: string[];
      disclosedCapabilityNames?: string[];
    };
  };
  assert.deepEqual(payload.data?.matches, []);
  assert.deepEqual(payload.capabilityDiscovery?.newlyDisclosedCapabilityNames, []);
  assert.deepEqual(payload.capabilityDiscovery?.disclosedCapabilityNames, ['general']);
});

test('Supervisor counts parallel capability_search calls as one disclosure round', async (t) => {
  const workspace = await createWorkspace(t, {
    general: capabilityDocument({
      name: 'general',
      description: 'Handle ordinary workspace tasks.',
      instructions: 'Complete the requested work.',
    }),
  });
  const model = new ScriptedSupervisorModel([
    {
      toolCalls: [{
        id: 'parallel-grep-1',
        name: RUN_SUPERVISOR_CAPABILITY_SEARCH_TOOL_NAME,
        args: { terms: ['general'] },
      }, {
        id: 'parallel-grep-2',
        name: RUN_SUPERVISOR_CAPABILITY_SEARCH_TOOL_NAME,
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

  const result = await createRunSupervisorAgent({ model }).invoke(
    supervisorInput(workspace),
  );

  assert.deepEqual(commandOnly(result), {
    action: 'execute_plan',
    tasks: [{
      capability: 'general',
      task: 'Complete the requested workspace task using the discovered Capability.',
    }],
  });
  const searchToolCallIds = new Set(
    model.invocations.flat().flatMap((message) =>
      message instanceof ToolMessage
      && message.name === RUN_SUPERVISOR_CAPABILITY_SEARCH_TOOL_NAME
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
    && message.name === RUN_SUPERVISOR_CAPABILITY_SEARCH_TOOL_NAME) ?? [];
  assert.equal(searchResults.length, 2);
  assert.ok(searchResults.every((message) =>
    String(message.content).includes('"status":"open"')));
  assert.ok(searchResults.every((message) =>
    String(message.content).includes('"emptySearchRounds":0')));
  assert.ok(searchResults.every((message) =>
    String(message.content).includes('"status":"pending_parallel_batch"')));
  assert.equal(model.boundToolNameHistory[1]?.includes(
    RUN_SUPERVISOR_CAPABILITY_SEARCH_TOOL_NAME,
  ), true);
  assert.equal(model.boundToolOptions[1]?.tool_choice, undefined);
});

test('a matching search keeps a parallel batch from consuming empty-search budget', async (t) => {
  const workspace = await createWorkspace(t, {
    explore: capabilityDocument({
      name: 'explore',
      description: 'Investigate repository evidence.',
      instructions: 'Inspect available evidence and report findings.',
    }),
    general: capabilityDocument({
      name: 'general',
      description: 'Handle ordinary workspace tasks.',
      instructions: 'Complete the requested work.',
    }),
  });
  const search = (id: string, terms: string[]) => ({
    id,
    name: RUN_SUPERVISOR_CAPABILITY_SEARCH_TOOL_NAME,
    args: { terms },
  });
  const model = new ScriptedSupervisorModel([
    { toolCalls: [
      search('parallel-miss', ['ordinary']),
      search('parallel-hit', ['explore']),
    ] },
    { toolCalls: [search('first-empty-after-hit', ['unrelated'])] },
    {
      structuredOutput: {
        kind: 'plan',
        args: {
          tasks: [{
            capability: 'explore',
            task: 'Inspect the requested repository evidence.',
          }],
        },
      },
    },
  ]);

  const result = await createRunSupervisorAgent({ model }).invoke(
    supervisorInput(workspace, {
      capabilityDisclosure: createCapabilityDisclosureState({
        workspace,
        maxEmptySearchRounds: 1,
      }),
    }),
  );

  assert.deepEqual(commandOnly(result), {
    action: 'execute_plan',
    tasks: [{
      capability: 'explore',
      task: 'Inspect the requested repository evidence.',
    }],
  });
  const postHitSearch = model.invocations[2]?.find((message) =>
    ToolMessage.isInstance(message)
    && message.tool_call_id === 'first-empty-after-hit');
  assert.ok(ToolMessage.isInstance(postHitSearch));
  const payload = JSON.parse(String(postHitSearch.content)) as {
    ok?: boolean;
    capabilityDiscovery?: {
      status?: string;
      emptySearchRounds?: number;
      remainingEmptyRounds?: number;
    };
  };
  assert.equal(payload.ok, true);
  assert.equal(payload.capabilityDiscovery?.status, 'closed');
  assert.equal(payload.capabilityDiscovery?.emptySearchRounds, 1);
  assert.equal(payload.capabilityDiscovery?.remainingEmptyRounds, 0);
});

test('Supervisor returns to Answer after one capability_search without general', async (t) => {
  const workspace = await createWorkspace(t, {
    explore: capabilityDocument({
      name: 'explore',
      description: 'Investigate repository evidence.',
      instructions: 'Inspect available evidence and report findings.',
    }),
  });
  const model = new ScriptedSupervisorModel([
    {
      toolCalls: [{
        id: 'grep-answer-1',
        name: RUN_SUPERVISOR_CAPABILITY_SEARCH_TOOL_NAME,
        args: { terms: ['explore'] },
      }],
    },
    {
      structuredOutput: {
        kind: 'unavailable',
        args: {
          reason: 'The available Capability evidence does not define an executable task.',
          context: 'The Supervisor completed its bounded Capability search and needs a user decision.',
        },
      },
    },
  ]);

  const result = await createRunSupervisorAgent({ model }).invoke(
    supervisorInput(workspace),
  );

  assert.deepEqual(commandOnly(result), {
    action: 'unavailable',
    tasks: [],
  });
});

test('Supervisor returns a stable limit result for every search after max rounds', async (t) => {
  const workspace = await createWorkspace(t, {
    general: capabilityDocument({
      name: 'general',
      description: 'Handle ordinary workspace tasks.',
      instructions: 'Complete the requested work.',
    }),
  });
  const model = new ScriptedSupervisorModel([{
    toolCalls: [{
      id: 'search-telecom-1',
      name: RUN_SUPERVISOR_CAPABILITY_SEARCH_TOOL_NAME,
      args: { terms: ['telecom license', '增值电信', '审查'] },
    }],
  }, {
    toolCalls: [{
      id: 'search-telecom-2',
      name: RUN_SUPERVISOR_CAPABILITY_SEARCH_TOOL_NAME,
      args: { terms: ['license review'] },
    }],
  }, {
    toolCalls: [{
      id: 'search-telecom-over-limit-1',
      name: RUN_SUPERVISOR_CAPABILITY_SEARCH_TOOL_NAME,
      args: { terms: ['license'] },
    }],
  }, {
    toolCalls: [{
      id: 'search-telecom-over-limit-2',
      name: RUN_SUPERVISOR_CAPABILITY_SEARCH_TOOL_NAME,
      args: { terms: ['review'] },
    }],
  }, {
    structuredOutput: {
      kind: 'plan',
      args: {
        tasks: [{
          capability: 'general',
          task: 'Review the telecom license requirements with the available Capability.',
        }],
      },
    },
  }]);

  const result = await createRunSupervisorAgent({ model }).invoke(
    supervisorInput(workspace),
  );

  assert.deepEqual(commandOnly(result), {
    action: 'execute_plan',
    tasks: [{
      capability: 'general',
      task: 'Review the telecom license requirements with the available Capability.',
    }],
  });
  assert.equal(model.invocations.length, 5);
  const searchResults = [...new Map(
    model.invocations.flat().filter(
      (message): message is ToolMessage => ToolMessage.isInstance(message)
        && message.name === RUN_SUPERVISOR_CAPABILITY_SEARCH_TOOL_NAME,
    ).map((message) => [message.tool_call_id, message]),
  ).values()];
  assert.equal(searchResults.length, 4);
  assert.equal(JSON.parse(String(searchResults[0]?.content)).ok, true);
  assert.equal(JSON.parse(String(searchResults[1]?.content)).ok, true);
  const secondSearchPayload = JSON.parse(String(searchResults[1]?.content)) as {
    capabilityDiscovery?: {
      status?: string;
      emptySearchRounds?: number;
      maxEmptySearchRounds?: number;
      remainingEmptyRounds?: number;
      newlyDisclosedCapabilityNames?: string[];
      disclosedCapabilityNames?: string[];
    };
  };
  assert.deepEqual(secondSearchPayload.capabilityDiscovery, {
    status: 'closed',
    emptySearchRounds: 2,
    maxEmptySearchRounds: 2,
    remainingEmptyRounds: 0,
    newlyDisclosedCapabilityNames: [],
    disclosedCapabilityNames: [],
  });
  for (const message of searchResults.slice(2)) {
    const payload = JSON.parse(String(message.content)) as {
      ok?: boolean;
      error?: { code?: string; message?: string };
      capabilityDiscovery?: {
        status?: string;
        emptySearchRounds?: number;
        maxEmptySearchRounds?: number;
        remainingEmptyRounds?: number;
      };
      planningObjective?: string;
    };
    assert.equal(payload.ok, false);
    assert.equal(payload.error?.code, 'capability_search_round_limit_exceeded');
    assert.match(payload.error?.message ?? '', /No search was executed/);
    assert.equal(payload.capabilityDiscovery?.status, 'closed');
    assert.equal(payload.capabilityDiscovery?.emptySearchRounds, 2);
    assert.equal(payload.capabilityDiscovery?.maxEmptySearchRounds, 2);
    assert.equal(payload.capabilityDiscovery?.remainingEmptyRounds, 0);
    assert.equal(typeof payload.planningObjective, 'string');
  }
  assert.ok(model.boundToolNameHistory.every((toolNames) =>
    toolNames.includes(RUN_SUPERVISOR_CAPABILITY_SEARCH_TOOL_NAME)));
  assert.ok(model.boundToolOptions.every((options) => options?.tool_choice === undefined));
});

test('a submitted plan submits once without a final ordinary-text reply', async (t) => {
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
  const model = new ScriptedSupervisorModel([{
    structuredOutput: {
      kind: 'plan',
      args: { tasks: submittedTasks },
    },
  }, {
    content: 'The plan has been submitted.',
  }]);

  const result = await createRunSupervisorAgent({ model }).invoke(
    supervisorInput(workspace),
  );

  assert.deepEqual(commandOnly(result), { action: 'execute_plan', tasks: submittedTasks });
  assert.equal(model.invocations.length, 1);
});

test('Supervisor keeps ordinary text invocation-private and does not retry', async (t) => {
  const workspace = await createWorkspace(t, {
    general: capabilityDocument({
      name: 'general',
      description: 'Handle ordinary tasks.',
      instructions: 'Complete the requested work.',
    }),
  });
  const model = new ScriptedSupervisorModel([{
    content: '开始执行计划任务：Apply the requested repository change and verify it。',
  }]);

  const result = await createRunSupervisorAgent({ model }).invoke(
    supervisorInput(workspace),
  );

  assert.ok('supervisorStatus' in result);
  if (!('supervisorStatus' in result)) assert.fail('expected a Supervisor no-command result');
  assert.equal(result.supervisorStatus, 'no_command');
  assert.equal(model.invocations.length, 1);
  assert.equal('messageUpdates' in result, false);
});

test('Supervisor can return bounded facts to Answer without submitting a plan', async (t) => {
  const workspace = await createWorkspace(t, {
    explore: capabilityDocument({
      name: 'explore',
      description: 'Investigate repositories.',
      instructions: 'Inspect files and report evidence.',
    }),
  });
  const model = new ScriptedSupervisorModel([{
    toolCalls: [{
      id: 'grep',
      name: RUN_SUPERVISOR_CAPABILITY_SEARCH_TOOL_NAME,
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

  const result = await createRunSupervisorAgent({ model })
    .invoke(supervisorInput(workspace));

  assert.deepEqual(commandOnly(result), {
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
  const model = new ScriptedSupervisorModel([
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

  const result = await createRunSupervisorAgent({ model }).invoke(
    supervisorInput(workspace),
  );

  assert.deepEqual(commandOnly(result), {
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

test('an invalid search input returns tool feedback instead of aborting Supervisor', async (t) => {
  const workspace = await createWorkspace(t, {
    general: capabilityDocument({
      name: 'general',
      description: 'Handle ordinary tasks.',
      instructions: 'Complete the requested work.',
    }),
  });
  const model = new ScriptedSupervisorModel([{
    toolCalls: [{
      id: 'invalid-search',
      name: RUN_SUPERVISOR_CAPABILITY_SEARCH_TOOL_NAME,
      args: { terms: ['x'.repeat(81)] },
    }],
  }, {
    structuredOutput: {
      kind: 'plan',
      args: {
        tasks: [{
          capability: 'general',
          task: 'Complete the ordinary task.',
        }],
      },
    },
  }]);

  const result = await createRunSupervisorAgent({ model }).invoke(
    supervisorInput(workspace),
  );

  assert.deepEqual(commandOnly(result), {
    action: 'execute_plan',
    tasks: [{
      capability: 'general',
      task: 'Complete the ordinary task.',
    }],
  });
  assert.ok(model.invocations[1]?.some((message) =>
    ToolMessage.isInstance(message)
    && message.tool_call_id === 'invalid-search'
    && message.status === 'error'
    && readMessageText(message).includes('did not match expected schema')));
});

test('Supervisor allows every search in one parallel disclosure round', async (t) => {
  const workspace = await createWorkspace(t, {
    general: capabilityDocument({
      name: 'general',
      description: 'Handle ordinary tasks.',
      instructions: 'Complete the requested work.',
    }),
  });
  const search = (id: string) => ({
    id,
    name: RUN_SUPERVISOR_CAPABILITY_SEARCH_TOOL_NAME,
    args: { terms: ['ordinary'] },
  });
  const model = new ScriptedSupervisorModel([
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

  const result = await createRunSupervisorAgent({ model }).invoke(
    supervisorInput(workspace),
  );

  assert.deepEqual(commandOnly(result), {
    action: 'execute_plan',
    tasks: [{
      capability: 'general',
      task: 'Complete the requested repository update.',
    }],
  });
  const successfulSearches = model.invocations[1]?.filter((message) =>
    message instanceof ToolMessage
    && message.name === RUN_SUPERVISOR_CAPABILITY_SEARCH_TOOL_NAME
    && message.status !== 'error') ?? [];
  assert.equal(successfulSearches.length, 4);
  assert.ok(successfulSearches.every((message) =>
    String(message.content).includes('"status":"open"')));
  assert.ok(successfulSearches.every((message) =>
    String(message.content).includes('"emptySearchRounds":0')));
  assert.ok(successfulSearches.every((message) =>
    String(message.content).includes('"status":"pending_parallel_batch"')));
  assert.equal(model.boundToolNameHistory[1]?.includes(
    RUN_SUPERVISOR_CAPABILITY_SEARCH_TOOL_NAME,
  ), true);
  assert.equal(model.boundToolOptions[1]?.tool_choice, undefined);
});

test('an empty workspace can return truthful facts to Answer', async (t) => {
  const workspace = await createWorkspace(t, {});
  const model = new ScriptedSupervisorModel([{
    structuredOutput: {
      kind: 'unavailable',
      args: {
        reason: 'The current workspace contains no Capability documents.',
        context: 'There are no registered Capability documents to execute browser automation.',
      },
    },
  }]);

  const result = await createRunSupervisorAgent({ model }).invoke(
    supervisorInput(workspace),
  );

  assert.equal(model.structuredOutputToolNames.size, 2);
  assert.equal(model.structuredOutputToolNames.has('plan'), true);
  assert.equal(model.structuredOutputToolNames.has('advance'), false);
  assert.ok(model.structuredOutputToolNames.has('unavailable'));
  assert.deepEqual(commandOnly(result), {
    action: 'unavailable',
    tasks: [],
  });
});

test('boundary mode returns tool feedback for an empty executable plan', async (t) => {
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
  const model = new ScriptedSupervisorModel([
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
        name: RUN_SUPERVISOR_CAPABILITY_SEARCH_TOOL_NAME,
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

  const result = await createRunSupervisorAgent({ model }).invoke(
    supervisorInput(workspace, {
      mode: 'boundary',
      activeDelegation: {
        delegationId: 'delegation-1',
        runId: 'run-1',
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
    }),
  );
  assert.deepEqual(commandOnly(result), {
    action: 'advance_plan',
    tasks: [{
      capability: 'general',
      task: 'Prepare the review from the completed research.',
    }],
  });
  assert.ok(model.invocations[1]?.some((message) =>
    ToolMessage.isInstance(message)
    && message.status === 'error'
    && readMessageText(message).includes('Array must contain at least 1 element')));
});

test('a boundary with an exhausted plan can still submit newly required work', async (t) => {
  const workspace = await createWorkspace(t, {
    general: capabilityDocument({
      name: 'general',
      description: 'Handle ordinary tasks.',
      instructions: 'Complete the requested work.',
    }),
  });
  const model = new ScriptedSupervisorModel([{
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

  const result = await createRunSupervisorAgent({ model }).invoke(
    supervisorInput(workspace, {
      mode: 'boundary',
      activeDelegation: {
        delegationId: 'delegation-1',
        runId: 'run-1',
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
  assert.deepEqual(commandOnly(result), {
    action: 'advance_plan',
    tasks: [{
      capability: 'general',
      task: 'Update the README section for issue #587.',
    }],
  });
});

test('boundary Supervisor continues without replacing the active task', async (t) => {
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
  const model = new ScriptedSupervisorModel([{
    toolCalls: [{
      id: 'continue-current',
      name: 'continue_current',
      args: {},
    }],
  }]);

  const result = await createRunSupervisorAgent({ model }).invoke(
    supervisorInput(workspace, {
      mode: 'boundary',
      activeDelegation: {
        delegationId: 'delegation-1',
        runId: 'run-1',
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

  assert.deepEqual(commandOnly(result), {
    action: 'continue_current',
    tasks: [],
  });
  assert.equal(model.invocations.length, 1);
});

test('entry Supervisor can request a user-owned choice with a structured question', async (t) => {
  const workspace = await createWorkspace(t, {
    general: capabilityDocument({
      name: 'general',
      description: 'Handle ordinary tasks.',
      instructions: 'Complete and verify the requested work.',
    }),
  });
  const model = new ScriptedSupervisorModel([{
    toolCalls: [{
      id: 'request-environment',
      name: 'request_user_input',
      args: { question: 'Should I deploy to production or staging?' },
    }],
  }]);

  const result = await createRunSupervisorAgent({ model }).invoke(
    supervisorInput(workspace, {
      userRequest: 'Deploy the service to production or staging; I will choose the target.',
    }),
  );

  assert.deepEqual(commandOnly(result), {
    action: 'user_input_required',
    tasks: [],
    userInputRequest: { question: 'Should I deploy to production or staging?' },
  });
  assert.equal(model.invocations.length, 1);
});

test('boundary Supervisor can stop for user confirmation with a structured question', async (t) => {
  const workspace = await createWorkspace(t, {
    general: capabilityDocument({
      name: 'general',
      description: 'Handle ordinary tasks.',
      instructions: 'Complete and verify the requested work.',
    }),
  });
  const model = new ScriptedSupervisorModel([{
    toolCalls: [{
      id: 'request-target-confirmation',
      name: 'request_user_input',
      args: { question: 'Should I review PR #663 instead?' },
    }],
  }]);

  const result = await createRunSupervisorAgent({ model }).invoke(
    supervisorInput(workspace, {
      mode: 'boundary',
      activeDelegation: {
        delegationId: 'delegation-review-662',
        runId: 'run-review-662',
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

  assert.deepEqual(commandOnly(result), {
    action: 'user_input_required',
    tasks: [],
    userInputRequest: { question: 'Should I review PR #663 instead?' },
  });
  assert.equal(model.invocations.length, 1);
});

test('boundary Supervisor exposes only boundary command actions', async (t) => {
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
  const model = new ScriptedSupervisorModel([{
    structuredOutput: {
      kind: 'advance',
      args: { tasks },
    },
  }]);

  const result = await createRunSupervisorAgent({ model }).invoke(
    supervisorInput(workspace, {
      mode: 'boundary',
      activeDelegation: {
        delegationId: 'delegation-1',
        runId: 'run-1',
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

  assert.deepEqual(commandOnly(result), { action: 'advance_plan', tasks });
  assert.equal(model.invocations.length, 1);
  assert.equal(model.boundToolNameHistory[0]?.includes('submit_plan'), false);
  assert.equal(model.boundToolNameHistory[0]?.includes('continue_current'), true);
  assert.equal(model.boundToolNameHistory[0]?.includes('advance_plan'), true);
  assert.equal(model.boundToolNameHistory[0]?.includes('complete_goal'), true);
});

test('oversized discovery is reported as supervisor_discovery_limit_reached', async (t) => {
  const workspace = await createWorkspace(t, {
    explore: capabilityDocument({
      name: 'explore',
      description: 'Investigate repositories.',
      instructions: 'Inspect files and report evidence.',
    }),
  });
  const model = new ScriptedSupervisorModel([{
    toolCalls: [{
      id: 'grep',
      name: RUN_SUPERVISOR_CAPABILITY_SEARCH_TOOL_NAME,
      args: { terms: ['investigate'] },
    }],
  }, { content: '' }]);

  await assert.rejects(
    createRunSupervisorAgent({
      model,
      maxDocumentReadBytes: 1,
    }).invoke(supervisorInput(workspace)),
    (error: unknown) =>
      error instanceof RunSupervisorAgentError
      && error.code === 'supervisor_discovery_limit_reached',
  );
});

test('oversized persisted disclosure drops documents and keeps routing metadata', async (t) => {
  const workspace = await createWorkspace(t, {
    general: capabilityDocument({
      name: 'general',
      description: 'Handle ordinary tasks.',
      instructions: 'Complete the requested work.',
    }),
    explore: capabilityDocument({
      name: 'explore',
      description: 'Investigate repositories.',
      instructions: 'EXPLORE_ONLY '.repeat(25),
    }),
    writer: capabilityDocument({
      name: 'writer',
      description: 'Write long reports.',
      instructions: 'WRITER_ONLY '.repeat(25),
    }),
  });
  const model = new ScriptedSupervisorModel([{
    structuredOutput: {
      kind: 'plan',
      args: {
        tasks: [{
          capability: 'general',
          task: 'Complete the requested work.',
        }],
      },
    },
  }]);
  const initialDisclosure = {
    ...createCapabilityDisclosureState({
      workspace,
      maxEmptySearchRounds: 2,
    }),
    disclosedCapabilityNames: ['general', 'explore', 'writer'],
    emptySearchRounds: 1,
  };

  const result = await createRunSupervisorAgent({
    model,
    maxDocumentReadBytes: 600,
  }).invoke(supervisorInput(workspace, {
    capabilityDisclosure: initialDisclosure,
  }));

  assert.deepEqual(commandOnly(result), {
    action: 'execute_plan',
    tasks: [{
      capability: 'general',
      task: 'Complete the requested work.',
    }],
  });
  assert.deepEqual(result.capabilityDisclosure, {
    ...initialDisclosure,
    disclosedCapabilityNames: [],
  });
  const invocationText = model.invocations[0]
    ?.map((message) => readMessageText(message))
    .join('\n') ?? '';
  assert.match(invocationText, /Handle ordinary tasks/);
  assert.doesNotMatch(invocationText, /Complete the requested work\.|EXPLORE_ONLY|WRITER_ONLY/);
});

test('Supervisor reports an incomplete result when it exits without a command', async (t) => {
  const workspace = await createWorkspace(t, {});
  const model = new ScriptedSupervisorModel([{
    content: 'The user needs to choose a target first.',
  }]);

  const result = await createRunSupervisorAgent({ model }).invoke(supervisorInput(workspace));
  assert.ok('supervisorStatus' in result);
  if (!('supervisorStatus' in result)) assert.fail('expected a Supervisor no-command result');
  assert.equal(result.supervisorStatus, 'no_command');
  assert.equal(result.reason, 'command_missing');
  assert.equal(model.invocations.length, 1);
  assert.equal('messageUpdates' in result, false);
});

test('Supervisor keeps search auto when closed exploration ends without a command', async (t) => {
  const workspace = await createWorkspace(t, {
    general: capabilityDocument({
      name: 'general',
      description: 'Handle ordinary workspace tasks.',
      instructions: 'Complete the requested work.',
    }),
  });
  const search = (id: string) => ({
    id,
    name: RUN_SUPERVISOR_CAPABILITY_SEARCH_TOOL_NAME,
    args: { terms: ['ordinary'] },
  });
  const model = new ScriptedSupervisorModel([
    { toolCalls: [search('search-1')] },
    { toolCalls: [search('search-2')] },
    { content: 'I have finished looking for capabilities.' },
  ]);

  const result = await createRunSupervisorAgent({ model }).invoke(supervisorInput(workspace, {
    userRequest: 'Current request.',
  }));

  assert.ok('supervisorStatus' in result);
  if (!('supervisorStatus' in result)) assert.fail('expected a Supervisor no-command result');
  assert.equal(result.supervisorStatus, 'no_command');
  assert.equal(result.reason, 'command_missing');
  assert.equal(model.invocations.length, 3);
  assert.equal(model.boundToolNameHistory[2]?.includes(
    RUN_SUPERVISOR_CAPABILITY_SEARCH_TOOL_NAME,
  ), true);
  assert.equal(model.boundToolOptions[2]?.tool_choice, undefined);
  assert.equal('messageUpdates' in result, false);
});

test('boundary Supervisor reports incomplete without accepting its delegation', async (t) => {
  const workspace = await createWorkspace(t, {
    general: capabilityDocument({
      name: 'general',
      description: 'Handle ordinary workspace tasks.',
      instructions: 'Complete the requested work.',
    }),
  });
  const model = new ScriptedSupervisorModel([
    { content: 'The current task should be handed over.' },
  ]);

  const result = await createRunSupervisorAgent({ model }).invoke(supervisorInput(workspace, {
    mode: 'boundary',
    userRequest: 'Finish the remaining request.',
    activeDelegation: {
      delegationId: 'delegation-1',
      runId: 'run-1',
      capability: 'explore',
      task: 'Inspect the repository.',
    },
  }));

  assert.ok('supervisorStatus' in result);
  if (!('supervisorStatus' in result)) assert.fail('expected a Supervisor no-command result');
  assert.equal(result.supervisorStatus, 'no_command');
  assert.equal(result.reason, 'command_missing');
  assert.equal('messageUpdates' in result, false);
});

test('Capability disclosure validates maxEmptySearchRounds', async (t) => {
  const workspace = await createWorkspace(t, {});
  assert.throws(
    () => createCapabilityDisclosureState({
      workspace,
      maxEmptySearchRounds: 0,
    }),
    /maxEmptySearchRounds must be a positive integer/,
  );
});

test('Supervisor Agent enforces a total timeout', async (t) => {
  const workspace = await createWorkspace(t, {});

  await assert.rejects(
    createRunSupervisorAgent({
      model: new SlowSupervisorModel({}),
      timeoutMs: 10,
    }).invoke(supervisorInput(workspace)),
    (error: unknown) =>
      error instanceof RunSupervisorAgentError
      && error.code === 'supervisor_timeout',
  );
});

test('Supervisor Agent rejects a structured result produced after timeout', async (t) => {
  const workspace = await createWorkspace(t, {});
  const model = new DelayedStructuredSupervisorModel([{
    structuredOutput: {
      kind: 'unavailable',
      args: {
        reason: 'The workspace is empty.',
        context: 'No Capability documents are available.',
      },
    },
  }]);

  await assert.rejects(
    createRunSupervisorAgent({
      model,
      timeoutMs: 10,
    }).invoke(supervisorInput(workspace)),
    (error: unknown) =>
      error instanceof RunSupervisorAgentError
      && error.code === 'supervisor_timeout',
  );
});


test('one Supervisor runner reads each invocation context in entry and boundary modes', async (t) => {
  const workspace = await createWorkspace(t, {});
  const model = new ScriptedSupervisorModel([
    { structuredOutput: { kind: 'unavailable', args: { reason: 'No execution available.', context: 'No capabilities.' } } },
    { toolCalls: [{ id: 'continue', name: 'continue_current', args: {} }] },
  ]);
  const runner = createRunSupervisorAgent({ model });
  const first = [{ id: 'host:pet', content: randomUUID() }];
  const second = [{ id: 'host:pet', content: randomUUID() }];
  // Invoke from a parent graph so this also verifies framework config propagation.
  const parent = new StateGraph(Annotation.Root({ result: Annotation<unknown>() }))
    .addNode('supervisor', async (_state, config) => ({
      result: await runner.invoke(supervisorInput(workspace), config),
    })).addEdge(START, 'supervisor').addEdge('supervisor', END).compile();
  await parent.invoke({}, { context: { systemPromptSections: first } });
  const config = { tags: [], context: { systemPromptSections: second } };
  await runner.invoke(supervisorInput(workspace, {
    mode: 'boundary', inputId: 'boundary-context-test',
    activeDelegation: { delegationId: 'context-child', runId: 'run-test', capability: 'general', task: 'Continue.' },
    latestAnnounce: { messageId: 'context-announce', completionReason: 'natural' },
  }), config);
  assert.equal(model.invocations.length, 2);
  for (const [index, common] of [first, second].entries()) {
    const message = model.invocations[index][0];
    assert.equal(message.text.split(common[0].content).length - 1, 1);
    assert.equal(message.text.includes((index === 0 ? second : first)[0].content), false);
  }
});
