import type {
  AgentToolkit,
  ToolkitAvailability,
  ToolkitRS,
} from '@pinpawo/pet-agent';

/**
 * An RS instance the Host created in its own process (phase 2).
 *
 * `start` and `dispose` are the in-process instance's own management, not
 * session operations: no logical session is closed by a tool call, a run, or
 * a Host disconnect. A standalone RS (phase 3) is stopped by its own
 * management commands instead.
 */
export type HostOwnedRS = ToolkitRS & {
  start?(): Promise<void>;
  dispose(): Promise<void>;
};

export type HostRSStatus = Readonly<{
  name: string;
  contract: string;
  version: number;
  availability: ToolkitAvailability;
}>;

function describeError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Build one Toolkit from its typed factory with the RS instances the Host
 * selected, and check them against the Toolkit's own declaration.
 *
 * This is the only reader of `AgentToolkit.requires`. Passing the same
 * instance to several Toolkits makes them share an environment; passing
 * different instances isolates them.
 */
export function assembleToolkit<TDeps extends Readonly<Record<string, ToolkitRS>>>(
  create: (deps: TDeps) => AgentToolkit,
  deps: TDeps,
): AgentToolkit {
  const toolkit = create(deps);
  const requires = toolkit.requires ?? {};
  const declared = Object.keys(requires).sort();
  const injected = Object.keys(deps).sort();
  if (declared.join('\0') !== injected.join('\0')) {
    throw new Error(
      `Toolkit "${toolkit.name}" declares RS dependencies [${declared.join(', ')}] `
      + `but the Host injected [${injected.join(', ')}]`,
    );
  }
  for (const key of declared) {
    const requirement = requires[key]!;
    const instance = deps[key]!;
    if (
      instance.contract !== requirement.contract
      || instance.version !== requirement.version
    ) {
      throw new Error(
        `Toolkit "${toolkit.name}" requires ${key} ${requirement.contract}@${requirement.version.toString()}, `
        + `but the Host injected ${instance.contract}@${instance.version.toString()}`,
      );
    }
  }
  return toolkit;
}

export type HostRSStartOptions = Readonly<{
  warn?: (message: string) => void;
  /**
   * Called after an instance that failed to start has started on a later
   * attempt, with the names of the Toolkits assembled on it, so the Host can
   * re-read their availability.
   */
  onRecovered?: (toolkitNames: readonly string[]) => void | Promise<void>;
  /** First retry delay after a failed start; doubles up to `maxRetryMs`. */
  initialRetryMs?: number;
  maxRetryMs?: number;
}>;

const DEFAULT_INITIAL_RETRY_MS = 5_000;
const DEFAULT_MAX_RETRY_MS = 60_000;

/**
 * The in-process RS instances one Host owns.
 *
 * A start failure is not a Host failure: it stays in that instance's status,
 * which is the availability of the Toolkits built on it and of nothing else.
 * The Host keeps retrying a failed start in the background, so an instance
 * can recover without a tool call reaching it — a Toolkit whose RS is
 * unavailable is not offered to the Agent, so no tool call would.
 */
export class HostRSInstances {
  private readonly instances = new Map<string, HostOwnedRS>();
  private readonly dependents = new Map<HostOwnedRS, string[]>();
  private readonly retryTimers = new Set<NodeJS.Timeout>();
  private disposed = false;

  add<T extends HostOwnedRS>(name: string, instance: T): T {
    if (this.instances.has(name)) {
      throw new Error(`Duplicate Host RS instance "${name}"`);
    }
    this.instances.set(name, instance);
    this.dependents.set(instance, []);
    return instance;
  }

  /**
   * {@link assembleToolkit}, also recording which Toolkits depend on which
   * of this Host's instances.
   */
  assemble<TDeps extends Readonly<Record<string, ToolkitRS>>>(
    create: (deps: TDeps) => AgentToolkit,
    deps: TDeps,
  ): AgentToolkit {
    const toolkit = assembleToolkit(create, deps);
    for (const instance of Object.values(deps)) {
      this.dependents.get(instance as HostOwnedRS)?.push(toolkit.name);
    }
    return toolkit;
  }

  async start(options: HostRSStartOptions = {}): Promise<void> {
    const warn = options.warn ?? console.warn;
    const initialRetryMs = options.initialRetryMs ?? DEFAULT_INITIAL_RETRY_MS;
    const maxRetryMs = options.maxRetryMs ?? DEFAULT_MAX_RETRY_MS;
    await Promise.all([...this.instances].map(async ([name, instance]) => {
      if (!instance.start) return;
      try {
        await instance.start();
      } catch (error) {
        warn(`[rs] ${name} (${instance.contract}) failed to start: ${describeError(error)}`);
        this.scheduleRetry(name, instance, initialRetryMs, maxRetryMs, warn, options.onRecovered);
      }
    }));
  }

  private scheduleRetry(
    name: string,
    instance: HostOwnedRS,
    delayMs: number,
    maxRetryMs: number,
    warn: (message: string) => void,
    onRecovered: HostRSStartOptions['onRecovered'],
  ): void {
    if (this.disposed || !instance.start) return;
    const timer = setTimeout(() => {
      this.retryTimers.delete(timer);
      if (this.disposed) return;
      void (async () => {
        try {
          await instance.start!();
        } catch {
          this.scheduleRetry(
            name,
            instance,
            Math.min(delayMs * 2, maxRetryMs),
            maxRetryMs,
            warn,
            onRecovered,
          );
          return;
        }
        if (this.disposed) return;
        try {
          await onRecovered?.([...(this.dependents.get(instance) ?? [])]);
        } catch (error) {
          warn(`[rs] ${name} recovered but refreshing its Toolkits failed: ${describeError(error)}`);
        }
      })();
    }, delayMs);
    // Retrying must never keep the Host process alive on its own.
    timer.unref?.();
    this.retryTimers.add(timer);
  }

  async status(): Promise<readonly HostRSStatus[]> {
    return Object.freeze(await Promise.all(
      [...this.instances].map(async ([name, instance]) => {
        let availability: ToolkitAvailability;
        try {
          availability = await instance.status();
        } catch (error) {
          availability = { available: false, reason: describeError(error) };
        }
        return Object.freeze({
          name,
          contract: instance.contract,
          version: instance.version,
          availability,
        });
      }),
    ));
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const timer of this.retryTimers) clearTimeout(timer);
    this.retryTimers.clear();
    const results = await Promise.allSettled(
      [...this.instances.values()].map(async (instance) => await instance.dispose()),
    );
    this.instances.clear();
    this.dependents.clear();
    const errors = results
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason as unknown);
    if (errors.length > 0) {
      throw new AggregateError(errors, `Host RS disposal failed: ${errors.map(describeError).join('; ')}`);
    }
  }
}
