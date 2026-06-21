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

## Deferred CORE-2 Changes

- Convert existing `/history` input into timeline entries through an adapter.
- Remove live `history` and `timeline` double writes.
- Remove `skipTimelineIds` once duplicate final assistant writes are gone.
- Ensure final assistant messages are finalized in timeline exactly once.

## Out Of Scope

- Replacing `activeRun` / `runRoute`.
- Implementing reconnect snapshot reconciliation.
- Redesigning timeline viewport layout.
- Changing backend checkpoint semantics.

## Alignment Log

| Date | Area | Expected Design | Deviation | Reason | Decision | Follow-up | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-06-21 | timeline message model | reducer/session timeline should eventually store only authoritative message and operation entries | initial UI still stored `AgentTimelineEntry[]` including review/notice/error/studio.progress compatibility entries | removing all compatibility entries at once would mix CORE-2 with UI and snapshot work | CORE-7 removes non-checkpoint visual entries from timeline and stores system feedback in notices | subagent activity ownership remains for UI layout work | accepted |
| 2026-06-21 | history import | `/history` should become timeline message input, not a second live log | CORE-2 kept `HistoryCellModel` and `session.replace_history` as temporary compatibility | CORE-2 branch started with the model boundary before storage replacement | CORE-4/5 move restore paths to `session.snapshot.loaded`; CORE-6 deletes `session.replace_history`; CORE-7 renames internal message cell/action concepts | `/history` remains a server compatibility endpoint only | accepted |
| 2026-06-21 | PR slice naming | PR title and checklist should not imply full CORE-2 completion | this slice only adds the authoritative message boundary | complete storage migration needs callsite changes across reducer, restore, and render paths | label this PR as the CORE-2 boundary/foundation slice | follow-up CORE-2 PR removes live `history` / `timeline` double writes | accepted |
| 2026-06-21 | message-only history helper | helper projected legacy history into a message-only timeline view | the target model has no separate message-only log | CORE-6 keeps the actual timeline helper and removes the history-to-message-only helper | no standalone transcript/message-only view remains | none | accepted |
| 2026-06-21 | `skipTimelineIds` cleanup | final assistant completion should update timeline exactly once | CORE-2 left a skip option to avoid duplicate writes from history mirroring | CORE-5 finalized assistant messages through timeline directly | CORE-6 removes `skipTimelineIds`; CORE-7 removes the remaining history mirror | none | accepted |

## Open Questions

- Can the TUI reuse backend checkpoint message types directly, or is a render adapter required after `history` is removed?
- Should `subagent` output become a tool operation detail or a separate state surface?
- Which server payload will become the first checkpoint-native timeline source before CORE-4 snapshot?

## Merge Checklist

This checklist tracks the full CORE-2 milestone. Checked items are completed by this PR; unchecked items are follow-up CORE-2 slices.

- [x] CORE-2 alignment document exists.
- [x] Authoritative timeline message/operation boundary exists.
- [x] Non-message UI state entries are excluded from authoritative timeline messages.
- [ ] Live session state has one message log.
- [ ] No new transcript/message-only model is introduced.
- [x] `skipTimelineIds` is removed.
- [x] PR references tracking issue #232.
