# CORE-7: Core Closure

## Scope

Close the CORE series by turning the run registry contract into concrete runtime state and documenting the remaining compatibility mirrors that must not expand.

This PR is not a UI layout PR. It prepares the next UI work by making core ownership explicit.

## Design Baseline

- `timeline` remains the user/tool checkpoint projection.
- `TuiState.runs[runId]` is the concrete run registry.
- `SessionModel.activeRunId` is the session active pointer.
- `SessionModel.activeRun` and `TuiState.runRoute` are compatibility mirrors only.
- `SessionModel.history` is compatibility state for transcript export and legacy adapters only.

## Implemented In This Slice

- Add `TuiState.runs: Record<RunId, TuiRunModel>`.
- Add `SessionModel.activeRunId`.
- Reconcile the run registry after reducer actions so existing runtime paths stay consistent.
- Make focused run selectors read from `TuiState.runs` first.
- Add tests for run registry creation, snapshot restoration, and cleanup.

## Deferred Changes

- Delete `SessionModel.activeRun` after event routing and pending review callsites read only from `runs`.
- Delete `TuiState.runRoute` after reducer routing reads only from `runs[requestId].sessionId`.
- Delete `SessionModel.history` after transcript export reads from timeline or a dedicated transcript projection.
- Move non-checkpoint visual entries (`review`, `notice`, `error`, `studio.progress`) behind dedicated state/render owners.

## Alignment Log

| Date | Area | Expected Design | Deviation | Reason | Decision | Follow-up | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-06-21 | run registry runtime | `TuiState.runs` should exist before UI work depends on run ownership | CORE-3 only defined the contract | reducer migration needed CORE-4/5/6 baseline first | add registry and reconcile it from current runtime state | remove legacy mirrors in focused follow-up | accepted |
| 2026-06-21 | legacy run mirrors | `activeRun` and `runRoute` should disappear | both still exist | deleting both now would combine routing, selector, pending review, and interrupt behavior changes | keep them as mirrors, not as new ownership surfaces | remove after registry-routed reducer paths land | deferred |
| 2026-06-21 | history compatibility | timeline should be the only message log | `history` still exists | export command and legacy adapters still consume history | keep `history` compatibility bounded and documented | migrate export/adapters | deferred |

## Merge Checklist

- [x] CORE-7 alignment document exists.
- [x] Runtime state has a concrete run registry.
- [x] Focused active run selector reads registry first.
- [x] Snapshot restoration populates registry.
- [x] Session clear and run finish remove registry entries.
- [x] Remaining legacy mirrors are explicitly documented.
- [x] PR references tracking issue #232.
