# CORE-2: Timeline Authority

## Scope

Start the timeline authority migration by introducing the canonical `AgentTimelineMessage` boundary.

## Design Baseline

- `timeline == backend checkpoint messages`.
- Timeline messages contain user messages, assistant streaming/final messages, and tool operation messages.
- pending review, runtime, studio progress, connection, token usage, and active run are state, not timeline messages.
- Existing live `history` / `timeline` double-write paths must be removed during CORE-2.

## Expected Changes

- Introduce an explicit `AgentTimelineMessage` type.
- Add helpers that project current `AgentTimelineEntry[]` into authoritative timeline messages.
- Add tests that exclude `review`, `notice`, `error`, `studio.progress`, and `subagent` entries from authoritative timeline messages.
- Use this boundary before replacing reducer storage and `/history` restore paths.

## Out Of Scope

- Run registry migration.
- Snapshot adapter and reconnect reconciliation.
- Full removal of `SessionModel.history` in the first CORE-2 step.
- UI layout changes.

## Alignment Log

| Date | Area | Expected Design | Deviation | Reason | Decision | Follow-up | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-06-21 | timeline message model | reducer/session timeline should eventually store only authoritative `AgentTimelineMessage[]` | current UI still stores `AgentTimelineEntry[]` including review/notice/error/studio.progress compatibility entries | removing all compatibility entries at once would mix CORE-2 with UI and snapshot work | introduce `AgentTimelineMessage` and projection helpers first | migrate reducer storage away from live `history` double-write in later CORE-2 commits | accepted |
| 2026-06-21 | history import | `/history` should become timeline message input, not a second live log | current `HistoryCellModel` still exists and `session.replace_history` still writes both history and timeline | CORE-2 branch is starting with the model boundary before storage replacement | keep history compatibility temporarily, but only user/assistant cells project to timeline messages | replace `session.replace_history` with timeline import actions | deferred |

## Open Questions

- Should `subagent` output become a tool operation detail or a separate state surface?
- Which server payload will become the first checkpoint-native timeline source before CORE-4 snapshot?

## Merge Checklist

- [x] CORE-2 alignment document exists.
- [x] Authoritative timeline message type exists.
- [x] Non-message UI state entries are excluded from authoritative timeline messages.
- [ ] live `history` / `timeline` double-write removal is complete.
