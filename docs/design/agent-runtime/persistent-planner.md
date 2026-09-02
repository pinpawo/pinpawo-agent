# Persistent Supervisor lane design (superseded)

Status: superseded.

The earlier design made the Run Supervisor provider history a trace-scoped
`orchestrator` lane in root `messages`. That mixed three different concerns:

- Supervisor working memory;
- root conversation and checkpoint storage;
- idempotent Supervisor command replay.

It also let one run accumulate Entry and Boundary Human/AI/Tool turns long after
those turns stopped being useful model context. The implementation then had to
continually select, exclude, compact, invalidate, and clean those messages.

Do not extend the trace-scoped Supervisor lane design. The replacement direction is
the [Run-scoped Supervisor session](run-scoped-supervisor-session.md): Supervisor is a
stateful steering domain for one root run, Boundary context is a typed current
input projection, and a new run starts with a clean Supervisor session.

This file remains only to keep historical links resolvable. Its former detailed
contract was intentionally removed so it cannot compete with the replacement
design.
