# UI-3: Input Owner And Studio Mode

> **Status: historical record.** This page preserves earlier design or implementation context; it does not define current behavior. Start with [the current documentation map](../../../index.md).

## Scope

Consolidate input ownership, modal ownership, and Studio/Chat mode state into the UI reducer.

## Design Baseline

- Input owner should be derived through explicit UI state.
- Modal, picker, external editor, composer, and Studio/Chat mode should not compete through scattered React local state.
- `/studio`, `/chat`, `/resume`, and `/new` should leave mode and owner state coherent.
- UI cleanup should not change the timeline/run/snapshot contract.

## Expected Changes

- Move modal/picker owner state into the reducer where practical.
- Consolidate Studio/Chat mode state.
- Make command routing depend on one mode source.
- Preserve composer behavior while reducing hidden local state coupling.

## Out Of Scope

- Timeline message migration.
- Run registry migration.
- Reconnect reconciliation.
- StatusBar model work already owned by UI-1.

## Alignment Log

| Date | Area | Expected Design | Deviation | Reason | Decision | Follow-up | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-06-22 | Studio/chat mode | One reducer-owned source controls Studio mode and conversation id. | Resume picker remains hook-owned. | Picker loading/selection is controller lifecycle state; moving it would expand UI-3 too far. | Added reducer-owned `ui.mode`, `ui.studioConversationId`, and `ui.externalEditorOpen`; `/studio`, `/chat`, `/resume`, and `/new` clear mode coherently. | A later UI cleanup can move picker indices/open flags if desired. | Done |
| 2026-06-22 | Input owner routing | Input routing goes through one owner state machine, including external editor ownership. | Picker lifecycle data remains local/hook-owned; owner routing is centralized. | Moving async picker loading state into the reducer is orthogonal to command routing and would broaden this PR. | Added external editor to `TuiInputOwner` and routed terminal input through `resolveTuiInputOwner` instead of a TuiApp early return. | None for this PR. | Done |
| 2026-06-23 | Resume UI owner cleanup | Resume should clear stale reducer-owned UI owner state before the new snapshot becomes authoritative. | `session.snapshot.loaded` for resume relied on command/picker callers to reset Studio mode and did not clear the external-editor owner in the reducer path itself. | Main design lists resume as a route/run/UI/modal cleanup scenario, so the reducer path should be self-contained. | Clear `ui.mode`, `ui.studioConversationId`, and `ui.externalEditorOpen` in the resume snapshot reducer path. | None. | Done |

## Open Questions

None for this PR. External editor open/closed owner state lives in the reducer; async editor execution remains in `TuiApp`.

## Merge Checklist

- [x] One authoritative owner exists for composer/modal/picker mode.
- [x] `/studio` and `/chat` mode transitions are deterministic.
- [x] Resume/new clears stale UI owner state.
- [x] Resume snapshot clears stale reducer-owned UI owner state.
- [x] External editor input ownership routes through the input owner state machine.
- [x] PR references tracking issue #232.
