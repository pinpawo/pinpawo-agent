import type { ToolkitRuntimeExecutionScope } from '@pinpawo/pet-agent';
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
}>;

export class ShellRuntime {
  private readonly registry = new ProcessRegistry();

  start(): void {
    // Nothing to acquire up front: process groups are created per command.
    // The root exists so the registry has a lifetime tied to the host.
  }

  resolve(execution: ToolkitRuntimeExecutionScope): ShellRuntimeBinding {
    return Object.freeze({
      registry: this.registry,
      owner: {
        threadId: execution.threadId,
        runId: execution.runId,
        delegationId: execution.delegationId,
      },
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

  async stop(killGraceMs?: number): Promise<void> {
    await this.registry.stopAll(killGraceMs);
  }

  getRegistry(): ProcessRegistry {
    return this.registry;
  }
}

export const shellRuntime = new ShellRuntime();
