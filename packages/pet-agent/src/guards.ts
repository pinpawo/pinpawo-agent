export type GuardInput<State, Config, Position extends string> = {
  state: State;
  config: Config;
  position: Position;
};

export type GuardCheckStatus = 'pass' | 'block';

export type GuardPass = {
  status: 'pass';
};

export type GuardBlock = {
  status: 'block';
  reason: string;
  details?: unknown;
};

export type GuardCheckResult =
  | GuardPass
  | GuardBlock;

export type GuardRule<
  State,
  Config,
  Position extends string,
> = {
  check(input: GuardInput<State, Config, Position>): GuardCheckResult;
};

export type GuardHandlerInput<
  State,
  Config,
  Position extends string,
> = GuardInput<State, Config, Position> & {
  guardName: string;
  result: GuardCheckResult;
};

export type GuardHandler<
  State,
  Config,
  Position extends string,
  Effect,
> = {
  handle(input: GuardHandlerInput<State, Config, Position>): Effect | null | Promise<Effect | null>;
};

export type Guard<
  State,
  Config,
  Position extends string,
  Effect,
> = {
  readonly name: string;
  readonly positions: readonly Position[];
  readonly rule: GuardRule<State, Config, Position>;
  readonly handler: GuardHandler<State, Config, Position, Effect>;
};

export const GUARD_PASS: GuardPass = { status: 'pass' };

export function guardPass(): GuardPass {
  return GUARD_PASS;
}

export function guardBlock(reason: string): GuardBlock;
export function guardBlock(reason: string, details: unknown): GuardBlock;
export function guardBlock(reason: string, details?: unknown): GuardBlock {
  return details === undefined
    ? { status: 'block', reason }
    : { status: 'block', reason, details };
}

export function defineGuard<
  State,
  Config,
  Position extends string,
  Effect,
>(guard: Guard<State, Config, Position, Effect>) {
  return guard;
}

export function guardAppliesToPosition<Position extends string>(
  guard: { readonly positions: readonly Position[] },
  position: Position,
): boolean {
  return guard.positions.includes(position);
}

export class GuardRegistry<
  State,
  Config,
  Position extends string,
  Effect,
> {
  private readonly guards = new Map<string, Guard<State, Config, Position, Effect>>();

  register(guard: Guard<State, Config, Position, Effect>): void {
    if (guard.positions.length === 0) {
      throw new Error(`Guard must declare at least one position: ${guard.name}`);
    }
    if (this.guards.has(guard.name)) {
      throw new Error(`Guard already registered: ${guard.name}`);
    }
    this.guards.set(guard.name, guard);
  }

  list(position?: Position): Guard<State, Config, Position, Effect>[] {
    const guards = [...this.guards.values()];
    return position === undefined
      ? guards
      : guards.filter((guard) => guardAppliesToPosition(guard, position));
  }

  get(name: string): Guard<State, Config, Position, Effect> | null {
    return this.guards.get(name) ?? null;
  }

  check(
    name: string,
    input: GuardInput<State, Config, Position>,
  ): GuardCheckResult {
    const guard = this.requireApplicableGuard(name, input.position);
    return guard.rule.check(input);
  }

  /**
   * Usage:
   *   registry.run('guard_name', { state, config, position })
   *
   * Current orchestrator example after migration:
   *   const effect = await registry.run('run_iteration_limit', {
   *     state: orchestratorState,
   *     config: orchestratorGuardConfig,
   *     position: 'orchestrator.delegation_outcome_iteration',
   *   })
   *   return applyOrchestratorGuardEffect(effect)
   *
   * `run` first verifies the guard is registered for `position`, then calls
   * `rule.check(input)`, then passes that result to `handler.handle(...)`.
   * The returned value is the handler's effect, or null if there is no external
   * interaction to apply. Applying effects is owned by the caller's domain layer,
   * not by this generic registry.
   */
  run(
    name: string,
    input: GuardInput<State, Config, Position>,
  ): Effect | null | Promise<Effect | null> {
    const guard = this.requireApplicableGuard(name, input.position);
    const result = guard.rule.check(input);
    return guard.handler.handle({
      ...input,
      guardName: guard.name,
      result,
    });
  }

  private requireApplicableGuard(
    name: string,
    position: Position,
  ): Guard<State, Config, Position, Effect> {
    const guard = this.guards.get(name);
    if (!guard) {
      throw new Error(`Guard not registered: ${name}`);
    }
    if (!guardAppliesToPosition(guard, position)) {
      throw new Error(`Guard ${name} is not registered for position: ${position}`);
    }
    return guard;
  }
}
