# Guard Design

> Status: canonical. Updated: 2026-07-02.
> Supersedes `GUARD_REGISTRY_DESIGN.md`. Older limit/fuse/loop-guard design notes
> are deprecated and should point here.

## What A Guard Is

A guard is a **deterministic control decision point evaluated at a named
position, producing a structured outcome**.

A guard is not necessarily an interceptor. "Guard" is the umbrella noun for
every rule-shaped control decision in the orchestrator and subagent flows —
breakers, maintenance triggers, and derivations alike. The semantic precision
lives in the outcome verbs, not in the family name.

The purpose of this design is a **shared meta-language** for control decisions,
so that "where did it go wrong, and how do we state it" always has a precise
answer:

```
guard (which rule) × position (where) × outcome (what happened)
```

Example sentence in this language:

```
run_iteration_limit @ orchestrator.delegation_outcome_iteration
  → stop(run_iteration_limit_reached, { count: 25, limit: 25 })
```

## Vocabulary

### Nouns: guard names and positions

Guard names and positions are closed enums per domain, and they are the stable
identifiers of the language. They survive any refactor of the execution
mechanics:

- Orchestrator: `ORCHESTRATOR_GUARD_NAME`, `ORCHESTRATOR_GUARD_POSITION`
  (`packages/pet-agent/src/agent/orchestrator/guardDefinitions/types.ts`)
- Subagent: `SUBAGENT_GUARD_NAME`, `SUBAGENT_GUARD_POSITION`
  (`packages/pet-agent/src/subagent/guardDefinitions/types.ts`)

A position answers "where"; a guard name answers "which rule".

### Verbs: the outcome union

The old `pass`/`block` pair is retired. It could not describe the material:
`run_state_reset` "blocked" when state was merely uninitialized, and
`delegation_outcome_decision` patched state on "pass". The verb set is a
discriminated union derived from what the rules actually do:

```ts
type GuardOutcome =
  | { kind: 'proceed' }
  // Breaker: a hard limit was hit; the flow must stop or redirect.
  | { kind: 'stop'; reason: string; details?: Record<string, unknown> }
  // Maintenance trigger: a threshold was crossed; a maintenance action
  // (compaction, rewrite) should run before the flow continues.
  | { kind: 'maintain'; reason: string; details?: Record<string, unknown> }
  // Derivation: the rule decided a state initialization/derivation is due
  // (reset run state, seed candidates, set a flag).
  | { kind: 'derive'; reason: string; details?: Record<string, unknown> };
```

Rules for the verb layer:

- `proceed` means "no action"; it is the only outcome without a reason.
- `reason` is a stable snake_case identifier (e.g.
  `run_iteration_limit_reached`, `context_rewrite_required`). Reasons are part
  of the vocabulary; renaming one is a breaking change to the language.
- `details` carries the evidence the rule used (counts, limits, token
  watermarks). It exists so a decision record is self-explanatory without
  re-deriving state.
- Do not add a verb for runtime invariants that cannot continue safely — those
  throw from their owning node/middleware. Guards only express workflow
  decisions.

## Rule Contract

Each guard's rule is a **pure function**:

```ts
check(input: { state; config; position }): GuardOutcome
```

- Deterministic over its input. No model calls, no tool execution, no I/O, no
  message rewriting, no reading runtime dependencies (model, checkpoint,
  signal, callbacks, `runnableConfig`).
- Declares the **minimal input it reads**, not the widest state shape
  available. Structural typing lets callers pass a larger state object; the
  rule's declared input is its contract. This is what keeps middleware
  call sites free of state-snapshot shims.
- Local token estimation is not a normal control signal; provider usage
  metadata is (see Token Signals).

Effects are **owned by the position**. The host frameworks already provide the
execution contract guards need:

- A LangGraph node is `(state, runnableConfig) → statePatch`.
- A LangChain middleware hook is `beforeModel/wrapModelCall → update | Command`.

The position calls the rule, switches on the outcome kind, and applies the
effect itself (build a patch, run the compaction executor, return
`Command({ goto: END })`). There is no separate handler object, no registry
lookup, and no input adapter — the input mapping at a call site is a plain
expression, and every call site knows its guard and position statically.

Shared logic lives in two places only:

- **Decision helpers**: small pure functions shared across domains, e.g.
  `checkProviderInputWatermark(...)` in `agent/tokenUsage.ts`. When two domains
  share a decision, they share the helper — not a guard object across
  registries.
- **Effect helpers**: e.g. `buildSubagentGuardStopNotice(...)` in
  `subagent/guardStop.ts`. Positions call them when applying an outcome.

## Decision Records

Every guard evaluation produces a **decision record** — the sentence this
language exists to speak. Evaluation goes through one choke point so records
cannot be silently dropped (the failure mode of the previous design, where
block reasons and details were computed and discarded):

```ts
type GuardDecisionRecord = {
  guard: string;         // guard name
  position: string;      // where it was evaluated
  outcome: GuardOutcome; // kind + reason + details
  runId?: string;
  iteration?: number;
};

function evaluateGuard(guard, input, emit): GuardOutcome {
  const outcome = guard.check(input);
  emit({ guard: guard.name, position: input.position, outcome, ... });
  return outcome;
}
```

`evaluateGuard` is the entire engine. It exists to emit, not to abstract
execution.

Records have two lifetimes, following the context-governance principle that
conclusions cross boundaries and transcripts do not:

- **Ephemeral channel**: orchestrator positions emit each record twice — onto
  the LangGraph custom stream (`streamMode: 'custom'`, via the node config's
  `writer`), which is how records surface as root `custom` protocol events for
  local-agent stream consumers, and via `dispatchCustomEvent`, which is how
  they reach LangGraph `streamEvents` consumers and the LangSmith trace.
  Subagent middlewares emit runtime records through the shared stream-writer
  envelope so they surface as root `custom` protocol events.
  Debugging "where did it go wrong" is filtering this log by position; the TUI
  can surface `maintain` records ("context compacted at 78% watermark") and
  `stop` records ("subagent hit iteration limit 25/25") without bespoke
  plumbing. Emission is advisory at every layer: `evaluateGuard` swallows
  emitter failures — a record must never fail the decision.
- **Durable form**: only `stop` outcomes need to survive checkpoints and cross
  the subagent → orchestrator boundary. Their durable form is the marked stop
  notice (`subagent/guardStop.ts`) appended to messages; the subagent's
  `completionReason: 'limit_reached'` is a projection of a `stop` record, not
  an independent verdict. Do not persist `proceed`/`maintain`/`derive` records
  in graph state.

## Current Guards

| Guard | Position | Verb | Details |
| --- | --- | --- | --- |
| `run_state_reset` | `orchestrator.prepare` | `derive` | — |
| `context_compaction_watermark` | `orchestrator.context_compaction` | `maintain` | `latestInputTokens`, `watermarkTokens`, `mainMessageCount`, `keepMessages` |
| `forced_capability_seed` | `orchestrator.capability_discovery` | `derive` | seeded candidate names |
| `delegation_outcome_decision` | `orchestrator.delegation_outcome_decision` | `derive` | `completionReason`, resulting `canHandoffActiveDelegation` |
| `run_iteration_limit` | `orchestrator.delegation_outcome_iteration` | `stop` | `runIterationCount`, `runIterationLimit` |
| `context_rewrite_watermark` | `subagent.before_model_context_policy` | `maintain` | `latestInputTokens`, `watermarkTokens` |
| `iteration_limit` | `subagent.before_model_iteration` | `stop` | `iterationCount`, `maxIterations` |

Notes:

- `delegation_outcome_decision` sets `canHandoffActiveDelegation` on **every**
  evaluation (both when handoff is allowed and when it is not). Under
  `pass`/`block` this was a contradiction; as a `derive` it is simply the rule
  doing its job. When it derives "handoff not allowed", the reason is
  `active_delegation_limit_reached`.
- The two `stop` guards and the two `maintain` guards share decision helpers
  (limit comparison, `checkProviderInputWatermark`), not guard objects.

## What There Is No More

- **No `GuardRegistry` on the main path.** Every call site names its guard and
  position statically; a string-keyed lookup with a runtime position assertion
  added indirection without adding safety. The registry pattern returns only
  if guards become dynamically registered — see Future.
- **No runner/adapter layer.** `createGuardRunner`-style input adapters existed
  to map runtime input into a fixed wide guard-state shape. With minimal rule
  inputs, the mapping at each call site is an object literal.
- **No `handler` object on the guard.** The default-handler vs `onBlock`
  split moved effect logic away from the position that owns it. Effects live
  at positions; shared effect logic lives in helpers.
- **No `pass`/`block`.** Replaced by the outcome union.

## What Is Not A Guard

Unchanged from the previous design, restated in the new vocabulary:

- Compaction/rewrite **execution** is not the guard. The guard produces
  `maintain`; the executor (`compactOrchestratorMessages`, the context rewrite
  executor) is position-owned effect code.
- LangGraph `recursionLimit` is not a guard. It stays as a deliberately high
  hard breaker after `stop` guards have had their chance.
- Node precondition assertions are not guards. A capability/general node that
  runs without a matching pending delegation throws; there is no workflow
  decision to record.
- Repeated-input detection stays out of the guard layer.

## Token Signals

Token-triggered `maintain` decisions read provider usage metadata:

- Orchestrator compaction reads the latest main-conversation AI message input
  tokens.
- Subagent context rewrite reads the latest provider input tokens from the
  subagent messages.

Both compare against the context window through the shared decision helper
`checkProviderInputWatermark(latestInputTokens, contextWindowTokens)`
(threshold ratio 0.75). When there is no provider usage or no context window,
the rule proceeds.

## Stop Semantics

A `stop` outcome is applied by its position:

- Subagent `iteration_limit`: `wrapModelCall` appends the marked stop notice
  and returns `Command({ goto: END })`. `createSubagent` treats the final
  message as a guard stop only if it carries the closed marker from
  `subagent/guardStop.ts`, and reports `completionReason: 'limit_reached'`.
- Orchestrator `run_iteration_limit`: the guard node patches in the limit
  notice, resets the run iteration counter, and forces an inline final reply
  while keeping the active delegation resumable.

The orchestrator receives a subagent stop as `completionReason:
'limit_reached'` — a stop-reason hint from a downstream `stop` record — and
decides whether to hand off, continue, or stop through its own guards.

## Future: When A Registry Earns Its Way Back

Two cross-cutting needs would justify reintroducing shared execution
machinery, and only these:

1. **Capability-registered guards.** If capability plugins can contribute
   guards, a per-domain registry returns — but consumed as
   `for (guard of registry.list(position))` (enumerate-by-position), never as
   point lookups by name. Enumeration is the only registry access pattern that
   pays for the indirection.
2. **Richer record consumers.** If decision records grow consumers with
   delivery requirements (persistence, replay, external sinks), the `emit`
   side of `evaluateGuard` grows — the rule contract does not change.

Do not add either speculatively.

## Migration From The Previous Design

Landed in two commits (the original phase 1 and phase 3 were folded: the
`pass`/`block` types and the outcome union could not coexist under the same
names):

1. **Speak the language + remove the machinery (no behavior change).**
   `GuardOutcome` replaces `pass`/`block`; the 7 rules are retyped to their
   verbs; call sites switch on `outcome.kind`; handlers' effect logic moves
   into the positions (or effect helpers) verbatim. `forced_capability_seed`
   stops computing its seed state twice (the rule puts it in `details`; the
   position applies it). `GuardRegistry` and the handler objects are deleted;
   `guardDefinitions/` keeps the name and position enums, the rule values,
   and their tests.
2. **Emit records.** `evaluateGuard` gains the `emit` hook; orchestrator
   positions emit `pinpawo_guard_decision` custom events, subagent middlewares
   emit the `subagent_guard_decision` runtime event.
3. **Registry revisit** only when capability-registered guards are scheduled.

Relation to PR #304: the shared `checkProviderInputWatermark` helper and the
`contextWindowTokens` config placement carry forward as-is; the runner/adapter
layer it introduced is superseded by this design.
