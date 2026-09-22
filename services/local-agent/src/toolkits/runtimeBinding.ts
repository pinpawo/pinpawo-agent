import type { StructuredTool, ToolRunnableConfig } from '@langchain/core/tools';
import type { AgentToolkit } from '@pinpawo/pet-agent';

/** Execution dependencies belong to Host assembly, never to the Agent contract. */
export type HostToolkitRegistration = Readonly<{
  toolkit: AgentToolkit;
  runtimeKind?: string;
}>;
export type ToolkitRuntimeClientBinding = Readonly<{
  runtimeKind: string;
  client: unknown;
}>;

/** Bind once per Host inventory. Native Tool invocation retains validation and events. */
export function bindToolkitRuntime(
  registration: HostToolkitRegistration,
  binding?: ToolkitRuntimeClientBinding,
): AgentToolkit {
  const { toolkit, runtimeKind } = registration;
  if (runtimeKind === undefined) return toolkit;
  if (typeof runtimeKind !== 'string' || !runtimeKind.trim() || runtimeKind !== runtimeKind.trim()) {
    throw new Error(`Toolkit "${toolkit.name}" must declare a non-empty Runtime kind.`);
  }
  if (!binding || binding.runtimeKind !== runtimeKind || binding.client == null) {
    throw new Error(`Toolkit "${toolkit.name}" requires a connected "${runtimeKind}" Runtime.`);
  }
  return { ...toolkit, tools: toolkit.tools.map(item => ({
    ...item,
    tool: new Proxy(item.tool, {
      get(target, property, receiver) {
        if (property !== 'invoke') return Reflect.get(target, property, receiver);
        return (input: Parameters<StructuredTool['invoke']>[0], config?: ToolRunnableConfig) => target.invoke(input, {
          ...config,
          context: { ...config?.context, toolkitRuntime: binding.client },
        });
      },
    }),
  })) };
}
