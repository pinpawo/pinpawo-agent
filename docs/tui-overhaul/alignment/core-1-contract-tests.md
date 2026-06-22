# CORE-1: Contract And Failing Tests

## Scope

Freeze the TUI message/state contract and add behavior tests that describe the target model before runtime migration starts.

## Design Baseline

- `timeline == backend checkpoint messages`.
- Timeline contains user message, assistant streaming/final message, and tool operation message.
- pending review, runtime, studio progress, connection, token usage, runs, and active run are state, not timeline messages.
- No `transcript`, message-only view, or `transcriptSnapshot` second message log.

## Contract Artifact

- Code contract: `services/local-agent/src/tui/contracts/tuiCoreContract.ts`.
- Contract version: `TUI_CORE_CONTRACT_VERSION = 1`.
- Target snapshot action: `session.snapshot.loaded`.
- Contract tests: `services/local-agent/src/tui/contracts/tuiCoreContract.test.ts`.
- Deferred reconnect migrations were tracked in `TUI_CORE_DEFERRED_CONTRACT_GAPS` until CORE-5.
- Runtime target tests are not left as `test.skip`; CORE-5 clears the remaining reconnect and terminalization metadata gaps, and CORE-6 removes the now-empty metadata constants.

## Expected Changes

- Add tests for completed events when active pointers are missing.
- Add tests for reconnect after server completion.
- Add tests for pending review restoration.
- Add tests for resume/new route cleanup.
- Document any contract gaps discovered while writing tests.

## Out Of Scope

- Migrating reducer state.
- Replacing `activeRun` / `runRoute`.
- Adding reconnect snapshot behavior.
- UI layout changes.

## Alignment Log

| Date | Area | Expected Design | Deviation | Reason | Decision | Follow-up | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-06-20 | `message.completed` with missing active pointer | terminal events should be handled by run registry, not dropped because `session.activeRun` is missing | initial reducer still dropped this case; gap was tracked by executable contract metadata | CORE-1 froze the contract before CORE-3/CORE-7 replaced `activeRun + runRoute` | implemented through run registry ownership | none | accepted |
| 2026-06-20 | reconnect after server completion | reconnect should load a session snapshot and reconcile final assistant output | initial reconnect only refreshed runtime and socket; gap was tracked by executable contract metadata | snapshot adapter/action did not exist yet | implemented through CORE-4/5 snapshot reconciliation | none | accepted |
| 2026-06-20 | pending review reconnect | pending review should restore from snapshot state, not local route leftovers | initial reconnect had no snapshot pending-review path; gap was tracked by executable contract metadata | snapshot payload/action were not defined yet | implemented through CORE-5 snapshot pending review restoration | none | accepted |
| 2026-06-20 | resume session reconciliation | `/resume` should reconcile through `session.snapshot.loaded` instead of dispatching legacy clear/replace-history actions | initial resume flow returned legacy history and let the picker dispatch `session.clear` + `session.replace_history` | resume snapshot payload/action were not defined yet | implemented through CORE-4 snapshot restore and CORE-7 resume cleanup | none | accepted |
| 2026-06-20 | resume/new route cleanup | clearing the current session should remove route entries owned by that session | no deviation for the old model; coverage added | route cleanup remained necessary until run registry replaced `runRoute` | CORE-7 removes `runRoute`; session clear now removes owned runs | none | accepted |
| 2026-06-20 | pending review resume fallback | resume can recover a focused-session route when the route map is missing | no deviation for current model; coverage added | this protects current HITL resume behavior until snapshot recovery owns it | keep existing behavior for CORE-1 | CORE-5 restores pending review through snapshot | accepted |
| 2026-06-21 | deferred runtime snapshot target tests | reconnect/resume target behavior should be represented without skipped tests | previous PR state used `test.skip` for reconnect/resume snapshot targets | skipped tests do not provide CI-visible protection | replace skipped tests with executable metadata until CORE-5 closes the gap | CORE-6 removes the empty constants | accepted |
| 2026-06-21 | deferred reducer terminalization target | missing-active-pointer terminalization should be represented without skipped tests | previous PR state used `test.skip` for the reducer target | skipped tests do not provide CI-visible protection | replace skipped test with executable metadata until CORE-5 closes the gap | CORE-6 removes the empty constants | accepted |

## Open Questions

None for this PR. Native `TuiCoreSessionSnapshot` timeline entries now represent the checkpoint message projection in tests, and subagent streaming output is owned by `SessionModel.activities` instead of checkpoint timeline.

## Merge Checklist

- [x] Tests encode target behavior without broad implementation rewrites.
- [x] CORE-1 has an explicit code contract artifact.
- [x] Deferred reconnect/resume targets are executable contract metadata, not skipped tests; CORE-5 clears the remaining entries.
- [x] No new transcript/message-only model is introduced.
- [x] Any intentionally failing or skipped test is explained in this document.
- [x] PR references tracking issue #232.
