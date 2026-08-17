import { isStructuredTool } from '@langchain/core/tools';
import { isJsonValue, type JsonValue } from '@pinpawo/agent-contracts';
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

export type ToolkitRuntimeLifecycle =
  | 'starting'
  | 'ready'
  | 'degraded'
  | 'stopping'
  | 'stopped'
  | 'failed';

export type ToolkitRuntimeDiagnosticError = Readonly<{
  code?: string;
  message: string;
}>;

export type ToolkitRuntimeDiagnostic = Readonly<{
  toolkitName: string;
  lifecycle: ToolkitRuntimeLifecycle;
  activeBindings: number;
  lastError?: ToolkitRuntimeDiagnosticError;
  details?: JsonValue;
}>;

type ToolkitRuntimeDiagnosticState = {
  toolkitName: string;
  lifecycle: ToolkitRuntimeLifecycle;
  activeBindings: number;
  lastError?: ToolkitRuntimeDiagnosticError;
};

type ResolvedToolkitBinding = {
  toolkit: AgentToolkit;
  runtime: ToolkitRuntimeDefinition;
  binding: unknown;
  context: ToolkitRuntimeResolveContext;
};

type ActiveToolkitRuntimeExecution = {
  bindings: ResolvedToolkitBinding[];
  releasePromise: Promise<void> | null;
  settledPromise: Promise<unknown | null>;
  settle: (error: unknown | null) => void;
};

export type ToolkitRuntimeExecution = {
  /**
   * The same static Toolkit inventory, with executable Tool instances bound to
   * this execution where a Toolkit opted into a runtime.
   */
  toolkits: readonly AgentToolkit[];
  /** Opaque Runtime ports exposed to their Toolkit tools through ToolRuntime.context. */
  runtimes: Readonly<Record<string, unknown>>;
  release: () => Promise<void>;
};

function describeError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function projectDiagnosticError(error: unknown): ToolkitRuntimeDiagnosticError {
  const rawCode = error && typeof error === 'object'
    ? Reflect.get(error, 'code')
    : undefined;
  const code = typeof rawCode === 'string' ? rawCode : undefined;
  return Object.freeze({
    ...(code ? { code } : {}),
    message: describeError(error),
  });
}

function freezeJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(freezeJsonValue)) as unknown as JsonValue;
  }
  if (value && typeof value === 'object') {
    return Object.freeze(Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, freezeJsonValue(entry)]),
    ));
  }
  return value;
}

function lifecycleError(message: string, errors: readonly unknown[]) {
  const cause = errors.length === 1
    ? errors[0]
    : new AggregateError(errors, message);
  return new Error(
    `${message}: ${errors.map(describeError).join('; ')}`,
    { cause },
  );
}

function bindToolImplementation(params: {
  staticTool: NamedStructuredTool;
  boundTool: NamedStructuredTool;
}): NamedStructuredTool {
  const boundCall = Reflect.get(
    params.boundTool as object,
    '_call',
    params.boundTool,
  );
  if (typeof boundCall !== 'function') {
    throw new Error(
      `Bound tool "${params.staticTool.name}" does not expose a StructuredTool execution implementation.`,
    );
  }
  // Keep the complete static Tool object as the public/model-visible contract.
  // StructuredTool.invoke() validates against that object's schema and then
  // dispatches through `_call`; only that implementation hook is replaced.
  return new Proxy(params.staticTool, {
    get(target, property, receiver) {
      if (property === '_call') return boundCall.bind(params.boundTool);
      return Reflect.get(target, property, receiver);
    },
  });
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
    const executableTool = bindToolImplementation({
      staticTool: definition.tool,
      boundTool,
    });
    // Operation metadata and review policy remain owned by the static Toolkit
    // contract; a runtime may only swap the executable implementation.
    return Object.freeze({
      ...definition,
      tool: executableTool,
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
  private readonly diagnosticStates = new Map<string, ToolkitRuntimeDiagnosticState>();
  private readonly startOrder: string[] = [];
  private readonly activeExecutions = new Set<ActiveToolkitRuntimeExecution>();
  private readonly pendingResolutions = new Set<Promise<void>>();
  /** Serializes root lifecycle transitions so concurrent subagents cannot
   * start the same runtime twice. Execution binding itself remains concurrent.
   */
  private lifecycleTail: Promise<void> = Promise.resolve();
  private stopping = false;
  private stopped = false;
  private stopPromise: Promise<void> | null = null;

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
    if (this.stopping || this.stopped) {
      throw new Error('Toolkit runtime manager is stopping or has already stopped.');
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
        this.diagnosticStates.set(toolkit.name, {
          toolkitName: toolkit.name,
          lifecycle: 'starting',
          activeBindings: 0,
        });
        let root: unknown;
        try {
          root = await toolkit.runtime.start(context);
        } catch (error) {
          this.recordRuntimeError(toolkit.name, 'failed', error);
          throw error;
        }
        this.roots.set(toolkit.name, {
          toolkitName: toolkit.name,
          runtime: toolkit.runtime,
          root,
        });
        this.startOrder.push(toolkit.name);
        startedNow.push(toolkit.name);
        this.setRuntimeLifecycle(toolkit.name, this.stopping ? 'stopping' : 'ready');
      }
    } catch (error) {
      await this.stopRoots([...startedNow].reverse(), context).catch(() => undefined);
      throw new Error(
        `Toolkit runtime startup failed: ${describeError(error)}`,
        { cause: error },
      );
    }
  }

  async resolve(params: {
    toolkits: readonly AgentToolkit[];
    execution: ToolkitRuntimeExecutionScope;
  }): Promise<ToolkitRuntimeExecution> {
    if (this.stopping || this.stopped) {
      throw new Error('Toolkit runtime manager is stopping or has already stopped.');
    }
    let finishPendingResolution!: () => void;
    const pendingResolution = new Promise<void>((resolve) => {
      finishPendingResolution = resolve;
    });
    this.pendingResolutions.add(pendingResolution);
    const context: ToolkitRuntimeResolveContext = { execution: params.execution };
    const bindings: ResolvedToolkitBinding[] = [];
    const runtimes: Record<string, unknown> = {};
    try {
      await this.start(params.toolkits, { signal: params.execution.signal });
      if (this.stopping || this.stopped) {
        throw new Error('Toolkit runtime manager stopped during execution binding resolution.');
      }
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
        try {
          const binding = runtime.resolve
            ? await runtime.resolve(started.root, context)
            : started.root;
          bindings.push({ toolkit, runtime, binding, context });
          this.changeActiveBindings(toolkit.name, 1);
          if (!runtime.bindTools) {
            runtimes[toolkit.name] = binding;
          }
          toolkits.push(runtime.bindTools
            ? bindToolkitTools({
                toolkit,
                boundTools: await runtime.bindTools(binding, context),
              })
            : toolkit);
        } catch (error) {
          this.recordRuntimeError(toolkit.name, 'degraded', error);
          throw error;
        }
      }

      if (this.stopping || this.stopped) {
        throw new Error('Toolkit runtime manager stopped during execution binding resolution.');
      }
      let settleExecution!: (error: unknown | null) => void;
      const settledPromise = new Promise<unknown | null>((resolve) => {
        settleExecution = resolve;
      });
      const execution: ActiveToolkitRuntimeExecution = {
        bindings,
        releasePromise: null,
        settledPromise,
        settle: settleExecution,
      };
      this.activeExecutions.add(execution);
      return Object.freeze({
        toolkits: Object.freeze(toolkits),
        runtimes: Object.freeze(runtimes),
        release: async () => await this.releaseExecution(execution),
      });
    } catch (error) {
      await this.releaseBindings(bindings).catch(() => undefined);
      throw new Error(
        `Toolkit runtime resolution failed: ${describeError(error)}`,
        { cause: error },
      );
    } finally {
      this.pendingResolutions.delete(pendingResolution);
      finishPendingResolution();
    }
  }

  stop(context: ToolkitRuntimeStopContext = {}): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    for (const state of this.diagnosticStates.values()) {
      if (state.lifecycle !== 'failed' && state.lifecycle !== 'stopped') {
        state.lifecycle = 'stopping';
      }
    }
    this.stopPromise = this.queueLifecycle(() => this.stopRootsAndBindings(context));
    return this.stopPromise;
  }

  /**
   * Read one generic diagnostic projection for every Runtime this manager has
   * attempted to start. Toolkit-specific details remain opaque JSON.
   */
  async diagnose(): Promise<readonly ToolkitRuntimeDiagnostic[]> {
    const diagnostics = await Promise.all(
      [...this.diagnosticStates.keys()].map(async (toolkitName) => {
        const started = this.roots.get(toolkitName);
        let details: JsonValue | undefined;
        if (started?.runtime.diagnose) {
          try {
            const projected = await started.runtime.diagnose(started.root);
            if (!isJsonValue(projected)) {
              throw new Error(
                `Toolkit runtime "${toolkitName}" diagnose() returned a non-JSON value.`,
              );
            }
            if (this.roots.get(toolkitName) === started) {
              details = freezeJsonValue(projected);
            }
          } catch (error) {
            const current = this.diagnosticStates.get(toolkitName);
            if (current?.lifecycle === 'ready' || current?.lifecycle === 'degraded') {
              this.recordRuntimeError(toolkitName, 'degraded', error);
            }
          }
        }
        const state = this.diagnosticStates.get(toolkitName);
        if (!state) {
          throw new Error(`Toolkit runtime "${toolkitName}" diagnostic state is missing.`);
        }
        return Object.freeze({
          toolkitName: state.toolkitName,
          lifecycle: state.lifecycle,
          activeBindings: state.activeBindings,
          ...(state.lastError ? { lastError: state.lastError } : {}),
          ...(details !== undefined ? { details } : {}),
        });
      }),
    );
    return Object.freeze(diagnostics);
  }

  private async stopRootsAndBindings(context: ToolkitRuntimeStopContext): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;

    const errors: unknown[] = [];
    await Promise.all([...this.pendingResolutions]);
    // Active executions own their bindings until their subagent has finished.
    // The host cancels executions before stopping the manager; waiting here
    // lets each execution's finally path release its own binding without
    // invalidating tools that are still unwinding.
    const releaseErrors = await Promise.all(
      [...this.activeExecutions].map((execution) => execution.settledPromise),
    );
    errors.push(...releaseErrors.filter((error) => error !== null));
    try {
      await this.stopRoots([...this.startOrder].reverse(), context);
    } catch (error) {
      errors.push(error);
    }
    if (errors.length > 0) {
      throw lifecycleError('Toolkit runtime shutdown failed', errors);
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

  private releaseExecution(execution: ActiveToolkitRuntimeExecution): Promise<void> {
    if (execution.releasePromise) return execution.releasePromise;
    const releasePromise = this.releaseBindings(execution.bindings);
    execution.releasePromise = releasePromise;
    releasePromise.then(
      () => {
        this.activeExecutions.delete(execution);
        execution.settle(null);
      },
      (error) => {
        this.activeExecutions.delete(execution);
        execution.settle(error);
      },
    );
    return releasePromise;
  }

  private async releaseBindings(bindings: readonly ResolvedToolkitBinding[]): Promise<void> {
    const errors: unknown[] = [];
    for (const binding of [...bindings].reverse()) {
      try {
        await binding.runtime.release?.(binding.binding, binding.context);
      } catch (error) {
        this.recordRuntimeError(binding.toolkit.name, 'degraded', error);
        errors.push(error);
      } finally {
        this.changeActiveBindings(binding.toolkit.name, -1);
      }
    }
    if (errors.length > 0) {
      throw lifecycleError('Toolkit runtime release failed', errors);
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
      this.setRuntimeLifecycle(name, 'stopping');
      this.roots.delete(name);
      const orderIndex = this.startOrder.lastIndexOf(name);
      if (orderIndex >= 0) this.startOrder.splice(orderIndex, 1);
      try {
        await started.runtime.stop?.(started.root, context);
        this.setRuntimeLifecycle(name, 'stopped');
      } catch (error) {
        this.recordRuntimeError(name, 'failed', error);
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw lifecycleError('Toolkit runtime stop failed', errors);
    }
  }

  private setRuntimeLifecycle(
    toolkitName: string,
    lifecycle: ToolkitRuntimeLifecycle,
  ): void {
    const state = this.diagnosticStates.get(toolkitName);
    if (!state) return;
    state.lifecycle = lifecycle;
  }

  private recordRuntimeError(
    toolkitName: string,
    lifecycle: ToolkitRuntimeLifecycle,
    error: unknown,
  ): void {
    const state = this.diagnosticStates.get(toolkitName) ?? {
      toolkitName,
      lifecycle,
      activeBindings: 0,
    };
    if (
      lifecycle !== 'degraded'
      || (state.lifecycle !== 'stopping'
        && state.lifecycle !== 'stopped'
        && state.lifecycle !== 'failed')
    ) {
      state.lifecycle = lifecycle;
    }
    state.lastError = projectDiagnosticError(error);
    this.diagnosticStates.set(toolkitName, state);
  }

  private changeActiveBindings(toolkitName: string, delta: 1 | -1): void {
    const state = this.diagnosticStates.get(toolkitName);
    if (!state) return;
    state.activeBindings = Math.max(0, state.activeBindings + delta);
  }
}
