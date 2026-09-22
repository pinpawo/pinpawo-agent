import type { StructuredTool, ToolRunnableConfig } from '@langchain/core/tools';
import type { AgentToolkit } from '@pinpawo/pet-agent';

/** Execution dependencies belong to Host assembly, never to the Agent contract. */
export type HostedToolkit = AgentToolkit & { readonly runtime?: string };
export type ToolkitRuntimeClientBinding = Readonly<{
  runtimeType: string;
  client: unknown;
  identity: Readonly<{ clientId: string; instanceId: string }>;
  diagnose?: () => unknown | Promise<unknown>;
}>;

/** Bind once per Host inventory. Native Tool invocation retains validation and events. */
export function bindToolkitRuntime(toolkit: HostedToolkit, binding?: ToolkitRuntimeClientBinding): AgentToolkit {
  const { runtime, ...definition } = toolkit;
  if (runtime === undefined) return definition;
  if (typeof runtime !== 'string' || !runtime.trim() || runtime !== runtime.trim()) {
    throw new Error(`Toolkit "${toolkit.name}" must declare a non-empty Runtime interface name.`);
  }
  if (!binding || binding.runtimeType !== runtime || binding.client == null) {
    throw new Error(`Toolkit "${toolkit.name}" requires a connected "${runtime}" Runtime.`);
  }
  const toolkitRuntimes = Object.freeze({ [toolkit.name]: binding.client });
  return { ...definition, tools: definition.tools.map(item => ({
    ...item,
    tool: new Proxy(item.tool, {
      get(target, property, receiver) {
        if (property !== 'invoke') return Reflect.get(target, property, receiver);
        return (input: Parameters<StructuredTool['invoke']>[0], config?: ToolRunnableConfig) => target.invoke(input, {
          ...config,
          context: { ...config?.context, toolkitName: toolkit.name, toolkitRuntimes },
        });
      },
    }),
  })) };
}
