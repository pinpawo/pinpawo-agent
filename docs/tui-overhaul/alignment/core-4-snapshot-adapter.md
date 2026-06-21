# CORE-4: Snapshot Adapter

## Scope

Introduce the `session.snapshot.loaded` reducer path and adapt existing startup/resume history payloads into the unified session snapshot model.

## Design Baseline

- `session.snapshot.loaded` is the only reducer action that restores session facts from server state.
- Snapshot timeline is the checkpoint message projection, not `history` or `transcript`.
- Snapshot state may include runtime, token usage, active run, and pending review metadata.
- Reconnect should later use the same adapter/reducer path.

## Implemented In This Slice

- Add a TUI snapshot adapter for legacy `/history` messages.
- Convert startup restore from `session.replace_history` to `session.snapshot.loaded`.
- Convert resume restore from `session.clear + session.replace_history` to `session.snapshot.loaded`.
- Add reducer support for merging snapshot timeline, runtime, token usage, active run, and legacy run routes.
- Add tests for adapter projection, local client snapshots, and reducer snapshot loading.

## Deferred CORE-4/CORE-5 Changes

- Add or consume a first-class server snapshot endpoint.
- Restore pending review panels from server-provided review specs.
- Route reconnect through `session.snapshot.loaded`.
- Remove legacy `session.replace_history` once all callsites migrate.
- Remove `runRoute` after CORE-3 runtime migration makes `TuiState.runs` authoritative.

## Alignment Log

| Date | Area | Expected Design | Deviation | Reason | Decision | Follow-up | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-06-21 | snapshot source | server should eventually expose checkpoint-native snapshot payloads | current implementation adapts existing `/history` and resume message payloads | no server snapshot endpoint exists yet | use adapter as compatibility layer | CONTRACT-1 / CORE-5 | accepted |
| 2026-06-21 | pending review restoration | pending review should restore from snapshot state | current snapshot contract has review id/status but not full `ReviewSpec` | approval panel needs full review options and body | preserve existing pending review when already present; defer full restoration | CORE-5 Reconnect Reconciliation | deferred |
| 2026-06-21 | run registry ownership | snapshot runs should merge into `TuiState.runs` | runtime state still uses `activeRun + runRoute` | CORE-3 has only established the contract foundation | map snapshot runs into legacy `activeRun/runRoute` until migration | CORE-3 migration slice | deferred |
| 2026-06-21 | resume session kind | resumed snapshot should carry server-provided session kind | current resume payload does not expose kind, and old resume path always restored chat | legacy endpoint lacks enough metadata | keep chat compatibility in adapter | first-class snapshot endpoint | deferred |

## Merge Checklist

- [x] `session.snapshot.loaded` action is handled by the reducer.
- [x] Startup restore dispatches `session.snapshot.loaded`.
- [x] Resume restore dispatches `session.snapshot.loaded`.
- [x] Snapshot adapter excludes system/history notices from checkpoint timeline messages.
- [x] Reconnect behavior is explicitly deferred to CORE-5.
- [x] PR references tracking issue #232.
