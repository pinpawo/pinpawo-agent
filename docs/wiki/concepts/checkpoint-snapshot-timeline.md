---
title: Checkpoint, Snapshot, Timeline, and Timeline State
page_type: concept
status: validated
updated: 2026-07-28
sources:
  - ../../LOCAL_AGENT_SESSION_PROJECTION.md
  - ../../../packages/agent-session/src/project.ts
  - ../../../packages/agent-session/src/snapshot.ts
  - ../../../services/local-agent/src/localAgentSessionSnapshot.ts
  - https://github.com/pinpawo/pinpawo-agent/issues/377
related:
  - ../local-agent-session-projection.md
  - ../interruption-and-delegation-continuation.md
  - session-projection-ownership.md
  - ../decisions/run-view-discriminated-union.md
---

# Checkpoint, Snapshot, Timeline, and Timeline State

## Why these four are distinct

**Decision.** These four terms describe different things and must not be used
interchangeably. Flattening them was the original source of overlapping session
representations that the projection refactor removed (issue #377).

- **Checkpoint** — the durable authority. LangGraph owns durable conversation
  messages and pending continuation state in checkpoints.
- **Snapshot** — a materialized value of a defined scope at one checkpoint point.
  A snapshot does **not** by itself imply recovery, reconciliation, startup, or
  any other use.
- **Timeline** — the ordered UI container used to present a session.
- **Timeline state** — the current mutable instance of that container. Runtime
  and control events may update it between checkpoint points.

## Lifecycle

```text
checkpoint Cn
    -> snapshot(Cn)
    -> timeline state
    -> live runtime/control events mutate timeline state
    -> message.completed commits checkpoint Cn+1
    -> snapshot(Cn+1) replaces timeline state
```

**Decision.** Applying the latest snapshot after `message.completed` is
intentional. Operation and subagent entries that exist only in the live timeline
state may disappear at that point, because they are not part of the
checkpoint-derived snapshot. They are session-scoped presentation state, not
durable history. Reconstructing execution detail from checkpoint history is a
separate, deferred capability — the projection must not invent a second authority
or a merge policy to retain live-only entries.

## Application reasons are not snapshot kinds

**Decision.** Startup, reconnect, resume, completion, and review-state refresh
are *reasons* a client may apply a snapshot. They are not different kinds of
snapshot and do not change what a snapshot means. The shared
`applySessionSnapshot` takes application *policy* options (for example, whether to
retain omitted token usage); the workflow reason stays at the TUI boundary as
`TuiSnapshotApplyReason`. This keeps the shared reducer free of client workflow
labels.

## Checkpoint coordinate is implicit today

**Fact.** The current `/snapshot` endpoint materializes the *latest* checkpoint
point for the selected session/thread; its checkpoint coordinate is implicit.
Explicit historical-point lookup and execution-detail reconstruction are possible
future capabilities, not part of this contract.
