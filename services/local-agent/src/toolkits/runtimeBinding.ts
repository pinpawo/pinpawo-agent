import type { StructuredTool, ToolRunnableConfig } from '@langchain/core/tools';
import type { AgentToolkit } from '@pinpawo/pet-agent';

/** Execution dependencies belong to Host assembly, never to the Agent contract. */
export type ToolkitRuntimeRequirement = Readonly<{
  toolkit: AgentToolkit;
  runtimeKind?: string;
}>;
export type ConnectedToolkitRuntime = Readonly<{
  runtimeKind: string;
  client: unknown;
}>;

/** Bind once per Host inventory. Native Tool invocation retains validation and events. */
export function bindToolkitRuntime(
  requirement: ToolkitRuntimeRequirement,
  runtime?: ConnectedToolkitRuntime,
): AgentToolkit {
  const { toolkit, runtimeKind } = requirement;
  if (runtimeKind === undefined) return toolkit;
  if (typeof runtimeKind !== 'string' || !runtimeKind.trim() || runtimeKind !== runtimeKind.trim()) {
    throw new Error(`Toolkit "${toolkit.name}" must declare a non-empty Runtime kind.`);
  }
  if (!runtime || runtime.runtimeKind !== runtimeKind || runtime.client == null) {
    throw new Error(`Toolkit "${toolkit.name}" requires a connected "${runtimeKind}" Runtime.`);
  }
  return { ...toolkit, tools: toolkit.tools.map(item => ({
    ...item,
    tool: new Proxy(item.tool, {
      get(target, property, receiver) {
        if (property !== 'invoke') return Reflect.get(target, property, receiver);
        return (input: Parameters<StructuredTool['invoke']>[0], config?: ToolRunnableConfig) => target.invoke(input, {
          ...config,
          context: { ...config?.context, toolkitRuntime: runtime.client },
        });
      },
    }),
  })) };
}
