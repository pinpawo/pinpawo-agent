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
  ToolMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { StructuredTool } from '@langchain/core/tools';
import {
  CAPABILITY_PLANNER_GLOB_SEARCH_TOOL_NAME,
  CAPABILITY_PLANNER_GREP_SEARCH_TOOL_NAME,
  CAPABILITY_PLANNER_VIEW_FILE_CHUNK_TOOL_NAME,
} from './capabilityPlannerFileExplorer';
import type { CapabilityDocumentWorkspace } from './capabilityDocumentWorkspace';
import {
  CapabilityPlannerAgentError,
  createCapabilityPlannerAgent,
} from './capabilityPlannerAgent';
import type { CapabilityPlannerInput } from './capabilityPlannerRunner';

type ScriptedToolCall = {
  id?: string;
  name: string;
  args: Record<string, unknown>;
};

type ScriptedStructuredOutput = {
  kind: 'next_task' | 'unavailable';
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
        parameters?: {
          properties?: {
            result?: { const?: unknown };
          };
        } & Record<string, unknown>;
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
    for (const entry of toolEntries) {
      const name = entry.function?.name;
      const parameters = entry.function?.parameters;
      const result = parameters?.properties?.result?.const;
      if (name && typeof result === 'string') {
        this.structuredOutputToolNames.set(result, name);
        this.structuredOutputSchemaReferences.push(
          ...collectJsonSchemaReferences(parameters),
        );
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
    userIntentContext: [
      '<user_request>',
      '<![CDATA[',
      'Research the repository and then prepare a review.',
      ']]>',
      '</user_request>',
    ].join('\n'),
    completedTasks: [],
    remainingPlan: [],
    latestHandoff: null,
    workspace,
    ...overrides,
  } as CapabilityPlannerInput;
}

function submitArgs(
  capabilityName: string,
) {
  return {
    result: 'next_task',
    next_task: {
      objective: 'Research the repository.',
      capability_intent: 'Repository exploration',
      capability_name: capabilityName,
      context_summary: null,
    },
    remaining_plan: [{
      objective: 'Prepare the review from the findings.',
      capability_intent: 'Review synthesis',
    }],
  };
}

test('Planner Agent explores CAPABILITY.md files and returns a structured current selection with an intent-only future tail', async (t) => {
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
        id: 'glob',
        name: CAPABILITY_PLANNER_GLOB_SEARCH_TOOL_NAME,
        args: {},
      }],
    },
    {
      toolCalls: [{
        id: 'grep',
        name: CAPABILITY_PLANNER_GREP_SEARCH_TOOL_NAME,
        args: { query: 'Research', path: 'explore/CAPABILITY.md' },
      }],
    },
    {
      structuredOutput: {
        kind: 'next_task',
        args: submitArgs('explore'),
      },
    },
  ]);

  const result = await createCapabilityPlannerAgent({
    model,
    maxIterations: 5,
  }).invoke(plannerInput(workspace));

  assert.deepEqual(model.boundToolNames.slice(0, 3), [
    CAPABILITY_PLANNER_GLOB_SEARCH_TOOL_NAME,
    CAPABILITY_PLANNER_GREP_SEARCH_TOOL_NAME,
    CAPABILITY_PLANNER_VIEW_FILE_CHUNK_TOOL_NAME,
  ]);
  assert.equal(model.structuredOutputToolNames.size, 2);
  assert.ok(model.structuredOutputToolNames.has('next_task'));
  assert.ok(model.structuredOutputToolNames.has('unavailable'));
  assert.ok(model.structuredOutputSchemaReferences.every(
    (reference) => reference.startsWith('#/$defs/'),
  ));
  assert.ok(model.boundToolOptions.length > 0);
  assert.ok(model.boundToolOptions.every(
    (options) => options.parallel_tool_calls === false,
  ));
  assert.equal(model.invocations.length, 3);
  assert.deepEqual(result, {
    result: 'next_task',
    next_task: {
      objective: 'Research the repository.',
      capability_intent: 'Repository exploration',
      capability_name: 'explore',
      context_summary: null,
    },
    remaining_plan: [{
      objective: 'Prepare the review from the findings.',
      capability_intent: 'Review synthesis',
    }],
  });
  assert.equal(
    'capability_name' in result.remaining_plan[0],
    false,
  );
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
        kind: 'next_task',
        args: {
          result: 'next_task',
          next_task: {
            objective: 'Inspect issue #473 and report the Planner Agent constraints.',
            capability_intent: 'Repository exploration',
            capability_name: 'explore',
            context_summary: 'Use the issue and repository as evidence.',
          },
          remaining_plan: [],
        },
      },
    },
  ]);

  const result = await createCapabilityPlannerAgent({
    model,
    maxIterations: 2,
  }).invoke(plannerInput(workspace));

  assert.equal(model.invocations.length, 2);
  assert.equal(result.result, 'next_task');
  assert.equal(
    result.next_task.objective,
    'Inspect issue #473 and report the Planner Agent constraints.',
  );
  assert.equal(result.remaining_plan.length, 0);
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
        kind: 'next_task',
        args: submitArgs('missing'),
      },
    },
    {
      structuredOutput: {
        kind: 'next_task',
        args: submitArgs('general'),
      },
    },
  ]);

  const result = await createCapabilityPlannerAgent({
    model,
    maxIterations: 6,
  }).invoke(plannerInput(workspace));

  assert.equal(result.result, 'next_task');
  assert.equal(result.next_task.capability_name, 'general');
  const feedback = model.invocations[1]?.find((message) =>
    message instanceof ToolMessage
    && message.tool_call_id === 'structured-1');
  assert.ok(feedback instanceof ToolMessage);
  assert.match(
    String(feedback.content),
    /capability_name.*does not match schema/is,
  );
});

test('an empty workspace can produce a truthful unavailable result', async (t) => {
  const workspace = await createWorkspace(t, {});
  const model = new ScriptedPlannerModel([{
    structuredOutput: {
      kind: 'unavailable',
      args: {
        result: 'unavailable',
        task: 'Publish a browser automation report.',
        reason: 'The current workspace contains no Capability documents.',
      },
    },
  }]);

  const result = await createCapabilityPlannerAgent({ model }).invoke(
    plannerInput(workspace),
  );

  assert.deepEqual(result, {
    result: 'unavailable',
    task: 'Publish a browser automation report.',
    reason: 'The current workspace contains no Capability documents.',
  });
});

test('boundary mode rejects answer and materializes remaining work with general', async (t) => {
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
        kind: 'next_task',
        args: {
          result: 'answer',
          next_task: null,
          remaining_plan: [],
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
        kind: 'next_task',
        args: {
          result: 'next_task',
          next_task: {
            objective: 'Prepare the review from the completed research.',
            capability_intent: 'Review synthesis',
            capability_name: 'general',
            context_summary: 'Use the accepted research handoff as evidence.',
          },
          remaining_plan: [],
        },
      },
    },
  ]);

  const result = await createCapabilityPlannerAgent({
    model,
    maxIterations: 5,
  }).invoke(
    plannerInput(workspace, {
      mode: 'boundary',
      completedTasks: [{
        objective: 'Research the repository.',
        result: 'The requested evidence was delivered; review synthesis remains.',
      }],
      latestHandoff: 'Research complete; prepare the review.',
      remainingPlan: [{
        objective: 'Prepare the review from the findings.',
        capabilityIntent: 'Review synthesis',
      }],
    }),
  );

  assert.equal(result.result, 'next_task');
  assert.equal(result.next_task.capability_name, 'general');
  assert.ok(model.invocations[1]?.some((message) =>
    message instanceof ToolMessage
    && message.tool_call_id === 'structured-1'));
});

test('document observation exhaustion is reported as planning_limit_reached, not unavailable', async (t) => {
  const workspace = await createWorkspace(t, {
    explore: capabilityDocument({
      name: 'explore',
      description: 'Investigate repositories.',
      instructions: 'Inspect files and report evidence.',
    }),
  });
  const model = new ScriptedPlannerModel([{
    toolCalls: [{
      id: 'glob',
      name: CAPABILITY_PLANNER_GLOB_SEARCH_TOOL_NAME,
      args: {},
    }],
  }]);

  await assert.rejects(
    createCapabilityPlannerAgent({
      model,
      maxObservationBytes: 1,
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
        id: 'glob-1',
        name: CAPABILITY_PLANNER_GLOB_SEARCH_TOOL_NAME,
        args: {},
      }],
    },
    {
      toolCalls: [{
        id: 'glob-2',
        name: CAPABILITY_PLANNER_GLOB_SEARCH_TOOL_NAME,
        args: {},
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
