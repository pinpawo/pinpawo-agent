# CORE-4: Snapshot Adapter

## Scope

Introduce the `session.snapshot.loaded` reducer path and adapt existing startup/resume history payloads into the unified session snapshot model.

## Design Baseline

- `session.snapshot.loaded` is the only reducer action that restores session facts from server state.
- Snapshot timeline is the checkpoint message projection, not `history` or `transcript`.
- Snapshot state may include runtime, token usage, active run, and pending review metadata.
- Reconnect should later use the same adapter/reducer path.

## Implemented In This Slice

- Add a TUI snapshot adapter for server `/history`, native `/snapshot`, and resume messages.
- Convert startup restore from `session.replace_history` to `session.snapshot.loaded`.
- Convert resume restore from `session.clear + session.replace_history` to `session.snapshot.loaded`.
- Add reducer support for merging snapshot timeline, runtime, token usage, and active run metadata.
- Add tests for adapter projection, local client snapshots, and reducer snapshot loading.

## Completed Later In CORE-5/CORE-7

- Add and consume a first-class server snapshot endpoint. Completed in CORE-5; native `TuiCoreSessionSnapshot` shape completed in CORE-7.
- Restore pending review panels from server-provided review specs. Completed in CORE-5.
- Route reconnect through `session.snapshot.loaded`. Completed in CORE-5.
- Remove legacy `session.replace_history` once all callsites migrate. Completed in CORE-6.
- Remove `runRoute` after CORE-3 runtime migration makes `TuiState.runs` authoritative. Completed in CORE-7.

## Alignment Log

| Date | Area | Expected Design | Deviation | Reason | Decision | Follow-up | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-06-21 | snapshot source | server should eventually expose checkpoint-native snapshot payloads | CORE-4 initially adapted existing `/history` and resume message payloads | server snapshot endpoint did not exist yet | CORE-5 added `/snapshot`; CORE-7 made `/snapshot` and resume return native `TuiCoreSessionSnapshot` | none | accepted |
| 2026-06-21 | pending review restoration | pending review should restore from snapshot state | CORE-4 snapshot contract had review id/status but not full `ReviewSpec` | approval panel needs full review options and body | CORE-5 restores full `ReviewSpec` from snapshot runs | none | accepted |
| 2026-06-21 | run registry ownership | snapshot runs should merge into `TuiState.runs` | initial CORE-4 slice still had `activeRun + runRoute` compatibility mirrors | CORE-3 established the contract foundation before reducer migration | CORE-7 maps snapshot runs into the registry and removes legacy mirrors | none | accepted |
| 2026-06-21 | resume session kind | resumed snapshot should carry server-provided session kind | CORE-4 resume payload did not expose kind, and old resume path always restored chat | legacy endpoint lacked enough metadata | CORE-7 resume returns a native snapshot with server-provided kind; client keeps chat fallback only for old payloads | none | accepted |
| 2026-06-21 | deferred contract gaps | completed CORE-4 resume migration should not remain listed as deferred | initial implementation left `resume-session-snapshot` in deferred contract metadata | contract list was not updated after implementation | remove resume gap; keep reconnect gaps for CORE-5 | CORE-5 Reconnect Reconciliation | accepted |
| 2026-06-21 | startup history failure | failed history restore should not be treated as authoritative empty checkpoint | initial adapter caught history failures and produced an empty snapshot | best-effort startup restore must be no-op on read failure | make history restore failure reject `readSessionSnapshot` | none | accepted |

## Merge Checklist

- [x] `session.snapshot.loaded` action is handled by the reducer.
- [x] Startup restore dispatches `session.snapshot.loaded`.
- [x] Resume restore dispatches `session.snapshot.loaded`.
- [x] Snapshot adapter excludes system/history notices from checkpoint timeline messages.
- [x] Reconnect behavior is implemented through CORE-5 snapshot reconciliation.
- [x] PR references tracking issue #232.
