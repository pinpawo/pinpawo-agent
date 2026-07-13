# Local-agent session projection

`LocalAgentSession` is the client-neutral, in-memory projection consumed by the local TUI and future hosted clients. It is not a second durable conversation store.

## Authority

- The LangGraph checkpoint owns durable conversation messages and pending continuation state.
- `LocalAgentSessionSnapshot` is a complete reconciliation input derived from checkpoint data plus current local runtime state.
- Runtime and control events update the projection between snapshots.
- Operation and subagent history remains live/session-scoped and is not restored across a local-agent restart.
- Partial `ReviewDraft` decisions are client-local interaction state and are not part of the shared snapshot.

## Shape

A session owns one ordered timeline and zero or one active run. The previous `runs[] + activeRunId` snapshot shape and the TUI run registry are compatibility inputs only; they are normalized to `activeRun` at the local client boundary.

## Snapshot sources

- `startup`: replaces checkpoint-derived state; omitted optional usage does not preserve a previous process value.
- `reconnect`: reconciles missed server changes and preserves current token usage when the snapshot omits it.
- `resume`: focuses the resumed session, clears the previously focused session's active run, and resets chat/studio UI mode.
- `reconcile`: replaces authoritative timeline/run state after terminal or review-routing events while preserving omitted token usage.

Ink/React state, composer focus, viewport state, sockets, filesystem handles, and partial review drafts are outside this contract.
