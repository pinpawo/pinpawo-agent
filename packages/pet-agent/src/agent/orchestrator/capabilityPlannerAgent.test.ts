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
  CAPABILITY_PLANNER_SUBMIT_TOOL_NAME,
  CapabilityPlannerAgentError,
  createCapabilityPlannerAgent,
} from './capabilityPlannerAgent';
import type { CapabilityPlannerInput } from './capabilityPlannerRunner';

type ScriptedToolCall = {
  id: string;
  name: string;
  args: Record<string, unknown>;
};

class ScriptedPlannerModel extends BaseChatModel {
  readonly invocations: BaseMessage[][] = [];
  readonly boundToolNames: string[] = [];
  #responseIndex = 0;

  constructor(
    private readonly responses: ReadonlyArray<{
      content?: string;
      toolCalls?: readonly ScriptedToolCall[];
    }>,
  ) {
    super({});
  }

  _llmType() {
    return 'scripted-capability-planner';
  }

  bindTools(tools: StructuredTool[]) {
    this.boundToolNames.splice(
      0,
      this.boundToolNames.length,
      ...tools.map(({ name }) => name),
    );
    return this;
  }

  async _generate(messages: BaseMessage[]) {
    this.invocations.push([...messages]);
    const response = this.responses[this.#responseIndex] ?? { content: 'done' };
    this.#responseIndex += 1;
    const message = new AIMessage({
      content: response.content ?? '',
      tool_calls: response.toolCalls?.map((call) => ({
        ...call,
        type: 'tool_call' as const,
      })),
    });
    return { generations: [{ message, text: String(message.content) }] };
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
    userIntentContext: 'Research the repository and then prepare a review.',
    completedTasks: [],
    remainingPlan: [],
    latestHandoff: null,
    workspace,
    ...overrides,
  } as CapabilityPlannerInput;
}

function submitArgs(
  workspace: CapabilityDocumentWorkspace,
  capabilityName: string,
) {
  return {
    registry_digest: workspace.registryDigest,
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

test('Planner Agent explores CAPABILITY.md files and submits current selection with an intent-only future tail', async (t) => {
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
      toolCalls: [{
        id: 'submit',
        name: CAPABILITY_PLANNER_SUBMIT_TOOL_NAME,
        args: submitArgs(workspace, 'explore'),
      }],
    },
  ]);

  const result = await createCapabilityPlannerAgent({
    model,
    maxIterations: 5,
  }).invoke(plannerInput(workspace));

  assert.deepEqual(model.boundToolNames, [
    CAPABILITY_PLANNER_GLOB_SEARCH_TOOL_NAME,
    CAPABILITY_PLANNER_GREP_SEARCH_TOOL_NAME,
    CAPABILITY_PLANNER_VIEW_FILE_CHUNK_TOOL_NAME,
    CAPABILITY_PLANNER_SUBMIT_TOOL_NAME,
  ]);
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

test('direct mode rejects task mutation and lets the model correct the submission', async (t) => {
  const workspace = await createWorkspace(t, {
    explore: capabilityDocument({
      name: 'explore',
      description: 'Investigate repositories.',
      instructions: 'Inspect files and report evidence.',
    }),
  });
  const pendingTask = {
    task: 'Inspect issue #473.',
    contextSummary: 'Focus on Planner Agent constraints.',
  };
  const model = new ScriptedPlannerModel([
    {
      toolCalls: [{
        id: 'view',
        name: CAPABILITY_PLANNER_VIEW_FILE_CHUNK_TOOL_NAME,
        args: { path: 'explore/CAPABILITY.md', startLine: 1, endLine: 20 },
      }],
    },
    {
      toolCalls: [{
        id: 'invalid-submit',
        name: CAPABILITY_PLANNER_SUBMIT_TOOL_NAME,
        args: {
          registry_digest: workspace.registryDigest,
          result: 'next_task',
          next_task: {
            objective: 'Rewrite issue #473.',
            capability_intent: 'Repository exploration',
            capability_name: 'explore',
            context_summary: pendingTask.contextSummary,
          },
          remaining_plan: [],
        },
      }],
    },
    {
      toolCalls: [{
        id: 'valid-submit',
        name: CAPABILITY_PLANNER_SUBMIT_TOOL_NAME,
        args: {
          registry_digest: workspace.registryDigest,
          result: 'next_task',
          next_task: {
            objective: pendingTask.task,
            capability_intent: 'Repository exploration',
            capability_name: 'explore',
            context_summary: pendingTask.contextSummary,
          },
          remaining_plan: [],
        },
      }],
    },
  ]);

  const result = await createCapabilityPlannerAgent({
    model,
    maxIterations: 5,
  }).invoke(plannerInput(workspace, {
    mode: 'direct',
    pendingTask,
  }));

  assert.equal(result.result, 'next_task');
  assert.equal(result.next_task.objective, pendingTask.task);
  assert.equal(result.next_task.context_summary, pendingTask.contextSummary);
  const correctionInput = model.invocations[2] ?? [];
  const mutationError = correctionInput.find((message) =>
    message instanceof ToolMessage
    && typeof message.content === 'string'
    && message.content.includes('direct_task_mutation'));
  assert.ok(mutationError);
});

test('an unknown or unobserved Capability returns tool feedback and can be repaired in-loop', async (t) => {
  const workspace = await createWorkspace(t, {
    general: capabilityDocument({
      name: 'general',
      description: 'Handle ordinary tasks.',
      instructions: 'Complete the requested work.',
    }),
  });
  const model = new ScriptedPlannerModel([
    {
      toolCalls: [{
        id: 'unknown-submit',
        name: CAPABILITY_PLANNER_SUBMIT_TOOL_NAME,
        args: submitArgs(workspace, 'missing'),
      }],
    },
    {
      toolCalls: [{
        id: 'unobserved-submit',
        name: CAPABILITY_PLANNER_SUBMIT_TOOL_NAME,
        args: submitArgs(workspace, 'general'),
      }],
    },
    {
      toolCalls: [{
        id: 'view',
        name: CAPABILITY_PLANNER_VIEW_FILE_CHUNK_TOOL_NAME,
        args: { path: 'general/CAPABILITY.md', startLine: 1, endLine: 20 },
      }],
    },
    {
      toolCalls: [{
        id: 'valid-submit',
        name: CAPABILITY_PLANNER_SUBMIT_TOOL_NAME,
        args: submitArgs(workspace, 'general'),
      }],
    },
  ]);

  const result = await createCapabilityPlannerAgent({
    model,
    maxIterations: 6,
  }).invoke(plannerInput(workspace));

  assert.equal(result.result, 'next_task');
  assert.equal(result.next_task.capability_name, 'general');
  assert.ok(model.invocations[1]?.some((message) =>
    message instanceof ToolMessage
    && typeof message.content === 'string'
    && message.content.includes('unknown_capability')));
  assert.ok(model.invocations[2]?.some((message) =>
    message instanceof ToolMessage
    && typeof message.content === 'string'
    && message.content.includes('capability_not_observed')));
});

test('an empty workspace can produce a truthful unavailable result', async (t) => {
  const workspace = await createWorkspace(t, {});
  const model = new ScriptedPlannerModel([{
    toolCalls: [{
      id: 'unavailable',
      name: CAPABILITY_PLANNER_SUBMIT_TOOL_NAME,
      args: {
        registry_digest: workspace.registryDigest,
        result: 'unavailable',
        task: 'Publish a browser automation report.',
        reason: 'The current workspace contains no Capability documents.',
      },
    }],
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

test('a non-empty workspace cannot be declared unavailable before document exploration', async (t) => {
  const workspace = await createWorkspace(t, {
    general: capabilityDocument({
      name: 'general',
      description: 'Handle ordinary tasks.',
      instructions: 'Complete the requested work.',
    }),
  });
  const unavailable = {
    registry_digest: workspace.registryDigest,
    result: 'unavailable',
    task: 'Perform an unsupported specialist operation.',
    reason: 'No Capability covers the operation.',
  };
  const model = new ScriptedPlannerModel([
    {
      toolCalls: [{
        id: 'premature-unavailable',
        name: CAPABILITY_PLANNER_SUBMIT_TOOL_NAME,
        args: unavailable,
      }],
    },
    {
      toolCalls: [{
        id: 'view',
        name: CAPABILITY_PLANNER_VIEW_FILE_CHUNK_TOOL_NAME,
        args: { path: 'general/CAPABILITY.md', startLine: 1, endLine: 20 },
      }],
    },
    {
      toolCalls: [{
        id: 'verified-unavailable',
        name: CAPABILITY_PLANNER_SUBMIT_TOOL_NAME,
        args: unavailable,
      }],
    },
  ]);

  const result = await createCapabilityPlannerAgent({ model }).invoke(
    plannerInput(workspace),
  );

  assert.equal(result.result, 'unavailable');
  assert.ok(model.invocations[1]?.some((message) =>
    message instanceof ToolMessage
    && typeof message.content === 'string'
    && message.content.includes('capability_not_observed')));
});

test('boundary mode can finish with answer after accepted handoff facts satisfy the goal', async (t) => {
  const workspace = await createWorkspace(t, {
    general: capabilityDocument({
      name: 'general',
      description: 'Handle ordinary tasks.',
      instructions: 'Complete the requested work.',
    }),
  });
  const model = new ScriptedPlannerModel([{
    toolCalls: [{
      id: 'answer',
      name: CAPABILITY_PLANNER_SUBMIT_TOOL_NAME,
      args: {
        registry_digest: workspace.registryDigest,
        result: 'answer',
        next_task: null,
        remaining_plan: [],
      },
    }],
  }]);

  const result = await createCapabilityPlannerAgent({ model }).invoke(
    plannerInput(workspace, {
      mode: 'boundary',
      completedTasks: [{
        objective: 'Research the repository.',
        result: 'The requested evidence and conclusion were delivered.',
      }],
      latestHandoff: 'Research complete.',
      remainingPlan: [],
    }),
  );

  assert.deepEqual(result, {
    result: 'answer',
    next_task: null,
    remaining_plan: [],
  });
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

test('natural language completion without submit_capability_plan is rejected', async (t) => {
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
