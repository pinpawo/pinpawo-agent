# CORE-2: Timeline Authority

## Scope

Start CORE-2 by introducing the canonical `AgentTimelineMessage` boundary.

This PR is the first CORE-2 slice. It does not complete the full timeline authority migration.

## Design Baseline

- `timeline == backend checkpoint messages`.
- `/history`, checkpoint restore, local submit, and WS message events are input sources for the same `AgentTimelineMessage[]`.
- Timeline messages contain user messages, assistant streaming/final messages, and tool operation messages.
- pending review, runtime, token usage, studio progress, connection, and active run remain state.
- `history`, `transcript`, `transcriptSnapshot`, and message-only views must not exist as second live message logs.

## Expected Changes

- Introduce an explicit `AgentTimelineMessage` type.
- Add helpers that project current `AgentTimelineEntry[]` into authoritative timeline messages.
- Add tests that exclude `review`, `notice`, `error`, `studio.progress`, and `subagent` entries from authoritative timeline messages.

## Deferred CORE-2 Changes

- Convert existing `/history` input into timeline messages through an adapter.
- Remove live `history` and `timeline` double writes.
- Remove `skipTimelineIds` once duplicate writes are gone.
- Ensure final assistant messages are finalized in timeline exactly once.

## Out Of Scope

- Replacing `activeRun` / `runRoute`.
- Implementing reconnect snapshot reconciliation.
- Redesigning timeline viewport layout.
- Changing backend checkpoint semantics.

## Alignment Log

| Date | Area | Expected Design | Deviation | Reason | Decision | Follow-up | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-06-21 | timeline message model | reducer/session timeline should eventually store only authoritative `AgentTimelineMessage[]` | current UI still stores `AgentTimelineEntry[]` including review/notice/error/studio.progress compatibility entries | removing all compatibility entries at once would mix CORE-2 with UI and snapshot work | introduce `AgentTimelineMessage` and projection helpers first | migrate reducer storage away from live `history` double-write in later CORE-2 commits | accepted |
| 2026-06-21 | history import | `/history` should become timeline message input, not a second live log | current `HistoryCellModel` still exists and `session.replace_history` still writes both history and timeline | CORE-2 branch is starting with the model boundary before storage replacement | keep history compatibility temporarily, but only user/assistant cells project to timeline messages | replace `session.replace_history` with timeline import actions | deferred |
| 2026-06-21 | PR slice naming | PR title and checklist should not imply full CORE-2 completion | this slice only adds the authoritative message boundary | complete storage migration needs callsite changes across reducer, restore, and render paths | label this PR as the CORE-2 boundary/foundation slice | follow-up CORE-2 PR removes live `history` / `timeline` double writes | accepted |

## Open Questions

- Can the TUI reuse backend checkpoint message types directly, or is a render adapter required?
- Should `subagent` output become a tool operation detail or a separate state surface?
- Which server payload will become the first checkpoint-native timeline source before CORE-4 snapshot?

## Merge Checklist

This checklist tracks the full CORE-2 milestone. Checked items are completed by this PR; unchecked items are follow-up CORE-2 slices.

- [x] CORE-2 alignment document exists.
- [x] Authoritative timeline message type exists.
- [x] Non-message UI state entries are excluded from authoritative timeline messages.
- [ ] Live session state has one message log.
- [ ] No new transcript/message-only model is introduced.
- [ ] `skipTimelineIds` is removed or has a documented removal follow-up.
- [x] PR references tracking issue #232.
