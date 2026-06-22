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
- Cover `OverlayLayer` as the single active overlay render slot.
- Pass the active overlay owner into `StatusBarModel`.
- Pass the reducer-owned submit mode into `StatusBarModel`.
- Split activity and connection status in `StatusBarModel`.
- Render status segment tones instead of dimming the full status line.
- Cover status bar 80-column, 120-column, and CJK cwd display-width behavior.
- Expose timeline static boundary metadata and the static render key from `buildTuiScreenModel`.
- Cover operation running/completed viewport boundary behavior.

## Out Of Scope

- Moving picker lifecycle hooks into the reducer.
- Changing terminal scroll behavior or clearing behavior.
- Changing input owner priority.

## Alignment Log

| Date | Area | Expected Design | Deviation | Reason | Decision | Follow-up | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-06-23 | StatusBar overlay owner | Status bar shows the current overlay owner. | None | Overlay owner is now derived from the overlay model and rendered as a status segment. | Add `overlayOwner` to `StatusBarModel` input. | None. | Done |
| 2026-06-23 | StatusBar mode owner | Status bar mode matches the actual submit target. | Previous model derived mode from `session.kind`, which can lag reducer-owned `ui.mode`. | UI-3 made `ui.mode` the authoritative submit target. | Pass `ui.mode` into `StatusBarModel` and use it for the mode segment. | None. | Done |
| 2026-06-23 | StatusBar activity/connection | Activity and connection are separate status segments. | Previous model collapsed activity, approval, reconnect, and disconnected text into one `status` string. | Busy/approval state and connection state can both matter at the same time, and recovered ready messages must not be hidden by the default ready label when no activity is active. | Split status bar input into `activityStatus` and `connectionStatus`; preserve non-default ready connection messages only when activity is empty; keep high-priority truncatable status segments visible on narrow screens. | None. | Done |
| 2026-06-23 | StatusBar tones | Segment tone should be visible in the rendered status bar. | `StatusSegment.tone` existed in the model, but `BottomStatusLine` rendered the entire line as dim text; retrying and failed connection states were also easy to classify the same way. | Warning, danger, success, and info states are part of the structured status model and make busy/retry/disconnected states clearer. | Format visible status parts with segment tone metadata and render each part with the matching Ink color while preserving existing text truncation behavior; classify pending retry/reconnect as warning and disconnected/unavailable/failure as danger. | None. | Done |
| 2026-06-23 | StatusBar width coverage | 80-column, 120-column, and CJK cwd status bars should not overflow terminal display width. | Existing tests covered narrow truncation and CJK truncation, but did not directly assert the 80/120-column acceptance cases from the main design. | The formatter uses terminal display width, so acceptance tests should verify display width rather than string length. | Add direct 80/120-column assertions, including a 120-column case where the CJK cwd segment is actually visible. | None. | Done |
| 2026-06-23 | OverlayLayer | Layout renders one highest-priority overlay slot. | Picker lifecycle state remains in existing hooks. | Resume and policy pickers already have focused lifecycle controllers; moving them would broaden the PR beyond UI closure. | Add a pure `TuiOverlayModel` plus an `OverlayLayer` component that owns overlay rendering while preserving existing controllers. | None. | Done |
| 2026-06-23 | OverlayLayer render boundary | `OverlayLayer` should render only the current overlay component. | Existing tests proved overlay model priority but did not directly exercise the component boundary. | The design asks for one active overlay slot, so the render component should be covered separately from model selection. | Add a pure React element test for null and each overlay type returned by `OverlayLayer`. | None. | Done |
| 2026-06-23 | Overlay region shape | Overlay region should model overlay layout, not activity status. | Previous screen model left `pendingApproval` and `activityStatus` inside `regions.overlay` after overlay rendering moved elsewhere. | Activity belongs to the status bar; pending approval remains top-level domain state and overlay model input. | Keep `regions.overlay` layout-only with width. | None. | Done |
| 2026-06-23 | Timeline viewport | Screen model owns static/dynamic boundary semantics. | Terminal scroll reset is still host-controlled. | Existing Ink `Static` reset is tied to explicit screen clearing; changing it risks duplicate terminal output. | Expose `renderKey`, `staticBoundaryKey`, and `scrollStrategy` from the screen model without changing terminal behavior. | None. | Done |
| 2026-06-23 | Timeline operation boundary | Operation running/completed conversion should stay stable across the screen model viewport boundary. | Existing tests covered message streaming/completed boundary movement and operation id stability separately, but not operation viewport movement directly. | Main design lists operation running/completed stability as a timeline viewport acceptance case. | Add a screen model test for a running operation moving from dynamic to static after completion without changing display ids. | None. | Done |

## Open Questions

None.

## Merge Checklist

- [x] Status bar shows the active overlay owner.
- [x] Status bar mode follows the reducer-owned submit mode.
- [x] Status bar keeps activity and connection status separate.
- [x] Status bar renders segment tones.
- [x] Status bar 80/120-column and CJK cwd display width behavior is covered.
- [x] `TuiApp` renders overlays through a single overlay layer.
- [x] `OverlayLayer` renders only the current active overlay component.
- [x] Overlay priority is covered by unit tests.
- [x] Timeline viewport boundary metadata is covered by unit tests.
- [x] Operation running/completed viewport boundary behavior is covered by unit tests.
