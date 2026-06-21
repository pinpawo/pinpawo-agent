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
| 2026-06-20 | `message.completed` with missing active pointer | terminal events should be handled by run registry, not dropped because `session.activeRun` is missing | current reducer still drops this case; gap is tracked by executable contract metadata | CORE-1 freezes the contract before CORE-3 replaces `activeRun + runRoute` | defer implementation | CORE-3 Run Registry / CORE-5 Reconnect Reconciliation | deferred |
| 2026-06-20 | reconnect after server completion | reconnect should load a session snapshot and reconcile final assistant output | current reconnect only refreshes runtime and socket; gap is tracked by executable contract metadata | snapshot adapter/action does not exist yet | defer implementation | CORE-4 Snapshot Adapter / CORE-5 Reconnect Reconciliation | deferred |
| 2026-06-20 | pending review reconnect | pending review should restore from snapshot state, not local route leftovers | current reconnect has no snapshot pending-review path; gap is tracked by executable contract metadata | snapshot payload/action are not defined yet | defer implementation | CORE-4 Snapshot Adapter / CORE-5 Reconnect Reconciliation | deferred |
| 2026-06-20 | resume session reconciliation | `/resume` should reconcile through `session.snapshot.loaded` instead of dispatching legacy clear/replace-history actions | current resume flow still returns legacy history and lets the picker dispatch `session.clear` + `session.replace_history`; gap is tracked by executable contract metadata | resume snapshot payload/action are not defined yet | defer implementation | CORE-4 Snapshot Adapter / CORE-5 Reconnect Reconciliation | deferred |
| 2026-06-20 | resume/new route cleanup | clearing the current session should remove `runRoute` entries owned by that session | no deviation for current model; coverage added | route cleanup remains necessary until run registry replaces `runRoute` | keep existing behavior for CORE-1 | CORE-3 removes `runRoute` entirely | accepted |
| 2026-06-20 | pending review resume fallback | resume can recover a focused-session route when the route map is missing | no deviation for current model; coverage added | this protects current HITL resume behavior until snapshot recovery owns it | keep existing behavior for CORE-1 | CORE-5 restores pending review through snapshot | accepted |
| 2026-06-21 | deferred runtime snapshot target tests | reconnect/resume target behavior should be represented without skipped tests | previous PR state used `test.skip` for reconnect/resume snapshot targets | skipped tests do not provide CI-visible protection | replace skipped tests with executable metadata until CORE-5 closes the gap | CORE-6 removes the empty constants | accepted |
| 2026-06-21 | deferred reducer terminalization target | missing-active-pointer terminalization should be represented without skipped tests | previous PR state used `test.skip` for the reducer target | skipped tests do not provide CI-visible protection | replace skipped test with executable metadata until CORE-5 closes the gap | CORE-6 removes the empty constants | accepted |

## Open Questions

- Which existing fixture best represents backend checkpoint messages?
- Which follow-up removes remaining legacy compatibility state after CORE-6?

## Merge Checklist

- [x] Tests encode target behavior without broad implementation rewrites.
- [x] CORE-1 has an explicit code contract artifact.
- [x] Deferred reconnect/resume targets are executable contract metadata, not skipped tests; CORE-5 clears the remaining entries.
- [x] No new transcript/message-only model is introduced.
- [x] Any intentionally failing or skipped test is explained in this document.
- [x] PR references tracking issue #232.
