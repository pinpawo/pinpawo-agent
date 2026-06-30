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

export type GuardBlockHandlerInput<
  State,
  Config,
  Position extends string,
> = GuardInput<State, Config, Position> & {
  guardName: string;
  result: GuardBlock;
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

export type GuardRunOptions<
  State,
  Config,
  Position extends string,
  Update,
> = {
  onBlock?: GuardBlockHandler<GuardBlockHandlerInput<State, Config, Position>, Update>;
};

export type GuardInputAdapter<
  State,
  Config,
  Position extends string,
  RuntimeInput,
> = {
  toGuardInput(position: Position, input: RuntimeInput): GuardInput<State, Config, Position>;
};

export type GuardRunner<
  Name extends string,
  State,
  Config,
  Position extends string,
  Update,
  RuntimeInput,
> = (
  name: Name,
  position: Position,
  input: RuntimeInput,
  options?: GuardRunOptions<State, Config, Position, Update>,
) => Promise<GuardRunResult<Update>>;

export function createGuardRunner<
  Name extends string,
  State,
  Config,
  Position extends string,
  Update,
  RuntimeInput,
>(params: {
  registry: GuardRegistry<State, Config, Position, Update>;
  adapter: GuardInputAdapter<State, Config, Position, RuntimeInput>;
}): GuardRunner<Name, State, Config, Position, Update, RuntimeInput> {
  return (name, position, input, options) => params.registry.run(
    name,
    params.adapter.toGuardInput(position, input),
    options,
  );
}

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
   *   registry.run('guard_name', { state, config, position }, { onBlock })
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
   * `rule.check(input)`. If the rule blocks and the caller supplied `onBlock`,
   * that position-bound callback produces the update. Otherwise the guard's
   * default handler handles the result. Async work such as compaction belongs in
   * `onBlock` or in the guard's default handler, never in the rule.
   */
  async run(
    name: string,
    input: GuardInput<State, Config, Position>,
    options: GuardRunOptions<State, Config, Position, Update> = {},
  ): Promise<GuardRunResult<Update>> {
    const guard = this.requireApplicableGuard(name, input.position);
    const result = guard.rule.check(input);
    const handlerInput = {
      ...input,
      guardName: guard.name,
      result,
    };
    const update = result.status === 'block' && options.onBlock
      ? await options.onBlock({
        ...handlerInput,
        result,
      })
      : await guard.handler.handle(handlerInput);
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
