import assert from 'node:assert/strict';
import test from 'node:test';
import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { defineToolkit, type AgentToolkit } from '../../types/toolkit';
import { ToolkitRuntimeManager } from './toolkitRuntime';

function createTool(name: string, value: string) {
  return tool(async () => value, {
    name,
    description: name,
    schema: z.object({}),
  });
}

function createRuntimeToolkit(params: {
  name?: string;
  events: string[];
  failResolve?: boolean;
  bindToolName?: string;
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
        if (params.failResolve) throw new Error(`cannot resolve ${name}`);
        return { delegationId: context.execution.delegationId };
      },
      async bindTools(binding) {
        return [createTool(
          params.bindToolName ?? staticTool.name,
          `bound:${(binding as { delegationId: string }).delegationId}`,
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
