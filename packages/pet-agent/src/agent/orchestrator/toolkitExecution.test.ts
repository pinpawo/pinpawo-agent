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
import { ToolkitRuntimeManager } from './toolkitRuntime';
import { createCapabilityExecutor } from './capabilityExecution';

async function invoke(params: {
  toolkit: AgentToolkit;
  args?: Record<string, unknown>;
  manager?: ToolkitRuntimeManager;
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
    toolkitRuntimeManager: params.manager,
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
      name: 'consumer', description: 'Consumer', runtime: 'shell',
      tools: [{ tool: staticTool, operation,
        prepareInput: (input, context) => {
          assert.equal(context.toolkitName, 'consumer');
          assert.deepEqual(context.runtimeIdentity, { clientId: 'host', instanceId: 'env' });
          const cwd = resolve(context.executionScope.workdir!, (input as { cwd: string }).cwd);
          steps.push(`prepare:${cwd}`);
          return { cwd };
        },
        review: { request: context => { steps.push(`review:${(context.input as { cwd: string }).cwd}`); return null; } },
      }],
    };
    const manager = new ToolkitRuntimeManager({ consumer: { runtimeType: 'shell', client, identity: { clientId: 'host', instanceId: 'env' } } });
    await invoke({ toolkit, manager, args: { cwd: 'subdir', toolkitName: 'forged' }, fullAccess });
    assert.deepEqual(steps, fullAccess
      ? ['prepare:/workspace/subdir', 'execute:/workspace/subdir']
      : ['prepare:/workspace/subdir', 'review:/workspace/subdir', 'execute:/workspace/subdir']);
    assert.equal(actualContext?.toolkitName, 'consumer');
    assert.strictEqual(actualContext?.toolkitRuntimes?.consumer, client);
    assert.equal(actualContext?.executionScope?.delegationId, 'delegation');
    assert.strictEqual(toolkit.tools[0].tool, staticTool);
    assert.strictEqual(toolkit.tools[0].operation, operation);
  });
}

test('one static Tool obtains its owning Toolkit client in overlapping executions', async () => {
  const seen = new Map<string, unknown>();
  const sharedTool = tool(async (_args, runtime) => {
    const context = runtime.context as SubagentRuntimeContext;
    await Promise.resolve();
    seen.set(context.toolkitName!, context.toolkitRuntimes?.[context.toolkitName!]);
    return 'done';
  }, { name: 'shared_action', description: 'Act.', schema: z.object({}) });
  const firstClient = {}, secondClient = {};
  const manager = new ToolkitRuntimeManager({
    first: { runtimeType: 'shell', client: firstClient, identity: { clientId: 'host', instanceId: 'one' } },
    second: { runtimeType: 'shell', client: secondClient, identity: { clientId: 'host', instanceId: 'two' } },
  });
  await Promise.all(['first', 'second'].map(name => invoke({
    toolkit: { name, description: name, runtime: 'shell', tools: [{ tool: sharedTool }] }, manager,
  })));
  assert.strictEqual(seen.get('first'), firstClient);
  assert.strictEqual(seen.get('second'), secondClient);
});

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
      assert.equal(context.executionScope.workdir, workdir);
      observed.push('prepare');
      return { cwd: context.executionScope.workdir };
    },
    review: { request: context => {
      assert.equal((context.input as { cwd: string }).cwd, workdir);
      observed.push('review');
      return null;
    } },
  }] } });
  assert.deepEqual(observed, ['prepare', 'review', 'execute']);
});

test('session grants retain URL origin semantics and cannot cross client, instance, Toolkit or workdir', async () => {
  let reviews = 0;
  let matcher: ToolAuthorizationMatcher | null = null;
  const staticTool = tool(() => 'done', { name: 'navigate', description: 'Navigate.', schema: z.object({}) });
  const makeToolkit = (name = 'browser'): AgentToolkit => ({ name, description: name, runtime: 'cdp', tools: [{ tool: staticTool,
    review: {
      authorization: { buildMatcher: () => urlOriginAuthorization('https://example.com/page') },
      request: ctx => { reviews += 1; matcher = ctx.authorizationMatcher ?? null; return null; },
    },
  }] });
  const manager = (clientId = 'host-1', instanceId = 'browser-1', name = 'browser') => new ToolkitRuntimeManager({
    [name]: { runtimeType: 'cdp', client: {}, identity: { clientId, instanceId } },
  });
  await invoke({ toolkit: makeToolkit(), manager: manager() });
  assert.equal(reviews, 1);
  assert.equal((matcher as unknown as ToolAuthorizationMatcher).type, 'url_origin');
  assert.equal((matcher as unknown as ToolAuthorizationMatcher).scope?.length, 64);
  const grants = [buildToolAuthorizationRecord({ toolName: 'navigate', matcher: matcher!, source: 'human' })];
  await invoke({ toolkit: makeToolkit(), manager: manager(), grants });
  assert.equal(reviews, 1, 'same trusted target reuses the grant');
  await invoke({ toolkit: makeToolkit(), manager: manager('host-2'), grants });
  await invoke({ toolkit: makeToolkit(), manager: manager('host-1', 'browser-2'), grants });
  await invoke({ toolkit: makeToolkit('other'), manager: manager('host-1', 'browser-1', 'other'), grants });
  await invoke({ toolkit: makeToolkit(), manager: manager(), workdir: '/elsewhere', grants });
  assert.equal(reviews, 5);
  const oldGrant = buildToolAuthorizationRecord({ toolName: 'navigate', matcher: urlOriginAuthorization('https://example.com')!, source: 'human' });
  await invoke({ toolkit: makeToolkit(), manager: manager(), grants: [oldGrant] });
  assert.equal(reviews, 6, 'unscoped historical grants fail closed');
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
        if (invalid) {
          assert.equal((result as { status?: string }).status, 'error');
          assert.match(String((result as { content?: unknown }).content), /value|number|string/);
        }
        return result;
      } finally { events.push('finally'); }
    } });
    const action = tool(({ value }, runtime) => {
      assert.equal((runtime.context as SubagentRuntimeContext).toolkitName, 'local');
      events.push(`execute:${value}`);
      return 'done';
    }, { name: 'action', description: 'Act.', schema: z.object({ value: z.string() }) });
    await invoke({ toolkit: { name: 'local', description: 'Local', tools: [{ tool: action }] },
      args: { value: invalid ? 42 : 'valid' }, middleware: [wrapped],
    });
    assert.deepEqual(events, invalid ? ['before', 'after', 'finally'] : ['before', 'execute:valid', 'after', 'finally']);
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
