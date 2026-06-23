# CORE-3: Run Registry

## Scope

Replace the ambiguous `activeRun + runRoute` model with a global run registry and an explicit session active pointer.

CORE-3 defines the target run registry contract and callsite migration checklist. CORE-7 completes the reducer/runtime migration.

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

## Completed Follow-up

- CORE-7 migrates `TuiState` from `runRoute` to run registry ownership.
- CORE-7 removes `SessionModel.activeRun` as a full run semantics holder.
- CORE-7 routes `tuiStateReducer` events through `runs[requestId].sessionId`.
- CORE-7 removes legacy `runRoute` cleanup logic.

## Out Of Scope

- Timeline message authority work owned by CORE-2.
- Snapshot endpoint implementation owned by CORE-4.
- Reconnect reconciliation owned by CORE-5.
- UI layout cleanup.

## Alignment Log

| Date | Area | Expected Design | Deviation | Reason | Decision | Follow-up | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-06-21 | run registry migration | `TuiState.runs[runId] + SessionModel.activeRunId` should replace `activeRun + runRoute` for routing and terminalization | initial CORE-3 slice only defined the contract | run migration was a large reducer refactor that depended on CORE-2 and CORE-4 follow-up | complete runtime migration in CORE-7 | none | accepted |
| 2026-06-21 | pending review derivation | pending approval state should be derivable from run registry or an explicit state map | earlier contract used only `pendingReviewId`, which loses waiting/answered/interrupted status | CORE-1 snapshot already carries pending review status on run snapshots | align CORE-3 run model with the CORE-1 pending review shape | CORE-5 snapshot reconciliation consumes the aligned shape | accepted |
| 2026-06-21 | runtime run registry | selectors and runtime state should have a concrete `runs[runId]` source | initial CORE-7 draft kept legacy mirrors | mirrors kept ownership ambiguous | CORE-7 deletes `activeRun` and `runRoute`; selectors read `runs` directly | none | accepted |

## Open Questions

None for this PR. TUI continues treating `RunId` as request-id compatible until a future backend contract exposes a distinct persisted run id.

## Merge Checklist

- [x] `activeRun` no longer stores full run entity semantics.
- [x] `runRoute` is removed.
- [x] Terminal events do not silently drop because the active pointer is missing.
- [x] `TuiState.runs` exists as a concrete runtime registry.
- [x] `SessionModel.activeRunId` exists as the session active pointer.
- [x] PR references tracking issue #232.

This checklist is milestone-level. CORE-7 closes the implementation migration.
