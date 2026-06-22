# UI-2: ScreenModel And Layout Regions

## Scope

Introduce a screen model boundary and stabilize TUI layout regions.

## Design Baseline

- `TuiApp` should consume `TuiScreenModel` where possible.
- Layout regions are timeline, overlay, composer, and status bar.
- Screen model adapts domain/UI state for rendering without owning runtime behavior.
- UI work must not lock in old `history`, `activeRun`, or `runRoute` assumptions.

## Expected Changes

- Add `buildTuiScreenModel`.
- Move layout-oriented selector work out of `TuiApp`.
- Make overlay/composer/status/timeline regions explicit.
- Preserve current behavior while reducing component-level state coupling.

## Out Of Scope

- Timeline authority migration.
- Run registry migration.
- Snapshot reconciliation.
- Deep input owner cleanup, unless required for the screen model boundary.

## Alignment Log

| Date | Area | Expected Design | Deviation | Reason | Decision | Follow-up | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-06-22 | Screen model boundary | `TuiApp` consumes explicit timeline, overlay, composer, and status bar regions. | None | Layout selectors can move without changing runtime behavior. | Added `buildTuiScreenModel` and region-oriented tests. | UI-3 can move input ownership state behind the same reducer boundary. | Done |

## Open Questions

- Which existing local `TuiApp` state can move safely without touching input routing?
  - Current decision: only layout-derived state moved in UI-2; modal/input owner state remains for UI-3.

## Merge Checklist

- [x] `TuiApp` is thinner than before.
- [x] Layout regions are explicit in model or render structure.
- [x] No old message-log model is introduced.
- [x] PR references tracking issue #232.
