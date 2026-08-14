# UI-4: Timeline Viewport Simplification

> **Status: historical record.** This page preserves earlier design or implementation context; it does not define current behavior. Start with [the current documentation map](../../../index.md).

## Scope

Reduce Static/Dynamic timeline viewport complexity after the timeline message model is stable.

## Design Baseline

- Timeline viewport renders `AgentTimelineMessage[]` plus derived UI state.
- Static/Dynamic split should be a rendering concern, not a second state model.
- Resize behavior should not lose, duplicate, or reorder timeline messages.
- This PR depends on CORE-2 and UI-2 being stable.

## Expected Changes

- Simplify static/dynamic timeline selectors or rendering boundaries.
- Preserve streaming and completed message rendering.
- Preserve running and completed operation rendering.
- Stabilize resize behavior.
- Remove obsolete split-specific duplicate avoidance if timeline authority made it unnecessary.

## Out Of Scope

- Defining the timeline message model.
- Replacing run registry.
- Snapshot reconciliation.
- Status bar or input owner work.

## Alignment Log

| Date | Area | Expected Design | Deviation | Reason | Decision | Follow-up | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-06-22 | Timeline viewport | Static/dynamic split is derived directly from display entries and remains a render concern. | None | UI-2 introduced a screen model boundary, so viewport derivation can live behind it. | Added `buildTimelineViewportModel`, removed the raw timeline split from `buildTuiScreenModel`, and covered resize-stable ids. | None. | Done |
| 2026-06-23 | Operation viewport transition | Operation running/completed conversion should be stable across the static/dynamic boundary. | Existing tests covered operation id stability and message streaming/completed boundary movement, but did not directly cover operation boundary movement in the screen model. | Main design lists operation running/completed stability as a viewport acceptance case. | Add a screen model test for a running operation moving from dynamic to static after completion without changing display ids. | None. | Done |

## Open Questions

None for this PR. The first unsettled display entry starts the dynamic suffix; notices before it stay static, and streaming activities/messages plus following entries stay dynamic.

## Merge Checklist

- [x] Resize does not duplicate or drop messages.
- [x] Streaming and completed messages remain stable.
- [x] Running and completed operations remain stable.
- [x] Static/Dynamic split is only a render implementation detail.
- [x] PR references tracking issue #232.
