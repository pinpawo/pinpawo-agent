---
title: Session Projection Open Questions
page_type: question
status: draft
updated: 2026-07-28
sources:
  - ../../LOCAL_AGENT_SESSION_PROJECTION.md
  - ../../../services/local-agent/src/tui/TuiRuntimeController.ts
  - https://github.com/pinpawo/pinpawo-agent/issues/386
  - https://github.com/pinpawo/pinpawo-agent/issues/408
  - https://github.com/pinpawo/pinpawo-agent/pull/485
related:
  - ../local-agent-session-projection.md
  - ../interruption-and-delegation-continuation.md
  - ../concepts/local-agent-transport-boundary.md
  - ../concepts/session-projection-ownership.md
---

# Session Projection Open Questions

The projection refactor line is materially complete (umbrella #355 and sub-issues
#377, #385, #386, #390 are closed). These are the remaining forward-looking
questions, none of which currently block correctness.

## 1. TUI session operations on the HTTP side channel

**Open.** The TUI reaches snapshot/list/resume through HTTP endpoints, while
spawned stdio clients use the wire `session.*` commands. The server implements
each operation once, but two client parsers exist for the same operations.
Migrating the TUI onto the wire channel is the logical last step of #386.

Evidence needed: whether a wire-only TUI (or a spawned-TUI mode) is on the
roadmap. Until then this is deliberate residue, not a defect.

## 2. A future public / API projection

**Open.** No public/API projection exists yet. Before one is built, three
guardrails from this refactor should be pinned:

- **Inference.** The API projection must be an adapter over `AgentSession`,
  not a third domain model. Per #355/#385, a Gateway public projection must not
  define the local-agent domain model — the adapter maps local identifiers to
  canonical ones and trims fields (for example strips operation `raw`), without
  redefining session/timeline/review semantics.
- **Decision.** Do not introduce protocol/version negotiation before a real
  multi-version consumer exists. Today snapshot `version` bumps (v1→v2→v3) are
  free because there is one binary and no third-party consumer; that changes once
  an external consumer exists.
- **Fact.** `session.error` currently passes `error.message` through. At a remote
  API boundary this must be sanitized, like the `raw` stripping already done for
  operation events.

## 3. Snapshot checkpoint coordinate

**Open.** The `/snapshot` endpoint materializes the latest checkpoint point with
an implicit coordinate. Explicit historical-point lookup and execution-detail
reconstruction were explicitly deferred, not designed. Whether they are ever
needed depends on a debug/export requirement.

## 4. Overlay state-ownership cleanup

**Open (tracked: [issue #408](https://github.com/pinpawo/pinpawo-agent/issues/408)).**
`GlobalReviewPolicyPicker` holds loose `useState`s plus an imperative auto-close
effect, unlike the reducer-derived approval overlay and the controller-hooked
resume picker. This is a small state-ownership alignment left from the
interaction-owner work (#383), not a projection-model gap.

## 5. Reconstructing continuation availability after a client restart

**Open.** The TUI currently offers `/continue <指导>` only after the same
controller instance sent `review.cancel` and observed the matching request
terminalize as `interrupted`. This process-local causal marker is intentionally
not part of `AgentSessionSnapshot`.

If the TUI process restarts, the durable checkpoint can still retain a pending
active delegation and its lane, but the restarted client cannot reconstruct why
it is pending or whether `/continue` is the right affordance. Inferring from an
old terminal timeline item would conflate transport history with current
checkpoint authority.

Evidence needed: a product requirement to resume review-interrupted work across
client restarts. If that requirement appears, the design needs an authoritative
server/checkpoint projection of resumability and reason, with invalidation rules;
serializing the current boolean marker or showing `/continue` after every
interrupted run would not be sufficient.
