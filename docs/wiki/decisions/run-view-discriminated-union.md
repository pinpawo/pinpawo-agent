---
title: Active Run View As A Discriminated Union
page_type: decision
status: validated
updated: 2026-07-28
sources:
  - ../../../packages/agent-session/src/domain.ts
  - ../../../packages/agent-session/src/project.ts
  - ../../../services/local-agent/src/tui/tuiLocalServerClient.ts
  - ../../../services/local-agent/src/inflightRequestController.ts
  - ../../../services/local-agent/src/chatSessionAdapter.ts
  - https://github.com/pinpawo/pinpawo-agent/issues/385
  - https://github.com/pinpawo/pinpawo-agent/pull/389
  - https://github.com/pinpawo/pinpawo-agent/pull/468
related:
  - ../local-agent-session-projection.md
  - ../interruption-and-delegation-continuation.md
  - ../concepts/session-projection-ownership.md
  - review-resolution-is-client-local.md
---

# Active Run View As A Discriminated Union

## Decision

The active run in an `AgentSession` is a discriminated union
(`AgentRunView`) of exactly three server-observed facts, carried in snapshot
version 3
([`domain.ts`](../../../packages/agent-session/src/domain.ts)):

- `running` — carries one runtime `activity`: `thinking`, `using_tool`, or
  `streaming`;
- `waiting_review` — structurally carries its checkpoint-derived `ReviewAction`;
- `interrupting` — the server run controller has begun interruption.

## Rationale

The earlier flat shape (`phase` enum plus an optional `reviewAction`) allowed
illegal combinations — a waiting review without review content, or a running run
that still carried a review action — and forced every consumer to re-infer the
valid `phase × reviewAction` cross-product. Removing `ReviewAction.status`
(PR #388) deleted one field but left that cross-product enforced by reducer
discipline and tests rather than by types. PR #389 finished the job: the union
makes the invalid combinations unrepresentable in TypeScript and rejects them at
the local snapshot boundary parser.

## Constraints

- The initial `running` / `thinking` view is created only **after** the outbound
  run command is accepted by the transport.
- Later `running.activity` changes come from server runtime events. Elapsed-time
  presentation (busy-copy escalation) stays in the render layer and must not leak
  into the shared view.
- `waiting_review` always carries its `ReviewAction`; `running` and `interrupting`
  never carry review content.
- Sending `run.interrupt` does **not** optimistically create the `interrupting`
  view; only the server run controller does.
- `interrupting` is non-terminal. It remains the active run until the invocation
  owner has observed graph output settlement and emits terminal `interrupted`;
  a client timer cannot perform this transition.
- Whether an interrupted review delegation may be offered through `/continue`
  is a separate TUI-local fact, not a fourth `AgentRunView` variant.
- Snapshot versions 1 and 2, `runs[] + activeRunId`, legacy pending-review
  payloads, and message-only restore are unsupported by the current reader.

## Consequences

Bugs of the "submit-then-Esc targets a stale action" family (found and fixed
around PR #367/#388) become type-level impossibilities rather than review
findings. This is the type-system counterpart to keeping review command progress
client-local; see
[Review resolution is client-local](review-resolution-is-client-local.md).
The lifecycle beyond `interrupting` is detailed in
[Interruption and delegation continuation](../interruption-and-delegation-continuation.md).
