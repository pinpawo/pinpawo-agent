# CORE-6: Cleanup Leftovers

## Scope

Remove old TUI state/model compatibility code after timeline authority, run registry, and snapshot reconciliation are in place.

## Design Baseline

- There is one live message log: timeline.
- Run lifecycle is owned by `runs[runId]`.
- Snapshot reconciliation owns restore paths.
- Temporary compatibility must have a removal plan before this PR starts.

## Expected Changes

- Delete residual `history` live state usage.
- Delete `transcript`, message-only view, and `transcriptSnapshot` helpers if any remain.
- Delete `skipTimelineIds`.
- Delete obsolete `activeRun` and `runRoute` compatibility selectors after migration.
- Remove obsolete fixtures and tests that encode the old model.

## Out Of Scope

- Introducing new behavior.
- Reworking layout or status bar rendering.
- Adding more compatibility paths.
- Changing backend checkpoint semantics.

## Alignment Log

| Date | Area | Expected Design | Deviation | Reason | Decision | Follow-up | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |

## Open Questions

- Which old fixture names should be renamed to avoid implying `history` is a live model?

## Merge Checklist

- [ ] Old compatibility code is removed rather than hidden behind new wrappers.
- [ ] Tests describe the new timeline/run/snapshot model.
- [ ] No dead selector or helper still references removed models.
- [ ] PR references tracking issue #232.
