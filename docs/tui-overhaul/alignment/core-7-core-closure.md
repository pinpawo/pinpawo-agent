# CORE-7: Core Closure

## Scope

Close the CORE series by turning the run registry contract into concrete runtime state and deleting the runtime compatibility mirrors that kept old ownership paths alive.

This PR is not a UI layout PR. It prepares the next UI work by making core ownership explicit.

## Design Baseline

- `timeline` remains the user/tool checkpoint projection.
- `TuiState.runs[runId]` is the concrete run registry.
- `SessionModel.activeRunId` is the session active pointer.
- `SessionModel` owns timeline, runtime metadata, token usage, and `activeRunId`; it does not own a parallel history log.
- `SessionModel.notices` owns UI/system notifications that are not checkpoint timeline facts.
- Server checkpoint/resume messages are adapted into snapshot timeline entries at the TUI client boundary.

## Implemented In This Slice

- Add `TuiState.runs: Record<RunId, TuiRunModel>`.
- Add `SessionModel.activeRunId`.
- Route run events through `TuiState.runs[requestId].sessionId`.
- Make focused run selectors read from `TuiState.runs`.
- Remove `SessionModel.activeRun`, `TuiState.runRoute`, and `SessionModel.history`.
- Make transcript export read from `SessionModel.timeline`.
- Stop returning a parallel `history` payload from resume.
- Move non-checkpoint visual entries (`review`, `notice`, `error`, `studio.progress`) out of timeline. Review state lives on runs/pending approval; system feedback lives in `SessionModel.notices`.
- Rename internal message append/cell concepts away from `history.*`; keep `/history` naming only at the server compatibility boundary.
- Add tests for run registry creation, snapshot restoration, and cleanup.

## Deferred Changes

- Decide whether subagent streaming output should remain a timeline message role or move into a dedicated activity stream in the UI layout work.

## Alignment Log

| Date | Area | Expected Design | Deviation | Reason | Decision | Follow-up | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-06-21 | run registry runtime | `TuiState.runs` should exist before UI work depends on run ownership | CORE-3 only defined the contract | reducer migration needed CORE-4/5/6 baseline first | add registry and route reducer events through it | none | accepted |
| 2026-06-21 | legacy run mirrors | `activeRun` and `runRoute` should disappear | old PR draft kept both as mirrors | keeping mirrors preserves the confusing ownership model | delete both in CORE-7 instead of documenting another follow-up | none | accepted |
| 2026-06-21 | history compatibility | timeline should be the only message log | old PR draft kept `SessionModel.history` for export and adapter reads | it reintroduced a second live message log | export from timeline and keep server message conversion at the client boundary only | none | accepted |
| 2026-06-21 | visual timeline entries | checkpoint timeline should not carry review/notices/errors/progress | timeline still carried non-checkpoint render entries | command/system feedback still needed a visible owner | store system feedback in `SessionModel.notices`; keep review state on runs/pending approval | subagent activity decision in UI layout work | accepted |

## Merge Checklist

- [x] CORE-7 alignment document exists.
- [x] Runtime state has a concrete run registry.
- [x] Focused active run selector reads registry first.
- [x] Snapshot restoration populates registry.
- [x] Session clear and run finish remove registry entries.
- [x] Legacy runtime mirrors are removed.
- [x] Non-checkpoint visual entries are removed from timeline.
- [x] PR references tracking issue #232.
