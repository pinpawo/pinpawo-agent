# TUI PR Alignment Docs

## Purpose

Every TUI overhaul implementation PR should have one alignment document under this directory.

The alignment document is not a design replacement. It is a lightweight coordination record for implementation-time drift:

- what the PR planned to do;
- what changed during development;
- why the implementation diverged from the design;
- whether the deviation is accepted, rejected, or deferred;
- what follow-up issue or PR is needed.

## Required Rule

If a PR deviates from `docs/TUI_OVERHAUL_DESIGN.md`, update that PR's alignment document in the same PR before merging.

The alignment document should be updated for:

- contract artifact changes;
- data model changes;
- reducer/action/selector ownership changes;
- snapshot or reconnect behavior changes;
- UI state ownership changes;
- any temporary compatibility path;
- any intentionally failing, skipped, or target-only test added to document future behavior;
- any decision to keep old `history`, `transcript`, `transcriptSnapshot`, `activeRun`, `runRoute`, or `skipTimelineIds` behavior longer than planned.

## Non-Negotiable Constraints

- `timeline` is the TUI expression of backend checkpoint messages.
- `timeline` contains user interaction messages: user message, assistant streaming/final message, and tool operation message.
- pending review, runtime, studio progress, connection, token usage, and active run are state, not timeline messages.
- Do not introduce `transcript`, message-only view, or `transcriptSnapshot` as a second message log.
- If temporary compatibility is unavoidable, record the removal plan in the PR alignment document.

## Document Shape

Each PR alignment document should use this shape:

```md
# <PR Track>: <Title>

## Scope

## Design Baseline

## Expected Changes

## Out Of Scope

## Alignment Log

| Date | Area | Expected Design | Deviation | Reason | Decision | Follow-up | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |

## Open Questions

## Merge Checklist
```

## Status Values

- `proposed`: the deviation is observed but not decided.
- `accepted`: the deviation is intentional and documented.
- `rejected`: the PR should be changed back to the design.
- `deferred`: the deviation is accepted temporarily and has a follow-up.
