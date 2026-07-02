# Guard Registry Design

> Status: deprecated. Superseded by [GUARD_DESIGN.md](./GUARD_DESIGN.md) on 2026-07-02.

The guard design is now defined in [GUARD_DESIGN.md](./GUARD_DESIGN.md).

Key changes from this document's model:

- `pass`/`block` is replaced by a `GuardOutcome` union
  (`proceed | stop | maintain | derive`).
- Every evaluation emits a decision record through a single choke point;
  records are the debugging language.
- The registry, runner/adapter layer, and per-guard handler objects are removed
  from the main path; effects are owned by positions, shared logic lives in
  decision/effect helpers.
