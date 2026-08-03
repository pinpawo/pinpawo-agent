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
import type { StructuredTool } from '@langchain/core/tools';
import {
  CAPABILITY_PLANNER_GREP_SEARCH_TOOL_NAME,
  CAPABILITY_PLANNER_VIEW_FILE_CHUNK_TOOL_NAME,
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

class ScriptedPlannerModel extends BaseChatModel {
  readonly invocations: BaseMessage[][] = [];
  readonly boundToolNames: string[] = [];
  readonly boundToolOptions: Record<string, unknown>[] = [];
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

  bindTools(
    tools: StructuredTool[],
    options?: Record<string, unknown>,
  ) {
    const toolEntries = tools as unknown as Array<{
      name?: string;
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
      const name = entry.function?.name;
      const parameters = entry.function?.parameters;
      const kind = name === 'submit_plan'
        ? 'plan'
        : name === 'report_unavailable' ? 'unavailable' : null;
      if (name && kind) {
        this.structuredOutputToolNames.set(kind, name);
        this.structuredOutputSchemaReferences.push(
          ...collectJsonSchemaReferences(parameters),
        );
        const properties = parameters?.properties;
        const tasks = properties && typeof properties === 'object'
          ? (properties as Record<string, unknown>).tasks
          : null;
        const maxItems = tasks && typeof tasks === 'object'
          ? (tasks as Record<string, unknown>).maxItems
          : null;
        if (kind === 'plan' && typeof maxItems === 'number') {
          this.structuredOutputPlanLimits.push(maxItems);
        }
        const items = tasks && typeof tasks === 'object'
          ? (tasks as Record<string, unknown>).items
          : null;
        const itemProperties = items && typeof items === 'object'
          ? (items as Record<string, unknown>).properties
          : null;
        const capability = itemProperties && typeof itemProperties === 'object'
          ? (itemProperties as Record<string, unknown>).capability
          : null;
        const capabilityEnum = capability && typeof capability === 'object'
          ? (capability as Record<string, unknown>).enum
          : null;
        if (kind === 'plan' && Array.isArray(capabilityEnum)) {
          this.structuredOutputCapabilityEnums.push(
            capabilityEnum.filter((name): name is string => typeof name === 'string'),
          );
        }
      }
    }
    this.boundToolOptions.push({ ...options });
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
          args: response.structuredOutput.args,
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
  return {
    mode: 'entry',
    messages: [
      new HumanMessage('Research the repository and then prepare a review.'),
    ],
    completedTask: null,
    remainingPlan: [],
    workspace,
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
      toolCalls: [{
        id: 'view',
        name: CAPABILITY_PLANNER_VIEW_FILE_CHUNK_TOOL_NAME,
        args: { path: 'explore/CAPABILITY.md' },
      }],
    },
    {
      structuredOutput: {
        kind: 'plan',
        args: submitArgs('explore'),
      },
    },
  ]);

  const result = await createCapabilityPlannerAgent({
    model,
    maxIterations: 5,
  }).invoke(plannerInput(workspace));

  assert.deepEqual(model.boundToolNames.slice(0, 2), [
    CAPABILITY_PLANNER_GREP_SEARCH_TOOL_NAME,
    CAPABILITY_PLANNER_VIEW_FILE_CHUNK_TOOL_NAME,
  ]);
  assert.equal(model.structuredOutputToolNames.size, 1);
  assert.ok(model.structuredOutputToolNames.has('plan'));
  assert.equal(model.structuredOutputToolNames.has('unavailable'), false);
  assert.deepEqual(model.structuredOutputSchemaReferences, []);
  assert.deepEqual(model.structuredOutputPlanLimits, [24]);
  assert.deepEqual(model.structuredOutputCapabilityEnums, [['explore', 'general']]);
  assert.ok(model.boundToolOptions.length > 0);
  assert.ok(model.boundToolOptions.every(
    (options) => options.parallel_tool_calls === false,
  ));
  assert.equal(model.invocations.length, 3);
  assert.equal(model.invocations.flat().some((message) =>
    message._getType() === 'system'
    && String(message.content).includes(workspace.rootPath)), false);
  assert.ok(model.invocations[0]?.some((message) =>
    message instanceof HumanMessage
    && message.content === 'Research the repository and then prepare a review.'));
  assert.deepEqual(result, {
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
        id: 'view',
        name: CAPABILITY_PLANNER_VIEW_FILE_CHUNK_TOOL_NAME,
        args: { path: 'explore/CAPABILITY.md', startLine: 1, endLine: 20 },
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

  const result = await createCapabilityPlannerAgent({
    model,
    maxIterations: 2,
  }).invoke(plannerInput(workspace));

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
        args: submitArgs('general'),
      },
    },
  ]);

  const result = await createCapabilityPlannerAgent({
    model,
    maxIterations: 6,
  }).invoke(plannerInput(workspace));

  assert.ok('tasks' in result);
  assert.equal('tasks' in result ? result.tasks[0]?.capability : null, 'general');
  const feedback = model.invocations[1]?.find((message) =>
    message instanceof ToolMessage
    && message.tool_call_id === 'structured-1');
  assert.ok(feedback instanceof ToolMessage);
  assert.match(
    String(feedback.content),
    /capability.*does not match schema/is,
  );
});

test('an empty workspace can produce a truthful unavailable result', async (t) => {
  const workspace = await createWorkspace(t, {});
  const model = new ScriptedPlannerModel([{
    structuredOutput: {
      kind: 'unavailable',
      args: {
        task: 'Publish a browser automation report.',
        reason: 'The current workspace contains no Capability documents.',
      },
    },
  }]);

  const result = await createCapabilityPlannerAgent({ model }).invoke(
    plannerInput(workspace),
  );

  assert.equal(model.structuredOutputToolNames.size, 1);
  assert.equal(model.structuredOutputToolNames.has('plan'), false);
  assert.ok(model.structuredOutputToolNames.has('unavailable'));
  assert.deepEqual(result, {
    task: 'Publish a browser automation report.',
    reason: 'The current workspace contains no Capability documents.',
  });
});

test('boundary mode rejects answer and materializes remaining work with general', async (t) => {
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
        id: 'view-general',
        name: CAPABILITY_PLANNER_VIEW_FILE_CHUNK_TOOL_NAME,
        args: { path: 'general/CAPABILITY.md', startLine: 1, endLine: 20 },
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

  const result = await createCapabilityPlannerAgent({
    model,
    maxIterations: 5,
  }).invoke(
    plannerInput(workspace, {
      mode: 'boundary',
      messages: [
        new HumanMessage('Research the repository and then prepare a review.'),
        new AIMessage('Next I will research the repository.'),
        new AIMessage(fullHandoff),
      ],
      completedTask: 'Research the repository.',
      remainingPlan: [{
        capability: 'general',
        task: 'Prepare the review from the findings.',
      }],
    }),
  );

  assert.ok('tasks' in result);
  assert.equal('tasks' in result ? result.tasks[0]?.capability : null, 'general');
  assert.deepEqual(model.structuredOutputCapabilityEnums, [['general', 'explore']]);
  assert.ok(model.invocations[0]?.some((message) =>
    message instanceof AIMessage && message.content === fullHandoff));
  assert.ok(model.invocations[0]?.some((message) =>
    message instanceof HumanMessage
    && String(message.content).includes('<planning_state>')));
  assert.match(
    model.invocations[0]?.map((message) => String(message.content)).join('\n') ?? '',
    /Final constraint: preserve the public API/,
  );
  assert.ok(model.invocations[1]?.some((message) =>
    message instanceof ToolMessage
    && message.tool_call_id === 'structured-1'));
});

test('document read exhaustion is reported as planning_limit_reached, not unavailable', async (t) => {
  const workspace = await createWorkspace(t, {
    explore: capabilityDocument({
      name: 'explore',
      description: 'Investigate repositories.',
      instructions: 'Inspect files and report evidence.',
    }),
  });
  const model = new ScriptedPlannerModel([{
    toolCalls: [{
      id: 'view',
      name: CAPABILITY_PLANNER_VIEW_FILE_CHUNK_TOOL_NAME,
      args: { path: 'explore/CAPABILITY.md' },
    }],
  }]);

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

test('model iteration exhaustion is an explicit planning limit', async (t) => {
  const workspace = await createWorkspace(t, {});
  const model = new ScriptedPlannerModel([
    {
      toolCalls: [{
        id: 'grep-1',
        name: CAPABILITY_PLANNER_GREP_SEARCH_TOOL_NAME,
        args: { query: 'general' },
      }],
    },
    {
      toolCalls: [{
        id: 'grep-2',
        name: CAPABILITY_PLANNER_GREP_SEARCH_TOOL_NAME,
        args: { query: 'general' },
      }],
    },
  ]);

  await assert.rejects(
    createCapabilityPlannerAgent({
      model,
      maxIterations: 2,
    }).invoke(plannerInput(workspace)),
    (error: unknown) =>
      error instanceof CapabilityPlannerAgentError
      && error.code === 'planning_limit_reached',
  );
  assert.equal(model.invocations.length, 2);
});

test('natural language completion without a structured result is rejected', async (t) => {
  const workspace = await createWorkspace(t, {});
  const model = new ScriptedPlannerModel([{ content: 'The plan is ready.' }]);

  await assert.rejects(
    createCapabilityPlannerAgent({ model }).invoke(plannerInput(workspace)),
    (error: unknown) =>
      error instanceof CapabilityPlannerAgentError
      && error.code === 'submission_required',
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
        result: 'unavailable',
        task: 'Perform an unsupported operation.',
        reason: 'The workspace is empty.',
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
