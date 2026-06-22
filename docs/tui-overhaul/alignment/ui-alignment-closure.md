# UI Alignment Closure: Overlay and Viewport Finish

## Scope

Close the remaining UI alignment gaps after UI-1 through UI-4 landed on `main`.

## Design Baseline

- `StatusBarModel` should include the current overlay owner when an overlay is open.
- Screen layout should render a single `OverlayLayer` that owns the active overlay slot.
- Timeline viewport static/dynamic state should be derived by the screen model boundary.

## Expected Changes

- Add an explicit overlay model that selects the highest-priority active overlay.
- Render overlays through one `OverlayLayer` component in `TuiApp` instead of a repeated conditional chain.
- Pass the active overlay owner into `StatusBarModel`.
- Pass the reducer-owned submit mode into `StatusBarModel`.
- Expose timeline static boundary metadata and the static render key from `buildTuiScreenModel`.

## Out Of Scope

- Moving picker lifecycle hooks into the reducer.
- Changing terminal scroll behavior or clearing behavior.
- Changing input owner priority.

## Alignment Log

| Date | Area | Expected Design | Deviation | Reason | Decision | Follow-up | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-06-23 | StatusBar overlay owner | Status bar shows the current overlay owner. | None | Overlay owner is now derived from the overlay model and rendered as a status segment. | Add `overlayOwner` to `StatusBarModel` input. | None. | Done |
| 2026-06-23 | StatusBar mode owner | Status bar mode matches the actual submit target. | Previous model derived mode from `session.kind`, which can lag reducer-owned `ui.mode`. | UI-3 made `ui.mode` the authoritative submit target. | Pass `ui.mode` into `StatusBarModel` and use it for the mode segment. | None. | Done |
| 2026-06-23 | OverlayLayer | Layout renders one highest-priority overlay slot. | Picker lifecycle state remains in existing hooks. | Resume and policy pickers already have focused lifecycle controllers; moving them would broaden the PR beyond UI closure. | Add a pure `TuiOverlayModel` plus an `OverlayLayer` component that owns overlay rendering while preserving existing controllers. | None. | Done |
| 2026-06-23 | Overlay region shape | Overlay region should model overlay layout, not activity status. | Previous screen model left `pendingApproval` and `activityStatus` inside `regions.overlay` after overlay rendering moved elsewhere. | Activity belongs to the status bar; pending approval remains top-level domain state and overlay model input. | Keep `regions.overlay` layout-only with width. | None. | Done |
| 2026-06-23 | Timeline viewport | Screen model owns static/dynamic boundary semantics. | Terminal scroll reset is still host-controlled. | Existing Ink `Static` reset is tied to explicit screen clearing; changing it risks duplicate terminal output. | Expose `renderKey`, `staticBoundaryKey`, and `scrollStrategy` from the screen model without changing terminal behavior. | None. | Done |

## Open Questions

None.

## Merge Checklist

- [x] Status bar shows the active overlay owner.
- [x] Status bar mode follows the reducer-owned submit mode.
- [x] `TuiApp` renders overlays through a single overlay layer.
- [x] Overlay priority is covered by unit tests.
- [x] Timeline viewport boundary metadata is covered by unit tests.
