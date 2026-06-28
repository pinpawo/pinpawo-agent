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
  Update,
> = {
  handle(input: GuardHandlerInput<State, Config, Position>): Update | null | Promise<Update | null>;
};

export type Guard<
  State,
  Config,
  Position extends string,
  Update,
> = {
  readonly name: string;
  readonly positions: readonly Position[];
  readonly rule: GuardRule<State, Config, Position>;
  readonly handler: GuardHandler<State, Config, Position, Update>;
};

export type GuardRunResult<Update> = {
  result: GuardCheckResult;
  update: Update | null;
};

export type GuardBlockHandler<
  BlockInput,
  Update,
> = (
  input: BlockInput
) => Update | null | Promise<Update | null>;

export type GuardOptions<
  BlockInput,
  Update,
> = {
  onBlock: GuardBlockHandler<BlockInput, Update>;
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
  Update,
>(guard: Guard<State, Config, Position, Update>) {
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
  Update,
> {
  private readonly guards = new Map<string, Guard<State, Config, Position, Update>>();

  register(guard: Guard<State, Config, Position, Update>): void {
    if (guard.positions.length === 0) {
      throw new Error(`Guard must declare at least one position: ${guard.name}`);
    }
    if (this.guards.has(guard.name)) {
      throw new Error(`Guard already registered: ${guard.name}`);
    }
    this.guards.set(guard.name, guard);
  }

  list(position?: Position): Guard<State, Config, Position, Update>[] {
    const guards = [...this.guards.values()];
    return position === undefined
      ? guards
      : guards.filter((guard) => guardAppliesToPosition(guard, position));
  }

  get(name: string): Guard<State, Config, Position, Update> | null {
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
   *   const { result, update } = await registry.run('run_iteration_limit', {
   *     state: orchestratorState,
   *     config: orchestratorGuardConfig,
   *     position: 'orchestrator.delegation_outcome_iteration',
   *   })
   *   // `result.status` tells the position whether the guard passed or blocked.
   *   // `update` is the state patch produced by the guard handler, if any.
   *
   * `run` first verifies the guard is registered for `position`, then calls
   * `rule.check(input)`, then passes that result to `handler.handle(...)`.
   * The handler returns the final state update for the caller's domain, or null
   * if no update is needed. Async work such as compaction belongs inside the
   * handler or a handler-owned executor.
   */
  async run(
    name: string,
    input: GuardInput<State, Config, Position>,
  ): Promise<GuardRunResult<Update>> {
    const guard = this.requireApplicableGuard(name, input.position);
    const result = guard.rule.check(input);
    const update = await guard.handler.handle({
      ...input,
      guardName: guard.name,
      result,
    });
    return { result, update };
  }

  private requireApplicableGuard(
    name: string,
    position: Position,
  ): Guard<State, Config, Position, Update> {
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
