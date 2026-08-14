// Guard outcome meta-language. See docs/reference/runtime/guards.md.
//
// A guard is a deterministic control decision point evaluated at a named
// position, producing a structured outcome:
//
//   guard (which rule) × position (where) × outcome (what happened)
//
// Effects are owned by the calling position (LangGraph node or middleware
// hook); rules stay pure. `evaluateGuard` is the entire engine — it exists to
// keep evaluation observable, not to abstract execution.

export type GuardDetails = Record<string, unknown>;

export type GuardProceed = { kind: 'proceed' };

export type GuardStop = {
  kind: 'stop';
  reason: string;
  details?: GuardDetails;
};

export type GuardMaintain = {
  kind: 'maintain';
  reason: string;
  details?: GuardDetails;
};

export type GuardDerive = {
  kind: 'derive';
  reason: string;
  details?: GuardDetails;
};

export type GuardOutcome =
  | GuardProceed
  | GuardStop
  | GuardMaintain
  | GuardDerive;

export const GUARD_PROCEED: GuardProceed = { kind: 'proceed' };

export function guardProceed(): GuardProceed {
  return GUARD_PROCEED;
}

export function guardStop(reason: string, details?: GuardDetails): GuardStop {
  return details === undefined
    ? { kind: 'stop', reason }
    : { kind: 'stop', reason, details };
}

export function guardMaintain(reason: string, details?: GuardDetails): GuardMaintain {
  return details === undefined
    ? { kind: 'maintain', reason }
    : { kind: 'maintain', reason, details };
}

export function guardDerive(reason: string, details?: GuardDetails): GuardDerive {
  return details === undefined
    ? { kind: 'derive', reason }
    : { kind: 'derive', reason, details };
}

export type GuardInput<State, Config, Position extends string> = {
  state: State;
  config: Config;
  position: Position;
};

/**
 * A guard declares the minimal input its rule reads, not the widest state
 * shape available — structural typing lets positions pass a larger state
 * object. `check` must be deterministic over its input: no model calls, no
 * tool execution, no I/O, no message rewriting, no runtime dependencies.
 */
export type Guard<State, Config, Position extends string> = {
  readonly name: string;
  readonly positions: readonly Position[];
  check(input: GuardInput<State, Config, Position>): GuardOutcome;
};

export function defineGuard<State, Config, Position extends string>(
  guard: Guard<State, Config, Position>,
): Guard<State, Config, Position> {
  if (guard.positions.length === 0) {
    throw new Error(`Guard must declare at least one position: ${guard.name}`);
  }
  return guard;
}

export function guardAppliesToPosition<Position extends string>(
  guard: { readonly positions: readonly Position[] },
  position: Position,
): boolean {
  return guard.positions.includes(position);
}

/**
 * The sentence this language exists to speak: one record per evaluation,
 * emitted through the `evaluateGuard` choke point so records cannot be
 * silently dropped. Ephemeral by design — only `stop` outcomes have a durable
 * form (marked stop notices), owned by their positions.
 */
export type GuardDecisionRecord = {
  guard: string;
  position: string;
  outcome: GuardOutcome;
  runId?: string;
  iteration?: number;
};

export type GuardDecisionEmitter = (record: GuardDecisionRecord) => void;

export type GuardEvaluateOptions = {
  emit?: GuardDecisionEmitter;
  runId?: string;
  iteration?: number;
};

export function evaluateGuard<State, Config, Position extends string>(
  guard: Guard<State, Config, Position>,
  input: GuardInput<State, Config, Position>,
  options: GuardEvaluateOptions = {},
): GuardOutcome {
  if (!guardAppliesToPosition(guard, input.position)) {
    throw new Error(`Guard ${guard.name} is not declared for position: ${input.position}`);
  }
  const outcome = guard.check(input);
  if (options.emit) {
    // Emission is advisory: a record must never fail the decision, whatever
    // emitter the caller supplies.
    try {
      options.emit({
        guard: guard.name,
        position: input.position,
        outcome,
        ...(options.runId !== undefined ? { runId: options.runId } : {}),
        ...(options.iteration !== undefined ? { iteration: options.iteration } : {}),
      });
    } catch {
      // Ignore emitter failures.
    }
  }
  return outcome;
}
