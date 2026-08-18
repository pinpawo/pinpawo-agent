import assert from 'node:assert/strict';
import test from 'node:test';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { defineToolkit, type AgentToolkit } from '../../types/toolkit';
import { ToolkitRuntimeManager } from './toolkitRuntime';

function createTool(name: string, value: string, withInput = false) {
  return tool(async () => value, {
    name,
    description: name,
    schema: withInput
      ? z.object({ input: z.string() })
      : z.object({}),
  });
}

function createRuntimeToolkit(params: {
  name?: string;
  events: string[];
  failResolve?: boolean;
  resolveError?: Error;
  bindToolName?: string;
  changeBoundSchema?: boolean;
  startBarrier?: Promise<void>;
  onStart?: () => void;
}): AgentToolkit {
  const name = params.name ?? 'runtime_toolkit';
  const staticTool = createTool(`${name}_tool`, 'static');
  return defineToolkit({
    name,
    description: name,
    tools: [{ tool: staticTool }],
    runtime: {
      async start() {
        params.events.push(`start:${name}`);
        params.onStart?.();
        await params.startBarrier;
        return { name };
      },
      async resolve(_root, context) {
        params.events.push(`resolve:${name}:${context.execution.delegationId}`);
        if (params.resolveError) throw params.resolveError;
        if (params.failResolve) throw new Error(`cannot resolve ${name}`);
        return { delegationId: context.execution.delegationId };
      },
      async bindTools(binding) {
        return [createTool(
          params.bindToolName ?? staticTool.name,
          `bound:${(binding as { delegationId: string }).delegationId}`,
          params.changeBoundSchema,
        )];
      },
      async release(binding) {
        params.events.push(`release:${name}:${(binding as { delegationId: string }).delegationId}`);
      },
      async stop() {
        params.events.push(`stop:${name}`);
      },
    },
  });
}

function execution(delegationId: string) {
  return {
    threadId: 'thread-1',
    runId: 'run-1',
    delegationId,
    workdir: '/workspace',
  };
}

test('ToolkitRuntimeManager starts roots once and binds isolated execution tools', async () => {
  const events: string[] = [];
  const toolkit = createRuntimeToolkit({ events });
  const manager = new ToolkitRuntimeManager();

  await manager.start([toolkit]);
  const first = await manager.resolve({ toolkits: [toolkit], execution: execution('delegation-a') });
  const second = await manager.resolve({ toolkits: [toolkit], execution: execution('delegation-b') });

  assert.equal(await first.toolkits[0]?.tools[0]?.tool.invoke({}), 'bound:delegation-a');
  assert.equal(await second.toolkits[0]?.tools[0]?.tool.invoke({}), 'bound:delegation-b');
  assert.deepEqual(events, [
    'start:runtime_toolkit',
    'resolve:runtime_toolkit:delegation-a',
    'resolve:runtime_toolkit:delegation-b',
  ]);

  await second.release();
  await first.release();
  await manager.stop();
  assert.deepEqual(events, [
    'start:runtime_toolkit',
    'resolve:runtime_toolkit:delegation-a',
    'resolve:runtime_toolkit:delegation-b',
    'release:runtime_toolkit:delegation-b',
    'release:runtime_toolkit:delegation-a',
    'stop:runtime_toolkit',
  ]);
});

test('ToolkitRuntimeManager does not start one root twice for concurrent subagents', async () => {
  const events: string[] = [];
  let releaseStart: (() => void) | undefined;
  const startBarrier = new Promise<void>((resolve) => {
    releaseStart = resolve;
  });
  let observeStart: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    observeStart = resolve;
  });
  const toolkit = createRuntimeToolkit({
    events,
    startBarrier,
    onStart: () => observeStart?.(),
  });
  const manager = new ToolkitRuntimeManager();

  const first = manager.resolve({ toolkits: [toolkit], execution: execution('delegation-a') });
  await started;
  assert.equal((await manager.diagnose())[0]?.lifecycle, 'starting');
  const second = manager.resolve({ toolkits: [toolkit], execution: execution('delegation-b') });
  releaseStart?.();

  const [firstExecution, secondExecution] = await Promise.all([first, second]);
  assert.deepEqual(events, [
    'start:runtime_toolkit',
    'resolve:runtime_toolkit:delegation-a',
    'resolve:runtime_toolkit:delegation-b',
  ]);

  await Promise.all([firstExecution.release(), secondExecution.release()]);
  await manager.stop();
});

test('ToolkitRuntimeManager waits for active executions to release before stopping roots', async () => {
  const events: string[] = [];
  const toolkit = createRuntimeToolkit({ events });
  const manager = new ToolkitRuntimeManager();
  const active = await manager.resolve({
    toolkits: [toolkit],
    execution: execution('delegation-a'),
  });

  let stopped = false;
  const stopping = manager.stop().then(() => {
    stopped = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(stopped, false);
  assert.deepEqual(await manager.diagnose(), [{
    toolkitName: 'runtime_toolkit',
    lifecycle: 'stopping',
    activeBindings: 1,
  }]);
  assert.deepEqual(events, [
    'start:runtime_toolkit',
    'resolve:runtime_toolkit:delegation-a',
  ]);

  await active.release();
  await stopping;
  await active.release();

  assert.equal(
    events.filter((event) => event === 'release:runtime_toolkit:delegation-a').length,
    1,
  );
  assert.deepEqual(events.slice(-2), [
    'release:runtime_toolkit:delegation-a',
    'stop:runtime_toolkit',
  ]);
});

test('ToolkitRuntimeManager preserves the original resolution error as cause', async () => {
  const cause = new Error('binding failed');
  const toolkit = createRuntimeToolkit({ events: [], resolveError: cause });
  const manager = new ToolkitRuntimeManager();

  await assert.rejects(
    manager.resolve({ toolkits: [toolkit], execution: execution('delegation-a') }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.cause, cause);
      return true;
    },
  );
  assert.deepEqual(await manager.diagnose(), [{
    toolkitName: 'runtime_toolkit',
    lifecycle: 'degraded',
    activeBindings: 0,
    lastError: { message: 'binding failed' },
  }]);
  await manager.stop();
});

test('ToolkitRuntimeManager waits for an in-flight resolve before stopping roots', async () => {
  const events: string[] = [];
  let observeResolve: (() => void) | undefined;
  const resolveStarted = new Promise<void>((resolve) => {
    observeResolve = resolve;
  });
  let finishResolve: (() => void) | undefined;
  const resolveBarrier = new Promise<void>((resolve) => {
    finishResolve = resolve;
  });
  const staticTool = createTool('wait_tool', 'static');
  const toolkit = defineToolkit({
    name: 'wait_runtime',
    description: 'wait runtime',
    tools: [{ tool: staticTool }],
    runtime: {
      start: () => {
        events.push('start');
        return {};
      },
      resolve: async () => {
        events.push('resolve:start');
        observeResolve?.();
        await resolveBarrier;
        events.push('resolve:end');
        return {};
      },
      bindTools: () => [createTool('wait_tool', 'bound')],
      release: () => {
        events.push('release');
      },
      stop: () => {
        events.push('stop');
      },
    },
  });
  const manager = new ToolkitRuntimeManager();

  const resolving = manager.resolve({
    toolkits: [toolkit],
    execution: execution('delegation-a'),
  });
  await resolveStarted;
  const stopping = manager.stop();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['start', 'resolve:start']);
  finishResolve?.();

  await assert.rejects(resolving, /stopped during execution binding resolution/);
  await stopping;
  assert.deepEqual(events, ['start', 'resolve:start', 'resolve:end', 'release', 'stop']);
});

test('ToolkitRuntimeManager rolls back resolved bindings in reverse order', async () => {
  const events: string[] = [];
  const first = createRuntimeToolkit({ name: 'first', events });
  const second = createRuntimeToolkit({ name: 'second', events, failResolve: true });
  const manager = new ToolkitRuntimeManager();

  await assert.rejects(
    manager.resolve({ toolkits: [first, second], execution: execution('delegation-a') }),
    /cannot resolve second/,
  );
  assert.deepEqual(events, [
    'start:first',
    'start:second',
    'resolve:first:delegation-a',
    'resolve:second:delegation-a',
    'release:first:delegation-a',
  ]);

  await manager.stop();
  assert.deepEqual(events.slice(-2), ['stop:second', 'stop:first']);
});

test('ToolkitRuntimeManager rejects a runtime that changes a static tool name', async () => {
  const manager = new ToolkitRuntimeManager();
  const toolkit = createRuntimeToolkit({
    events: [],
    bindToolName: 'different_tool',
  });

  await assert.rejects(
    manager.resolve({ toolkits: [toolkit], execution: execution('delegation-a') }),
    /changed tool/,
  );
  await manager.stop();
});

test('ToolkitRuntimeManager preserves the static tool contract while binding execution', async () => {
  const manager = new ToolkitRuntimeManager();
  const toolkit = createRuntimeToolkit({
    events: [],
    changeBoundSchema: true,
  });

  const runtimeExecution = await manager.resolve({
    toolkits: [toolkit],
    execution: execution('delegation-a'),
  });
  const staticTool = toolkit.tools[0]?.tool;
  const executableTool = runtimeExecution.toolkits[0]?.tools[0]?.tool;
  assert.ok(staticTool);
  assert.ok(executableTool);
  assert.equal(executableTool.schema, staticTool.schema);
  assert.equal(executableTool.description, staticTool.description);
  assert.equal(executableTool.responseFormat, staticTool.responseFormat);
  assert.equal(await executableTool.invoke({}), 'bound:delegation-a');
  assert.equal(runtimeExecution.runtimes.runtime_toolkit, undefined);

  await runtimeExecution.release();
  await manager.stop();
});

test('ToolkitRuntimeManager exposes a root Runtime port without rebuilding tools', async () => {
  const root = Object.freeze({ invoke: () => 'runtime' });
  const staticTool = createTool('static_tool', 'static');
  const toolkit: AgentToolkit = {
    name: 'static_runtime_toolkit',
    description: 'static runtime toolkit',
    tools: [{ tool: staticTool }],
    runtime: {
      start: () => root,
    },
  };
  const manager = new ToolkitRuntimeManager();
  const runtimeExecution = await manager.resolve({
    toolkits: [toolkit],
    execution: execution('delegation-a'),
  });

  assert.equal(runtimeExecution.toolkits[0]?.tools[0]?.tool, staticTool);
  assert.equal(runtimeExecution.runtimes.static_runtime_toolkit, root);

  await runtimeExecution.release();
  await manager.stop();
});

test('ToolkitRuntimeManager projects generic lifecycle, bindings, and opaque details', async () => {
  const staticTool = createTool('diagnostic_tool', 'static');
  const toolkit = defineToolkit({
    name: 'diagnostic_runtime',
    description: 'diagnostic runtime',
    tools: [{ tool: staticTool }],
    runtime: {
      start: () => ({ providerState: 'connected' }),
      diagnose: (root) => ({
        providerState: (root as { providerState: string }).providerState,
      }),
    },
  });
  const manager = new ToolkitRuntimeManager();

  await manager.start([toolkit]);
  const readyDiagnostics = await manager.diagnose();
  assert.deepEqual(readyDiagnostics, [{
    toolkitName: 'diagnostic_runtime',
    lifecycle: 'ready',
    activeBindings: 0,
    details: { providerState: 'connected' },
  }]);
  assert.equal(Object.isFrozen(readyDiagnostics), true);
  assert.equal(Object.isFrozen(readyDiagnostics[0]), true);
  assert.equal(Object.isFrozen(readyDiagnostics[0]?.details), true);

  const active = await manager.resolve({
    toolkits: [toolkit],
    execution: execution('delegation-a'),
  });
  assert.equal((await manager.diagnose())[0]?.activeBindings, 1);

  await active.release();
  assert.equal((await manager.diagnose())[0]?.activeBindings, 0);
  await manager.stop();
  assert.deepEqual(await manager.diagnose(), [{
    toolkitName: 'diagnostic_runtime',
    lifecycle: 'stopped',
    activeBindings: 0,
  }]);
});

test('ToolkitRuntimeManager retains startup and shutdown failures in diagnostics', async () => {
  const startFailure = defineToolkit({
    name: 'start_failure',
    description: 'start failure',
    tools: [{ tool: createTool('start_failure_tool', 'static') }],
    runtime: {
      start: () => {
        throw Object.assign(new Error('cannot start'), { code: 'START_FAILED' });
      },
    },
  });
  const startManager = new ToolkitRuntimeManager();
  await assert.rejects(startManager.start([startFailure]), /cannot start/);
  assert.deepEqual(await startManager.diagnose(), [{
    toolkitName: 'start_failure',
    lifecycle: 'failed',
    activeBindings: 0,
    lastError: { code: 'START_FAILED', message: 'cannot start' },
  }]);

  const stopFailure = defineToolkit({
    name: 'stop_failure',
    description: 'stop failure',
    tools: [{ tool: createTool('stop_failure_tool', 'static') }],
    runtime: {
      start: () => ({}),
      stop: () => {
        throw new Error('cannot stop');
      },
    },
  });
  const stopManager = new ToolkitRuntimeManager();
  await stopManager.start([stopFailure]);
  await assert.rejects(stopManager.stop(), /cannot stop/);
  assert.deepEqual(await stopManager.diagnose(), [{
    toolkitName: 'stop_failure',
    lifecycle: 'failed',
    activeBindings: 0,
    lastError: { message: 'cannot stop' },
  }]);
});
