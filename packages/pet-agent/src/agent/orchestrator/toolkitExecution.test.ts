import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve } from 'node:path';
import { HumanMessage, ToolMessage, type ToolCall } from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { createMiddleware, FakeToolCallingModel, type AnyAgentMiddleware } from 'langchain';
import { createSubagent } from '../../subagent/createSubagent';
import { subagentRuntimeContextSchema } from '../../subagent/runtimeContext';
import { z } from 'zod';
import type { AgentToolkit, ModelInputModality } from '../../types/toolkit';
import type { SubagentRuntimeContext } from '../../types/subagent';
import { defineInstructionDocument } from '../../types/capability';
import { buildToolAuthorizationRecord, urlOriginAuthorization, type ToolAuthorizationMatcher, type ToolAuthorizationRecord } from '../../autoReview/reviewAuthorizations';
import { compileAgentRegistry } from './registry';
import { createCapabilityExecutor } from './capabilityExecution';

async function invoke(params: {
  toolkit: AgentToolkit;
  args?: Record<string, unknown>;
  workdir?: string;
  grants?: ToolAuthorizationRecord[];
  fullAccess?: boolean;
  middleware?: AnyAgentMiddleware[];
  signal?: AbortSignal;
  modelInputModalities?: readonly ModelInputModality[];
  toolCalls?: (ToolCall & { id: string })[][];
}) {
  const registry = compileAgentRegistry({ toolkits: [params.toolkit], capabilities: [{
    name: 'execute', description: 'Execute a tool.', uses: [params.toolkit.name],
    instructions: defineInstructionDocument({ content: 'Execute the requested tool.' }),
  }] });
  return createCapabilityExecutor({
    modelInputModalities: params.modelInputModalities,
    runSubagent: params.middleware ? input => createSubagent({ ...input,
      middleware: [...(input.middleware ?? []), ...params.middleware!],
    }) : undefined,
    models: { act: new FakeToolCallingModel({ toolCalls: params.toolCalls ?? [
      [{ id: 'call', name: params.toolkit.tools[0].tool.name, args: params.args ?? {} }], [],
    ] }) },
  })({
    capability: registry.capabilities[0],
    delegation: { id: 'delegation', runId: 'run', taskId: 'task', mode: 'initial',
      userRequest: 'Execute', task: 'Execute', briefing: 'Use the tool.' },
    history: [new HumanMessage({ id: 'user', content: 'Execute' })],
  }, {
    runnableConfig: { context: { workdir: params.workdir ?? '/workspace' }, configurable: { thread_id: 'thread' }, signal: params.signal },
    review: { authorizations: params.grants ?? [], hostCapabilities: { humanReview: false, sessionAuthorization: true },
      ...(params.fullAccess ? { policy: { mode: 'full_access' as const } } : {}),
    },
  });
}

for (const fullAccess of [false, true]) {
  test(`input preparation resolves targets before review and execution (full access: ${fullAccess})`, async () => {
    const steps: string[] = [];
    let actualContext: SubagentRuntimeContext | undefined;
    const client = { execute: async () => 'executed' };
    const staticTool = tool(async ({ cwd }, runtime) => {
      steps.push(`execute:${cwd}`);
      actualContext = runtime.context as SubagentRuntimeContext;
      return 'done';
    }, { name: 'action', description: 'Act.', schema: z.object({ cwd: z.string() }) });
    const operation = { title: 'Action' };
    const toolkit: AgentToolkit = {
      name: 'consumer', description: 'Consumer',
      tools: [{ tool: staticTool, operation,
        prepareInput: (input, context) => {
          assert.equal(context.toolkitName, 'consumer');
          const cwd = resolve(context.context.workdir as string, (input as { cwd: string }).cwd);
          steps.push(`prepare:${cwd}`);
          return { cwd };
        },
        review: { request: context => { steps.push(`review:${(context.input as { cwd: string }).cwd}`); return null; } },
      }],
    };
    await invoke({ toolkit, args: { cwd: 'subdir', toolkitName: 'forged' }, fullAccess });
    assert.deepEqual(steps, fullAccess
      ? ['prepare:/workspace/subdir', 'execute:/workspace/subdir']
      : ['prepare:/workspace/subdir', 'review:/workspace/subdir', 'execute:/workspace/subdir']);
    assert.equal(actualContext?.executionScope?.delegationId, 'delegation');
    assert.strictEqual(toolkit.tools[0].tool, staticTool);
    assert.strictEqual(toolkit.tools[0].operation, operation);
  });
}

for (const unavailableToolName of ['read_image', 'unknown_tool']) {
  test(`Capability execution recovers from unavailable tool ${unavailableToolName}`, async () => {
    let imageExecutions = 0;
    let textExecutions = 0;
    const image = tool(() => {
      imageExecutions += 1;
      return 'Image output must not reach a text-only model.';
    }, { name: 'read_image', description: 'Read an image.', schema: z.object({}) });
    const text = tool(() => {
      textExecutions += 1;
      return 'Recovered using a supported tool.';
    }, { name: 'read_text', description: 'Read text.', schema: z.object({}) });
    const result = await invoke({
      toolkit: { name: 'inspect', description: 'Read files.', tools: [
        { tool: image, requiresInputModalities: ['image'] },
        { tool: text },
      ] },
      modelInputModalities: ['text'],
      toolCalls: [
        [{ id: 'unavailable-call', name: unavailableToolName, args: {} }],
        [{ id: 'recovery-call', name: 'read_text', args: {} }],
        [],
      ],
    });

    assert.equal(result.status, 'returned');
    assert.ok(result.delivery?.text);
    assert.equal(imageExecutions, 0);
    assert.equal(textExecutions, 1, 'A model must be able to choose a supported tool after the error.');
    const feedback = result.privateMessages.filter(ToolMessage.isInstance);
    assert.equal(feedback.length, 2);
    assert.equal(feedback[0].tool_call_id, 'unavailable-call');
    assert.equal(feedback[0].name, unavailableToolName);
    assert.equal(feedback[0].status, 'error');
    assert.ok(typeof feedback[0].content === 'string' && feedback[0].content.length > 0);
    assert.equal(feedback[1].tool_call_id, 'recovery-call');
    assert.equal(feedback[1].name, 'read_text');
    assert.equal(feedback[1].status, 'success');
  });
}

test('prepared input, review and Tool execution retain literal workdir whitespace', async () => {
  const workdir = resolve('/workspace with spaces ');
  const parsed = subagentRuntimeContextSchema.parse({
    workdir,
    executionScope: { threadId: 'thread', taskId: 'task', runId: 'run', delegationId: 'delegation', workdir },
  });
  assert.equal(parsed.workdir, workdir);
  assert.equal(parsed.executionScope?.workdir, workdir);
  const observed: string[] = [];
  const action = tool(({ cwd }, runtime) => {
    const context = runtime.context as SubagentRuntimeContext;
    assert.equal(cwd, workdir);
    assert.equal(context.workdir, workdir);
    assert.equal(context.executionScope?.workdir, workdir);
    observed.push('execute');
    return 'done';
  }, { name: 'action', description: 'Act in the exact supplied directory.', schema: z.object({ cwd: z.string() }) });
  await invoke({ workdir, toolkit: { name: 'local', description: 'Local', tools: [{
    tool: action,
    prepareInput: (_input, context) => {
      assert.equal(context.context.workdir, workdir);
      observed.push('prepare');
      return { cwd: context.context.workdir };
    },
    review: { request: context => {
      assert.equal((context.input as { cwd: string }).cwd, workdir);
      observed.push('review');
      return null;
    } },
  }] } });
  assert.deepEqual(observed, ['prepare', 'review', 'execute']);
});

test('session grants depend on Tool parameters and preserve URL origin semantics across Host contexts', async () => {
  let reviews = 0;
  let matcher: ToolAuthorizationMatcher | null = null;
  const action = tool(() => 'done', { name: 'navigate', description: 'Navigate.', schema: z.object({ url: z.string() }) });
  const toolkit: AgentToolkit = { name: 'browser', description: 'Browser', tools: [{ tool: action,
    review: {
      authorization: { buildMatcher: ({ input }) => urlOriginAuthorization((input as { url: string }).url) },
      request: ctx => { reviews += 1; matcher = ctx.authorizationMatcher ?? null; return null; },
    },
  }] };
  await invoke({ toolkit, args: { url: 'https://example.com/page' } });
  assert.equal(reviews, 1);
  assert.equal((matcher as unknown as ToolAuthorizationMatcher).type, 'url_origin');
  assert.equal('scope' in matcher!, false);
  const grants = [buildToolAuthorizationRecord({ toolName: 'navigate', matcher: matcher!, source: 'human' })];
  await invoke({ toolkit, args: { url: 'https://example.com/other' }, workdir: '/elsewhere', grants });
  assert.equal(reviews, 1);
  await invoke({ toolkit, args: { url: 'https://other.example/page' }, grants });
  assert.equal(reviews, 2);
});

test('input preparation failures prevent review and execution', async () => {
  let calls = 0;
  const toolkit: AgentToolkit = { name: 'local', description: 'Local', tools: [{
    tool: tool(() => { calls += 1; return 'done'; }, { name: 'action', description: 'Act.', schema: z.object({}) }),
    prepareInput: () => { throw new Error('workdir required'); },
    review: { request: () => { calls += 1; return null; } },
  }] };
  await assert.rejects(invoke({ toolkit }), /workdir required/);
  assert.equal(calls, 0);
});

for (const invalid of [false, true]) {
  test(`custom Tool middleware still surrounds the trusted execution boundary (invalid: ${invalid})`, async () => {
    const events: string[] = [];
    const wrapped = createMiddleware({ name: 'CustomWrap', wrapToolCall: async (request, handler) => {
      events.push('before');
      try {
        const result = await handler(request);
        events.push('after');
        return result;
      } finally { events.push('finally'); }
    } });
    const action = tool(({ value }, runtime) => {
      events.push(`execute:${value}`);
      return 'done';
    }, { name: 'action', description: 'Act.', schema: z.object({ value: z.string() }) });
    const result = invoke({ toolkit: { name: 'local', description: 'Local', tools: [{ tool: action }] },
      args: { value: invalid ? 42 : 'valid' }, middleware: [wrapped],
    });
    if (invalid) await assert.rejects(result, /Received tool input did not match expected schema/);
    else await result;
    assert.deepEqual(events, invalid ? ['before', 'finally'] : ['before', 'execute:valid', 'after', 'finally']);
  });
}

test('the final execution boundary propagates abort even when the tool returns normally', async () => {
  const controller = new AbortController();
  let started = false;
  let wrapped = false;
  const action = tool(() => {
    started = true;
    controller.abort(new Error('cancelled by host'));
    return 'should not be reported as success';
  }, { name: 'action', description: 'Act.', schema: z.object({}) });
  await assert.rejects(invoke({
    toolkit: { name: 'local', description: 'Local', tools: [{ tool: action }] },
    signal: controller.signal,
    middleware: [createMiddleware({ name: 'OuterWrapper', wrapToolCall: async (request, handler) => {
      wrapped = true;
      return handler(request);
    } })],
  }), /cancelled by host|Abort/);
  assert.equal(started, true);
  assert.equal(wrapped, true);
});

test('native Tool execution reports invalid arguments and lets the model correct them', async () => {
  let calls = 0;
  const action = tool(({ value }) => { calls += 1; return value; }, {
    name: 'action', description: 'Act.', schema: z.object({ value: z.string() }),
  });
  const result = await invoke({ toolkit: { name: 'example', description: 'Example', tools: [{ tool: action }] }, toolCalls: [
    [{ id: 'invalid', name: 'action', args: { value: 42 } }],
    [{ id: 'corrected', name: 'action', args: { value: 'valid' } }], [],
  ] });
  assert.equal(calls, 1);
  const messages = result.privateMessages.filter(ToolMessage.isInstance);
  assert.equal(messages[0].tool_call_id, 'invalid');
  assert.match(String(messages[0].content), /expected schema|Expected string/);
  assert.equal(messages[1].content, 'valid');
});

for (const changed of [false, true]) {
  test(`restored call approval is tied to effective arguments (changed: ${changed})`, async () => {
    const { createAgent } = await import('langchain');
    const { resolveToolkitExecution } = await import('./subagentDispatch');
    const { stableToolCallHash } = await import('./toolCallMessages');
    let reviews = 0;
    const action = tool(({ path }) => path, { name: 'action', description: 'Act.', schema: z.object({ path: z.string() }) });
    const oldCall = { id: 'same-id', name: 'action', args: { path: '/before' } };
    const call = { ...oldCall, args: { path: changed ? '/after' : '/before' } };
    const model = new FakeToolCallingModel({ toolCalls: [[call], []] });
    const resources = await resolveToolkitExecution([{ name: 'example', description: 'Example', tools: [{
      tool: action, review: { request: () => { reviews += 1; return null; } },
    }] }], undefined, { models: { act: model }, messages: [] });
    const agent = createAgent({ model, tools: resources.tools, middleware: resources.middleware });
    const restoredState = { messages: [new HumanMessage('Execute')], toolkitReviewApprovals: {
      [`tool-review:action:same-id:${stableToolCallHash(oldCall)}`]: true,
    } };
    await agent.invoke(restoredState);
    assert.equal(reviews, changed ? 1 : 0);
  });
}
