import type { NamedStructuredTool } from '@pinpawo/pet-agent';
import type { RuntimeCaller, RuntimeExecution, RuntimeInstanceConfig } from '../../runtimeService/types';
import { createShellEnvironment } from './shellEnvironment';
import { createShellRuntimeClient } from './shellClient';
import { prepareLocalToolInput } from './workdirBinding';

export function testExecution(overrides: Partial<RuntimeExecution> = {}): RuntimeExecution {
  return {
    threadId: 'thread', taskId: 'task', runId: 'run', delegationId: 'delegation',
    workdir: process.cwd(), ...overrides,
  };
}

export function createLocalRuntimeFixture(config: RuntimeInstanceConfig = { type: 'shell' }) {
  const environment = createShellEnvironment({ pathBase: process.cwd(), ...config });
  const caller = (clientId = 'test-client'): RuntimeCaller => ({
    call: (toolkitName, method, args, execution, signal) => environment.call(method, args, {
      clientId, toolkitName, execution, signal: signal ?? new AbortController().signal,
    }),
  });
  const client = (toolkitName = 'bash', clientId = 'test-client') => createShellRuntimeClient(caller(clientId), toolkitName);
  return {
    environment, caller, client, close: () => environment.close(),
    async invoke(
      tool: NamedStructuredTool,
      input: unknown,
      config?: Parameters<NamedStructuredTool['invoke']>[1],
      scope = testExecution(),
      toolkitName = /^(git_|gh_)/.test(tool.name) ? 'git' : 'bash',
      clientId = 'test-client',
    ) {
      const record = input as Record<string, unknown>;
      const toolCall = record.type === 'tool_call';
      const args = prepareLocalToolInput(tool.name, toolCall ? record.args : input, scope.workdir);
      return tool.invoke((toolCall ? { ...record, args } : args) as Parameters<NamedStructuredTool['invoke']>[0], {
        ...config,
        context: {
          executionScope: scope,
          toolkitRuntime: client(toolkitName, clientId),
        },
      } as Parameters<NamedStructuredTool['invoke']>[1]);
    },
  };
}

/** Explicit service fixture for existing Tool behavior tests; never a production fallback. */
export async function invokeLocalTool(
  tool: NamedStructuredTool,
  input: unknown,
  config?: Parameters<NamedStructuredTool['invoke']>[1],
) {
  const fixture = createLocalRuntimeFixture();
  try { return await fixture.invoke(tool, input, config); } finally { await fixture.close(); }
}
