# UI-1: StatusBar Model

## Scope

Convert the bottom status bar to render a structured status model instead of ad hoc string concatenation.

## Design Baseline

- Status bar renders `StatusBarModel`.
- Status segments have priority, label, value, tone, and truncation behavior.
- UI status should be derived from domain/UI state, not manually assembled in `TuiApp`.
- This PR must not depend on old `history`, `activeRun`, or `runRoute` ownership.

## Expected Changes

- Introduce `StatusBarModel` and `StatusSegment`.
- Update `BottomStatusLine` to render the model.
- Preserve existing PR #230 behavior while making segment ownership explicit.
- Add narrow-width/CJK-safe truncation coverage if feasible.

## Out Of Scope

- Rebuilding timeline state.
- Replacing run registry.
- Reconnect reconciliation.
- Input/modal ownership cleanup.

## Alignment Log

| Date | Area | Expected Design | Deviation | Reason | Decision | Follow-up | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-06-22 | Status rendering | Bottom status bar renders a structured model with segment priority and truncation behavior. | None | Directly matches UI-1 scope. | Added `StatusBarModel`/`StatusSegment`, builder, deterministic formatter, and tests. | UI-2 can consume the model from a broader screen model. | Done |
| 2026-06-22 | Activity status | Activity status appears only in the status bar, not duplicated above the composer. | Previous implementation kept the old composer-adjacent activity line. | Main design requires a single current-running-status surface. | Removed the duplicate activity line from `TuiApp`; `BottomStatusLine` remains the owner. | None. | Done |

## Open Questions

None for this PR. Connection/activity status, mode, and policy are prioritized before model, context, and cwd under narrow widths.

## Merge Checklist

- [x] Status bar consumes a structured model.
- [x] No old message-log model is introduced.
- [x] Truncation behavior is deterministic.
- [x] Activity status is not duplicated above the composer.
- [x] PR references tracking issue #232.
