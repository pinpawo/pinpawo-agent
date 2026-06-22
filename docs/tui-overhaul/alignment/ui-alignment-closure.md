# UI Alignment Closure: Overlay and Viewport Finish

## Scope

Close the remaining UI alignment gaps after UI-1 through UI-4 landed on `main`.

## Design Baseline

- `StatusBarModel` should include the current overlay owner when an overlay is open.
- Screen layout should render a single `OverlayLayer` that owns the active overlay slot.
- Timeline viewport static/dynamic state should be derived by the screen model boundary.

## Expected Changes

- Add an explicit overlay model that selects the highest-priority active overlay.
- Render overlays through one layer in `TuiApp` instead of a repeated conditional chain.
- Pass the active overlay owner into `StatusBarModel`.
- Expose timeline static boundary metadata and the static render key from `buildTuiScreenModel`.

## Out Of Scope

- Moving picker lifecycle hooks into the reducer.
- Changing terminal scroll behavior or clearing behavior.
- Changing input owner priority.

## Alignment Log

| Date | Area | Expected Design | Deviation | Reason | Decision | Follow-up | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-06-23 | StatusBar overlay owner | Status bar shows the current overlay owner. | None | Overlay owner is now derived from the overlay model and rendered as a status segment. | Add `overlayOwner` to `StatusBarModel` input. | None. | Done |
| 2026-06-23 | OverlayLayer | Layout renders one highest-priority overlay slot. | Picker lifecycle state remains in existing hooks. | Resume and policy pickers already have focused lifecycle controllers; moving them would broaden the PR beyond UI closure. | Add a pure `TuiOverlayModel` that owns priority and render props while preserving existing controllers. | None. | Done |
| 2026-06-23 | Timeline viewport | Screen model owns static/dynamic boundary semantics. | Terminal scroll reset is still host-controlled. | Existing Ink `Static` reset is tied to explicit screen clearing; changing it risks duplicate terminal output. | Expose `renderKey`, `staticBoundaryKey`, and `scrollStrategy` from the screen model without changing terminal behavior. | None. | Done |

## Open Questions

None.

## Merge Checklist

- [x] Status bar shows the active overlay owner.
- [x] `TuiApp` renders overlays through a single overlay layer.
- [x] Overlay priority is covered by unit tests.
- [x] Timeline viewport boundary metadata is covered by unit tests.
