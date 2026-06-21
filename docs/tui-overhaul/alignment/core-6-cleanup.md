# CORE-6: Cleanup

## Scope

Remove completed compatibility code and alignment metadata after CORE-5 unified reconnect through `session.snapshot.loaded`.

This PR is intentionally conservative: it deletes paths that no longer have runtime callers, but it does not remove `SessionModel.history` while transcript export and compatibility adapters still read it.

## Design Baseline

- `timeline == backend checkpoint messages`.
- Timeline owns user messages, assistant streaming/final messages, and tool operations.
- Reconnect, resume, and startup restore through `session.snapshot.loaded`.
- `history` is compatibility state only; it must not drive a parallel live timeline.
- No `transcript`, `transcriptSnapshot`, or message-only view should be introduced.

## Implemented In This Slice

- Remove now-empty deferred contract metadata constants and tests.
- Remove legacy `session.replace_history` action and reducer path.
- Remove the `skipTimelineIds` reducer option.
- Final assistant completion now updates timeline first and writes only a history compatibility cell.
- Remove the legacy history-to-message-only helper.

## Deferred Changes

- Remove `SessionModel.history` after transcript export and remaining compatibility reads are migrated.
- Replace `activeRun` and `runRoute` naming/model with a clearer run registry in a focused PR. CORE-7 introduces the registry and keeps legacy mirrors temporarily.
- Replace remaining compatibility timeline entry kinds once render state has dedicated owners.

## Alignment Log

| Date | Area | Expected Design | Deviation | Reason | Decision | Follow-up | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-06-21 | `SessionModel.history` | timeline should be the only message log | history still exists in session state | transcript export and compatibility adapters still read it | keep history as compatibility-only state in CORE-6 | migrate export/adapters, then delete history | accepted |
| 2026-06-21 | `session.replace_history` | restore should reconcile snapshots through `session.snapshot.loaded` | legacy action remained after CORE-4/5 migrated callsites | action no longer has runtime callers | delete action, reducer case, and tests | none | accepted |
| 2026-06-21 | final assistant completion | completed assistant output should appear in timeline exactly once | reducer had `skipTimelineIds` to avoid duplicate timeline writes through history mirroring | CORE-5 now finalizes timeline directly | remove skip option and keep only history compatibility append | delete history compatibility later | accepted |
| 2026-06-21 | deferred metadata constants | executable metadata should describe real deferred gaps | constants were empty after CORE-5 | empty constants added noise and invited stale contract checks | remove constants and tests | use alignment docs for future deviations | accepted |

## Merge Checklist

- [x] Empty deferred metadata constants are removed.
- [x] `session.replace_history` is removed from reducer actions.
- [x] `skipTimelineIds` is removed from reducer completion flow.
- [x] No new transcript/message-only model is introduced.
- [x] `SessionModel.history` removal is explicitly deferred.
- [x] PR references tracking issue #232.
