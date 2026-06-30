# Guard Registry Design

> Status: canonical. Updated: 2026-06-29.

This is the source of truth for guard design. Older limit/fuse/loop-guard design notes are deprecated and should point here.

## Core Contract

Guards are deterministic `rule + handler` pairs:

- `rule.check({ state, config, position })` returns `pass` or `block`.
- `handler.handle(...)` returns a domain state update, or `null`.
- The caller at each graph or middleware position decides how to apply the update.
- Async business work belongs in a position-bound `onBlock` callback passed to `registry.run(...)`, or in the guard's default handler, not in the rule.

The shared implementation is `packages/pet-agent/src/guards.ts`.

## Registry

Guards are registered by domain:

- Orchestrator: `packages/pet-agent/src/agent/orchestrator/guardDefinitions/`
- Subagent: `packages/pet-agent/src/subagent/guardDefinitions/`

Each domain exposes a registry factory. The main flow calls `registry.run(name, { state, config, position }, { onBlock })` and receives:

- `result`: whether the guard passed or blocked
- `update`: the state patch produced by the handler

The registry is created once per runtime/graph scope, not as a module-level
singleton. Today registries only hold guard definitions, but this lifetime keeps
the boundary safe if a future guard needs guard-local state.

A guard is a lifecycle binding, not just a reusable predicate. It owns the
domain registry, name, positions, result details, and default handler shape.
When two domains share the same deterministic decision logic but differ in
lifecycle position or update handling, keep separate domain guards and share the
small rule helper they both call.

Prefer durable workflow state in the graph/subagent state when the value must
survive resume, checkpoint restore, or handoff. Keep guard-local state scoped to
the registry/runner only for ephemeral runtime concerns, such as memoized guard
lookups, runtime counters that do not need checkpointing, or per-run caches.
Per-invocation data such as LangGraph's node `runnableConfig` is not part of
guard config; bind it in the position's `onBlock` callback.

## Runners And Adapters

The shared runner factory is `createGuardRunner(registry, adapter)`.
It keeps `registry.run(...)` as the only execution primitive while letting each
runtime position define how its local input becomes guard input.

Current adapters:

- Orchestrator node adapter: maps LangGraph node state plus `runnableConfig`
  into `{ state, config, position }`.
- Subagent middleware adapter: maps middleware hook messages plus hook-local
  counters into `{ state, config, position }`.

This is an adapter distinction, not a second guard system. Node guards and
middleware guards share the same rule, registry, result, and handler contract.
Only the caller decides how to apply `GuardRunResult.update`.

The runner adapter does not make one registered guard span multiple domain
registries. It only maps runtime-local input into that domain registry's
`{ state, config, position }` shape. Cross-domain reuse should happen in small,
domain-independent helpers called from each domain guard's `rule.check(...)`.

For subagents, `SubagentInputState` is the subagent graph/input state shape. `SubagentRunInput` is the full invocation input and adds runtime dependencies such as model, tools, checkpoint, runnable config, signal, and event callbacks. Do not split state fields back into a parallel guard config.

Subagent middleware guards use the same registry contract, but the middleware
adapter owns the lifecycle-specific translation. Before running a guard,
middleware snapshots `SubagentInputState` plus hook-local fields such as current
messages, `iterationCount`, and resolved `maxIterations` into `SubagentState`.
The guard still receives only `{ state, config, position }`; transient runtime
dependencies such as model, tools, checkpoint, runnable config, signal, and
event callbacks stay outside guard input.

## Subagent Middleware Contract

Subagent middleware positions are intentionally narrow:

- `subagent.before_model_context_policy`: before a model call, decide whether
  the subagent transcript should be rewritten because the context watermark has
  been reached.
- `subagent.before_model_iteration`: before a model call, decide whether the
  soft subagent model-call budget has been exceeded.

Other middleware hooks, such as after-model, before-tool, after-tool,
`beforeRun`, and `afterRun`, are not guard positions unless a deterministic
pass/block workflow decision is introduced for them. Runtime invariants that
cannot continue safely should throw or return through their owning middleware
rather than becoming business guards.

Subagent middleware guard rules remain deterministic:

- read only `SubagentState`, `SubagentGuardConfig`, and the position;
- return only `pass` or `block`;
- do not rewrite messages, call models, execute tools, persist artifacts, or
  inspect runtime dependencies.

Subagent middleware guards still return the shared `GuardRunResult` shape:
`result` plus a domain `update`. The update is a small subagent state patch
today, but the middleware position owns how that run result is applied:

- context policy uses a position-bound `onBlock` handler to call the existing
  context rewrite executor and returns the resulting message patch from
  `beforeModel`;
- iteration limit uses the guard's default handler to append a marked stop
  message, and `wrapModelCall` turns a block result into `Command({ goto: END,
  update })`.

This keeps the shared guard concept aligned with orchestrator guards while
leaving model-input rewrite, context rewrite, stop behavior, and artifact
persistence owned by the middleware or capability executor that understands that
lifecycle position.

## Current Guards

The orchestrator flow uses guards for:

- run state reset
- context compaction watermark
- forced capability seed
- delegation outcome handoff gate
- run iteration limit

The subagent flow uses guards for:

- context rewrite watermark
- subagent iteration limit

## What Is Not A Guard

Context compaction/rewrite execution is not itself the guard. The guard only decides whether the watermark is reached.

The executor remains a handler/executor concern:

- Orchestrator compaction calls `compactOrchestratorMessages`.
- Subagent context rewrite delegates to the current rewrite executor/handler.

LangGraph `recursionLimit` is also not our guard. It stays as a runtime hard breaker after our soft guards and handlers have had a chance to stop or compact gracefully.

Repeated-input detection is not part of the guard layer. It was removed from the subagent main path because it checked too frequently and did not fit the current guard abstraction.

Node precondition assertions are not guards. For example, capability/general nodes must throw directly when they run without a matching pending delegation; there is no pass/block workflow decision to make at that point.

## Token Signals

Token-triggered compaction and rewrite use provider usage metadata:

- Orchestrator session compaction reads the latest main-conversation AI message input tokens.
- Subagent context rewrite reads the latest provider input tokens from the subagent messages and compares them to the guard config's context window.

`contextWindowTokens` is guard config, not compaction-specific config.
Compaction-specific settings such as `keepMessages` stay under the compaction
config.

Both positions call the same token usage helper,
`checkProviderInputWatermark(...)`, from inside their own guard rule:
`contextWindowTokens * 0.75` compared with the latest provider input tokens.
When the current input has no provider usage or no context window, the rule
passes.
They do not share handlers: orchestrator compaction, subagent context rewrite,
and explore ingest remain separate executors attached to their own lifecycle
positions.

Local token estimation is not a normal control signal for guard decisions.

## Stop Semantics

Subagent iteration-limit guard blocks by appending a marked AI notice and returning `Command({ goto: END })` from the `wrapModelCall` middleware position. `createSubagent` only treats the final message as a guard stop if it carries the closed marker from `subagent/guardStop.ts`.

The orchestrator receives this as `completionReason: 'limit_reached'` and decides whether to hand off, continue, or stop through its own guard and decision chain.
