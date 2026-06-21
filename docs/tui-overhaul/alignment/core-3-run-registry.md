# CORE-3: Run Registry

## Scope

Replace the ambiguous `activeRun + runRoute` model with a global run registry and an explicit session active pointer.

This is the first CORE-3 slice. It defines the target run registry contract and callsite migration checklist before reducer migration.

## Design Baseline

- `TuiState.runs[runId]` owns run lifecycle state.
- `session.activeRunId` is only a pointer to the current active run for that session.
- Event routing derives from `runs[runId].sessionId`.
- terminal events can update or close a run even when the focused active pointer has changed.
- Current TUI run ids remain request-id compatible until the backend exposes a distinct run id.

## Expected Changes

- Introduce `TuiState.runs: Record<RunId, TuiRunModel>`.
- Replace `runRoute` lookups with run registry ownership.
- Derive busy, pending approval, active operation, and terminal state from run registry.
- Terminalize completed/error/interrupted events by run id.

## Deferred CORE-3 Changes

- Migrate `TuiState` from `runRoute` to run registry ownership.
- Remove `SessionModel.activeRun` as full run semantics holder.
- Migrate `tuiStateReducer` event routing from session active pointer to `runs[requestId].sessionId`.
- Remove legacy runRoute cleanup logic once registry is authoritative.

## Out Of Scope

- Timeline message authority work owned by CORE-2.
- Snapshot endpoint implementation owned by CORE-4.
- Reconnect reconciliation owned by CORE-5.
- UI layout cleanup.

## Alignment Log

| Date | Area | Expected Design | Deviation | Reason | Decision | Follow-up | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-06-21 | run registry migration | `TuiState.runs[runId] + SessionModel.activeRunId` should replace `activeRun + runRoute` for routing and terminalization | reducer/controller still route by `runRoute` and use `SessionModel.activeRun` | run migration is a large reducer refactor that depends on CORE-2 and CORE-4 follow-up | keep runtime model unchanged for this slice; add contract and gap registry | CORE-3 full implementation slice after baseline contract land | deferred |
| 2026-06-21 | pending review derivation | pending approval state should be derivable from run registry or an explicit state map | earlier contract used only `pendingReviewId`, which loses waiting/answered/interrupted status | CORE-1 snapshot already carries pending review status on run snapshots | align CORE-3 run model with the CORE-1 pending review shape | CORE-5 snapshot reconciliation consumes the aligned shape | accepted |

## Open Questions

- Should the backend eventually expose a distinct run id, or should TUI continue treating `RunId` as request-id compatible?

## Merge Checklist

- [ ] `activeRun` no longer stores full run entity semantics.
- [ ] `runRoute` is removed or has a documented removal follow-up.
- [ ] Terminal events do not silently drop because the active pointer is missing.
- [x] PR references tracking issue #232.

This checklist is milestone-level. This PR only establishes model/contract foundations; implementation migration is follow-up.
