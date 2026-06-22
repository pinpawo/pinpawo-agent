# CORE-5: Reconnect Reconciliation

## Scope

Route reconnect through the same `session.snapshot.loaded` reconciliation path as startup and resume, and close the known completed-message and pending-review recovery gaps.

## Design Baseline

- Reconnect is a snapshot reconciliation trigger, not an independent recovery path.
- Server snapshot is the source for checkpoint messages and pending review state.
- `message.completed` should not be dropped when the focused active pointer is missing.
- Completed CORE-5 gaps should be removed from deferred contract metadata.

## Implemented In This Slice

- Add local `/snapshot` HTTP endpoint for active TUI session messages and pending review route state.
- Add TUI client parsing for server snapshot payloads, including pending review `ReviewSpec`.
- Return native `TuiCoreSessionSnapshot` payloads from `/snapshot` and resume in CORE-7; keep client fallback for old local payloads.
- Route `TuiRuntimeController.reconnect()` through `session.snapshot.loaded` before opening a new websocket.
- Restore pending approval panels from snapshot runs.
- Finalize `message.completed` events when the owning run route is still recoverable.
- Cover interrupt timeout local release and late terminal event handling.
- Clear deferred contract and reducer gap metadata.

## Deferred Changes

- Delete now-empty deferred metadata constants during CORE-6 cleanup. Completed in CORE-6.
- Remove legacy `history` and `runRoute` in follow-up cleanup once the remaining compatibility paths are replaced. Completed in CORE-7.
- Extend snapshots with richer operation/run timestamps if the server later persists them.

## Alignment Log

| Date | Area | Expected Design | Deviation | Reason | Decision | Follow-up | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-06-21 | snapshot endpoint shape | server should eventually return full `TuiCoreSessionSnapshot` directly | CORE-5 initially returned a local server payload and the TUI client adapted it | reduced coupling while reconnect behavior was landing | CORE-7 now returns native `TuiCoreSessionSnapshot` from `/snapshot` and resume; client keeps old-payload fallback only for compatibility | none | accepted |
| 2026-06-21 | pending review request id | pending review snapshot needs a routeable request id | checkpoint fallback cannot recover the original UI request id | local server can resume checkpoint with a stable synthetic request id | use existing route id when present; otherwise use `snapshot:<sessionId>:<reviewId>` | none | accepted |
| 2026-06-21 | reconnect failure policy | reconnect should not open websocket against stale TUI state after snapshot failure | reconnect now retries if snapshot load fails | otherwise completed/review state can remain stale | fail reconnect attempt and schedule retry | none | accepted |
| 2026-06-21 | static timeline reset | reconnect snapshot replacement should rebuild Ink static output | initial CORE-5 implementation reconciled state without clearing static render rows | Ink `Static` keeps previous output until timeline render epoch changes | reset timeline view after successful reconnect snapshot | none | accepted |
| 2026-06-21 | reconnect token usage | reconnect snapshots without usage should not clear status bar usage | server `/snapshot` does not yet include token usage | reconnect is a reconciliation pass and missing optional state is not authoritative | preserve existing usage on reconnect when omitted | richer server snapshot | accepted |
| 2026-06-23 | interrupt timeout coverage | Interrupt timeout should release local input without letting late terminal events duplicate old output. | Server-side interrupt timeout was covered, but the TUI controller local-release path and reducer behavior after local release were not directly covered. | Main design lists interrupt timeout in the minimum test matrix. | Add a controller test for timeout-driven `run.finish` and a reducer test proving late completed events for the released request are ignored. | none | accepted |

## Merge Checklist

- [x] Reconnect dispatches `session.snapshot.loaded` before websocket connect.
- [x] Snapshot can restore pending approval `ReviewSpec`.
- [x] Missing-active `message.completed` finalizes through run ownership.
- [x] Interrupt timeout local release and late terminal event behavior are covered.
- [x] Deferred CORE metadata no longer lists completed CORE-5 gaps.
- [x] PR references tracking issue #232.
