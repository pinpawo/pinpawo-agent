# CORE-2: Timeline Authority

## Scope

Start CORE-2 by introducing the canonical message/operation timeline boundary.

This PR is the first CORE-2 slice. It does not complete the full timeline authority migration.

## Design Baseline

- `timeline == backend checkpoint messages`.
- `/history`, checkpoint restore, local submit, and WS message events are input sources for the same timeline.
- Timeline messages contain user messages, assistant streaming/final messages, and tool operation messages.
- pending review, runtime, token usage, studio progress, connection, and active run remain state.
- `history`, `transcript`, `transcriptSnapshot`, and message-only views must not exist as second live message logs.

## Expected Changes

- Introduce an explicit message/operation timeline boundary.
- Add helpers that project current `AgentTimelineEntry[]` into authoritative message and operation entries.
- Add tests that exclude `review`, `notice`, `error`, `studio.progress`, and `subagent` entries from authoritative timeline messages.

## Completed Deferred CORE-2 Changes

- Existing `/history` input is converted into snapshot timeline entries through the compatibility adapter; `/snapshot` and resume now prefer native `TuiCoreSessionSnapshot` payloads.
- Live `history` and `timeline` double writes are removed from session state.
- `skipTimelineIds` is removed.
- Final assistant messages are finalized in timeline exactly once.

## Out Of Scope

- Replacing `activeRun` / `runRoute`.
- Implementing reconnect snapshot reconciliation.
- Redesigning timeline viewport layout.
- Changing backend checkpoint semantics.

## Alignment Log

| Date | Area | Expected Design | Deviation | Reason | Decision | Follow-up | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-06-21 | timeline message model | reducer/session timeline should eventually store only authoritative message and operation entries | initial UI still stored `AgentTimelineEntry[]` including review/notice/error/studio.progress compatibility entries | removing all compatibility entries at once would mix CORE-2 with UI and snapshot work | CORE-7 removes non-checkpoint visual entries from timeline, stores system feedback in notices, and stores subagent output in activities | none | accepted |
| 2026-06-21 | history import | `/history` should become timeline message input, not a second live log | CORE-2 kept `HistoryCellModel` and `session.replace_history` as temporary compatibility | CORE-2 branch started with the model boundary before storage replacement | CORE-4/5 move restore paths to `session.snapshot.loaded`; CORE-6 deletes `session.replace_history`; CORE-7 renames internal message cell/action concepts | `/history` remains a server compatibility endpoint only | accepted |
| 2026-06-21 | PR slice naming | PR title and checklist should not imply full CORE-2 completion | this slice only adds the authoritative message boundary | complete storage migration needs callsite changes across reducer, restore, and render paths | label this PR as the CORE-2 boundary/foundation slice | completed by CORE-6/CORE-7 cleanup | accepted |
| 2026-06-21 | message-only history helper | helper projected legacy history into a message-only timeline view | the target model has no separate message-only log | CORE-6 keeps the actual timeline helper and removes the history-to-message-only helper | no standalone session history/transcript/message-only view remains | none | accepted |
| 2026-06-21 | `skipTimelineIds` cleanup | final assistant completion should update timeline exactly once | CORE-2 left a skip option to avoid duplicate writes from history mirroring | CORE-5 finalized assistant messages through timeline directly | CORE-6 removes `skipTimelineIds`; CORE-7 removes the remaining history mirror | none | accepted |
| 2026-06-23 | milestone checklist state | CORE-2 checklist should reflect the completed mainline cleanup after CORE-7. | The checklist still showed one live session log and no message-only model as open items. | CORE-7 removed `SessionModel.history`, keeps composer input history outside session messages, and transcript export now reads `SessionModel.timeline`. | Mark the full-milestone checklist items complete while preserving the earlier slice scope notes. | none | accepted |
| 2026-06-23 | non-checkpoint event coverage | `notice` and `studio.progress` events should stay out of authoritative timeline messages. | The runtime routed system cells into `SessionModel.notices`, but reducer coverage did not dispatch `system.notice` and `studio.progress` directly. | The design and checklist explicitly name notice/studio progress as non-checkpoint timeline exclusions. | Add reducer regression coverage for both event types and assert the checkpoint timeline/transcript remain message-only. | none | accepted |
| 2026-06-23 | operation terminal display | Completed operation events should update status without erasing the operation's existing display content. | Sparse terminal operation events could rebuild the timeline entry from only the terminal payload, causing the line to collapse to generic start/complete text. | Operation timeline entries are authoritative operation messages; lifecycle status should not replace the operation target/summary/details already shown for that entry. | Merge operation lifecycle events so missing terminal fields inherit the previous title, target, summary, details, and source while still marking the phase completed/failed/interrupted. | none | accepted |

## Open Questions

None for this PR. TUI uses `TuiCoreSessionSnapshot` / `TuiCoreTimelineEntry` as its stable render adapter boundary.

## Resolved Notes

- Subagent output uses a separate `SessionModel.activities` state surface as of CORE-7.
- CORE-4 introduced snapshot reconciliation, and CORE-7 made `/snapshot` and resume return native `TuiCoreSessionSnapshot` payloads. `/history` remains a server compatibility endpoint only.

## Merge Checklist

This checklist tracks the full CORE-2 milestone. Checked items are completed by the original CORE-2 slice or by later follow-up PRs on main; unchecked items are remaining follow-up slices.

- [x] CORE-2 alignment document exists.
- [x] Authoritative timeline message/operation boundary exists.
- [x] Sparse terminal operation events preserve previous operation display fields.
- [x] Non-message UI state entries are excluded from authoritative timeline messages.
- [x] Live session state has one message log.
- [x] No new session history/transcript/message-only model is introduced.
- [x] `skipTimelineIds` is removed.
- [x] PR references tracking issue #232.
