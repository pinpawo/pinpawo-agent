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

Rules are registered by domain:

- Orchestrator: `packages/pet-agent/src/agent/orchestrator/guardDefinitions/`
- Subagent: `packages/pet-agent/src/subagent/guardDefinitions/`

Each domain exposes a registry factory. The main flow calls `registry.run(name, { state, config, position }, { onBlock })` and receives:

- `result`: whether the guard passed or blocked
- `update`: the state patch produced by the handler

The registry is created once per runtime/graph scope. Per-invocation data such as LangGraph's node `runnableConfig` is not part of guard config; bind it in the position's `onBlock` callback.

For subagents, `SubagentInputState` is the subagent graph/input state shape. `SubagentRunInput` is the full invocation input and adds runtime dependencies such as model, tools, checkpoint, runnable config, signal, and event callbacks. Do not split state fields back into a parallel guard config.

Middleware guard execution is intentionally deferred from this node-guard migration. The current subagent middleware adapter snapshots `SubagentInputState` plus hook-local fields such as current messages and iteration count. A later middleware-guard design should decide whether those fields move into LangChain middleware `stateSchema`.

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
- Subagent context rewrite reads the latest provider input tokens from the subagent messages and compares them to the subagent run state's context window.

Local token estimation is not a normal control signal for guard decisions.

## Stop Semantics

Subagent iteration-limit guard blocks by appending a marked AI notice and returning `Command({ goto: END })` from the `wrapModelCall` middleware position. `createSubagent` only treats the final message as a guard stop if it carries the closed marker from `subagent/guardStop.ts`.

The orchestrator receives this as `completionReason: 'limit_reached'` and decides whether to hand off, continue, or stop through its own guard and decision chain.
