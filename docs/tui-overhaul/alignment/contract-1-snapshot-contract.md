# CONTRACT-1: Server Snapshot Contract

## Scope

Define the server snapshot contract before the client fully depends on it.

## Design Baseline

- Snapshot returns `timeline + runs + state`.
- `timeline` is backend checkpoint messages.
- state includes pending review, runtime, token usage, active run, and any restore-relevant UI/runtime status.
- Snapshot contract should support startup, resume, and reconnect reconciliation.

## Expected Changes

- Decide whether to add `/tui/snapshot` or compose existing endpoints.
- Specify snapshot fields, optional fields, and versioning expectations.
- Specify how stale review and closed review states are represented.
- Specify whether incremental reconciliation needs a revision id.

## Out Of Scope

- Implementing full reconnect reconciliation.
- Rewriting backend runtime.
- UI rendering changes.
- Introducing transcript/message-only checkpoint views.

## Alignment Log

| Date | Area | Expected Design | Deviation | Reason | Decision | Follow-up | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |

## Open Questions

- Should snapshot be a single endpoint or a client-side composition of existing endpoints?
- Do snapshot responses need a monotonic revision for incremental reconnect?

## Merge Checklist

- [ ] Contract separates timeline messages from state.
- [ ] Startup/resume/reconnect use cases are all covered.
- [ ] No transcript/message-only model is introduced.
- [ ] PR references tracking issue #232.
