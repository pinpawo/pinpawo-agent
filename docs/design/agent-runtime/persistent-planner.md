# Persistent Planner lane design (superseded)

Status: superseded.

The earlier design made the Capability Planner transcript a trace-scoped
`orchestrator` lane in root `messages`. That mixed three different concerns:

- Planner working memory;
- root conversation and checkpoint storage;
- idempotent Planner commit replay.

It also let one run accumulate Entry and Boundary Human/AI/Tool turns long after
those turns stopped being useful model context. The implementation then had to
continually select, exclude, compact, invalidate, and clean those messages.

Do not extend the trace-scoped Planner lane design. The replacement direction is
the [Run-scoped Planner session](run-scoped-planner-session.md): Planner is a
stateful steering domain for one root run, Boundary context is an
invocation-only overlay, and a new run starts with a clean Planner session.

This file remains only to keep historical links resolvable. Its former detailed
contract was intentionally removed so it cannot compete with the replacement
design.
