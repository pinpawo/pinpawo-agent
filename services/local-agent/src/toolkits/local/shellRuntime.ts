import type { ToolkitRuntimeExecutionScope } from '@pinpawo/pet-agent';
import type { ProcessExecutor } from './processExecutor';
import { posixProcessExecutor } from './processTree';
import { windowsProcessExecutor } from './windowsProcessExecutor';
import {
  ProcessRegistry,
  type ManagedProcessOwner,
} from './processRegistry';

/**
 * Toolkit runtime root for shell process ownership (#543).
 *
 * The registry lives on the root rather than on a per-execution binding, so a
 * long-running command survives the execution that started it — the same
 * shape browser uses for its retained page. `release` only drops the
 * execution's claim; termination comes from an explicit request, the
 * process's own exit, or host shutdown via `stop`.
 */

export type ShellRuntimeBinding = Readonly<{
  registry: ProcessRegistry;
  owner: ManagedProcessOwner;
  workdir: string;
}>;

export class ShellRuntime {
  private readonly registry: ProcessRegistry;

  /**
   * Choosing the executor is the one place that knows which platform this is.
   * Windows arrives here as another implementation (#562), leaving the
   * registry and the tools untouched.
   */
  constructor(
    executor: ProcessExecutor = process.platform === 'win32'
      ? windowsProcessExecutor
      : posixProcessExecutor,
  ) {
    this.registry = new ProcessRegistry(executor);
  }

  start(): void {
    // Nothing to acquire up front: process groups are created per command.
    // The root exists so the registry has a lifetime tied to the host.
  }

  resolve(execution: ToolkitRuntimeExecutionScope): ShellRuntimeBinding {
    if (!execution.workdir) {
      throw new Error('bash Toolkit runtime requires an execution workdir.');
    }
    return Object.freeze({
      registry: this.registry,
      owner: {
        threadId: execution.threadId,
        runId: execution.runId,
        delegationId: execution.delegationId,
      },
      workdir: execution.workdir,
    });
  }

  /**
   * End one execution's claim on the registry.
   *
   * Deliberately does not terminate anything. A build handed off as a handle
   * is meant to outlive the tool call that started it; killing it here would
   * defeat the yield.
   */
  release(): void {
    // No per-execution state to unwind: the binding is just an owner tag.
  }

  /**
   * Terminate everything the registry holds.
   *
   * Takes no grace period: this implements the Toolkit runtime's `stop`, whose
   * context carries no such concept, so anything configurable here would be
   * unreachable from the only path that calls it. Per-process grace stays on
   * `ProcessRegistry.terminate`, where a caller can actually supply it.
   */
  async stop(): Promise<void> {
    await this.registry.stopAll();
  }

  getRegistry(): ProcessRegistry {
    return this.registry;
  }
}
