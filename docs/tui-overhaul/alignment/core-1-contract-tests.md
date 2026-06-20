# CORE-1: Contract And Failing Tests

## Scope

Freeze the TUI message/state contract and add behavior tests that describe the target model before runtime migration starts.

## Design Baseline

- `timeline == backend checkpoint messages`.
- Timeline contains user message, assistant streaming/final message, and tool operation message.
- pending review, runtime, studio progress, connection, token usage, and active run are state, not timeline messages.
- No `transcript`, message-only view, or `transcriptSnapshot` second message log.

## Expected Changes

- Add tests for completed events when active pointers are missing.
- Add tests for reconnect after server completion.
- Add tests for pending review restoration.
- Add tests for resume/new route cleanup.
- Document any contract gaps discovered while writing tests.

## Out Of Scope

- Migrating reducer state.
- Replacing `activeRun` / `runRoute`.
- Adding reconnect snapshot behavior.
- UI layout changes.

## Alignment Log

| Date | Area | Expected Design | Deviation | Reason | Decision | Follow-up | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |

## Open Questions

- Which existing fixture best represents backend checkpoint messages?

## Merge Checklist

- [ ] Tests encode target behavior without broad implementation rewrites.
- [ ] No new transcript/message-only model is introduced.
- [ ] Any intentionally failing or skipped test is explained in this document.
- [ ] PR references tracking issue #232.
