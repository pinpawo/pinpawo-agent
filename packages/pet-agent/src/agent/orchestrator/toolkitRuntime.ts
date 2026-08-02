import { isStructuredTool } from '@langchain/core/tools';
import type {
  AgentToolkit,
  NamedStructuredTool,
  ToolkitRuntimeDefinition,
  ToolkitRuntimeExecutionScope,
  ToolkitRuntimeResolveContext,
  ToolkitRuntimeStartContext,
  ToolkitRuntimeStopContext,
} from '../../types/toolkit';

type StartedToolkitRuntime = {
  toolkitName: string;
  runtime: ToolkitRuntimeDefinition;
  root: unknown;
};

type ResolvedToolkitBinding = {
  toolkit: AgentToolkit;
  runtime: ToolkitRuntimeDefinition;
  binding: unknown;
  context: ToolkitRuntimeResolveContext;
};

export type ToolkitRuntimeExecution = {
  /**
   * The same static Toolkit inventory, with executable Tool instances bound to
   * this execution where a Toolkit opted into a runtime.
   */
  toolkits: readonly AgentToolkit[];
  release: () => Promise<void>;
};

function describeError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function assertSameRuntime(
  toolkit: AgentToolkit,
  started: StartedToolkitRuntime,
) {
  if (started.runtime !== toolkit.runtime) {
    throw new Error(
      `Toolkit runtime "${toolkit.name}" was registered with a different definition in one host lifecycle.`,
    );
  }
}

function bindToolkitTools(params: {
  toolkit: AgentToolkit;
  boundTools: readonly NamedStructuredTool[];
}): AgentToolkit {
  const { toolkit, boundTools } = params;
  if (boundTools.length !== toolkit.tools.length) {
    throw new Error(
      `Toolkit runtime "${toolkit.name}" changed its tool inventory while binding one execution.`,
    );
  }

  const tools = toolkit.tools.map((definition, index) => {
    const boundTool = boundTools[index];
    if (!boundTool || !isStructuredTool(boundTool) || typeof boundTool.invoke !== 'function') {
      throw new Error(
        `Toolkit runtime "${toolkit.name}" returned a non-executable bound tool at index ${index.toString()}.`,
      );
    }
    if (boundTool.name !== definition.tool.name) {
      throw new Error(
        `Toolkit runtime "${toolkit.name}" changed tool "${definition.tool.name}" while binding one execution.`,
      );
    }
    // Operation metadata and review policy remain owned by the static Toolkit
    // contract; a runtime may only swap the executable implementation.
    return Object.freeze({
      ...definition,
      tool: boundTool,
    });
  });

  return Object.freeze({
    ...toolkit,
    tools: Object.freeze(tools),
  });
}

/**
 * Host-owned lifecycle coordinator for optional Toolkit runtimes.
 *
 * It knows only Toolkit names, opaque roots/bindings, and generic execution
 * identity. Provider-specific state never crosses this boundary.
 */
export class ToolkitRuntimeManager {
  private readonly roots = new Map<string, StartedToolkitRuntime>();
  private readonly startOrder: string[] = [];
  private readonly activeExecutions = new Set<ResolvedToolkitBinding[]>();
  /** Serializes root lifecycle transitions so concurrent subagents cannot
   * start the same runtime twice. Execution binding itself remains concurrent.
   */
  private lifecycleTail: Promise<void> = Promise.resolve();
  private stopped = false;

  async start(
    toolkits: readonly AgentToolkit[],
    context: ToolkitRuntimeStartContext = {},
  ): Promise<void> {
    return this.queueLifecycle(() => this.startRoots(toolkits, context));
  }

  private async startRoots(
    toolkits: readonly AgentToolkit[],
    context: ToolkitRuntimeStartContext,
  ): Promise<void> {
    if (this.stopped) {
      throw new Error('Toolkit runtime manager has already stopped.');
    }

    const startedNow: string[] = [];
    try {
      for (const toolkit of toolkits) {
        if (!toolkit.runtime) continue;
        const existing = this.roots.get(toolkit.name);
        if (existing) {
          assertSameRuntime(toolkit, existing);
          continue;
        }
        const root = await toolkit.runtime.start(context);
        this.roots.set(toolkit.name, {
          toolkitName: toolkit.name,
          runtime: toolkit.runtime,
          root,
        });
        this.startOrder.push(toolkit.name);
        startedNow.push(toolkit.name);
      }
    } catch (error) {
      await this.stopRoots([...startedNow].reverse(), context).catch(() => undefined);
      throw new Error(`Toolkit runtime startup failed: ${describeError(error)}`);
    }
  }

  async resolve(params: {
    toolkits: readonly AgentToolkit[];
    execution: ToolkitRuntimeExecutionScope;
  }): Promise<ToolkitRuntimeExecution> {
    const context: ToolkitRuntimeResolveContext = { execution: params.execution };
    await this.start(params.toolkits, { signal: params.execution.signal });

    const bindings: ResolvedToolkitBinding[] = [];
    try {
      const toolkits: AgentToolkit[] = [];
      for (const toolkit of params.toolkits) {
        const runtime = toolkit.runtime;
        if (!runtime) {
          toolkits.push(toolkit);
          continue;
        }
        const started = this.roots.get(toolkit.name);
        if (!started) {
          throw new Error(`Toolkit runtime "${toolkit.name}" was not started.`);
        }
        assertSameRuntime(toolkit, started);
        const binding = runtime.resolve
          ? await runtime.resolve(started.root, context)
          : started.root;
        bindings.push({ toolkit, runtime, binding, context });
        toolkits.push(runtime.bindTools
          ? bindToolkitTools({
              toolkit,
              boundTools: await runtime.bindTools(binding, context),
            })
          : toolkit);
      }

      this.activeExecutions.add(bindings);
      let released = false;
      return Object.freeze({
        toolkits: Object.freeze(toolkits),
        release: async () => {
          if (released) return;
          released = true;
          this.activeExecutions.delete(bindings);
          await this.releaseBindings(bindings);
        },
      });
    } catch (error) {
      await this.releaseBindings(bindings).catch(() => undefined);
      throw new Error(`Toolkit runtime resolution failed: ${describeError(error)}`);
    }
  }

  async stop(context: ToolkitRuntimeStopContext = {}): Promise<void> {
    return this.queueLifecycle(() => this.stopRootsAndBindings(context));
  }

  private async stopRootsAndBindings(context: ToolkitRuntimeStopContext): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;

    const errors: unknown[] = [];
    for (const bindings of [...this.activeExecutions]) {
      this.activeExecutions.delete(bindings);
      try {
        await this.releaseBindings(bindings);
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await this.stopRoots([...this.startOrder].reverse(), context);
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) {
      throw new Error(`Toolkit runtime shutdown failed: ${errors.map(describeError).join('; ')}`);
    }
  }

  private queueLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.lifecycleTail.then(operation, operation);
    this.lifecycleTail = queued.then(
      () => undefined,
      () => undefined,
    );
    return queued;
  }

  private async releaseBindings(bindings: readonly ResolvedToolkitBinding[]): Promise<void> {
    const errors: unknown[] = [];
    for (const binding of [...bindings].reverse()) {
      try {
        await binding.runtime.release?.(binding.binding, binding.context);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new Error(`Toolkit runtime release failed: ${errors.map(describeError).join('; ')}`);
    }
  }

  private async stopRoots(
    names: readonly string[],
    context: ToolkitRuntimeStopContext,
  ): Promise<void> {
    const errors: unknown[] = [];
    for (const name of names) {
      const started = this.roots.get(name);
      if (!started) continue;
      this.roots.delete(name);
      const orderIndex = this.startOrder.lastIndexOf(name);
      if (orderIndex >= 0) this.startOrder.splice(orderIndex, 1);
      try {
        await started.runtime.stop?.(started.root, context);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new Error(`Toolkit runtime stop failed: ${errors.map(describeError).join('; ')}`);
    }
  }
}
