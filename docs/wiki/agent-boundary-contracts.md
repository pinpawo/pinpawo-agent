---
title: Agent Boundary Contracts
page_type: system
status: validated
updated: 2026-08-22
sources:
  - ../../packages/agent-contracts/src/configuration.ts
  - ../../packages/agent-contracts/src/invocation.ts
  - ../../packages/agent-contracts/src/interaction.ts
  - ../../packages/agent-contracts/src/state.ts
  - ../../packages/agent-contracts/src/contracts.test.ts
  - ../../packages/pet-agent/src/agent/orchestrator/review/reviewSpec.ts
  - ../../packages/agent-session/src/review.ts
  - ../../packages/agent-session/src/parser.ts
  - ../../packages/agent-session/src/snapshot.ts
  - ../../services/local-agent/src/chatSessionAdapter.ts
  - ../../services/local-agent/src/pendingHumanReviewInterrupt.ts
  - ../../services/local-agent/scripts/tui-v2-install-smoke.ts
  - https://github.com/pinpawo/pinpawo-agent/issues/570
  - https://github.com/pinpawo/pinpawo-agent/pull/572
related:
  - local-agent-session-projection.md
  - concepts/session-projection-ownership.md
  - decisions/review-resolution-is-client-local.md
  - concepts/local-agent-transport-boundary.md
  - concepts/studio-pet-thread-dispatch-invocation.md
  - interruption-and-delegation-continuation.md
---

# Agent Boundary Contracts

## Purpose

**Decision (issue #570, PR #572).** `@pinpawo/agent-contracts` is the
transport-neutral, runtime-independent contract layer between an agent runtime
and its callers. It is organized around what a caller can configure, invoke,
observe, and answer — not around graph nodes, checkpoint mechanics, or Studio
and Chat transport names.

The package is a browser-safe, side-effect-free leaf package. `pet-agent` and
`agent-session` both depend on it; `agent-session` no longer imports shared
agent contracts directly from `pet-agent`.

```text
                    @pinpawo/agent-contracts
                 Configuration · Invocation
                 Interaction · State
                       ▲              ▲
                       │              │
                  pet-agent      agent-session
                       \            /
                        \          /
                         local-agent
```

This is a dependency and ownership boundary, not a second runtime. It does not
construct graphs, carry WebSocket or HTTP envelopes, reduce session timelines,
or store checkpoint state.

## The four ports

| Port | Boundary values | What remains internal |
| --- | --- | --- |
| Configuration | `AgentConfig`, `AgentConfigUpdate`, `AgentConfigSnapshot`; externally selectable `toolAuthorization.mode` | custom resolvers, policy callbacks, model-assisted review, and authorization decisions |
| Invocation | `AgentInvocationRequest`, invocation events, terminal result | Chat/Studio envelopes, Studio task/lease correlation, graph construction and execution policy |
| Interaction | `HumanReviewRequest`, response, and batch response | `ReviewSpec` decisions/effects, pending action details, interrupt payloads, and review resolution |
| State | observable `AgentStateSnapshot`, `AgentWorkSnapshot`, token usage, explicit resume/cancel commands | delegation stack, internal state transitions, provider normalization, and usage aggregation |

**Fact.** The Invocation port defines the common core shape now, but the
production Chat path still uses its established local-agent envelope and adapter.
That is intentional: Studio/API adoption should adapt this port instead of
introducing a competing Studio-only agent request.

## Human review: public interaction, private execution authority

`pet-agent` owns the internal `ReviewSpec`. It includes the option decision and
possible effects needed to resume the graph. Before a review leaves the runtime,
[`projectHumanReviewRequest`](../../packages/pet-agent/src/agent/orchestrator/review/reviewSpec.ts)
creates a presentation-only `HumanReviewRequest`.

```text
checkpointed ReviewSpec                 public HumanReviewRequest
  interaction id                         interactionId
  view                         ───────►  view
  options + decision/effects              display options + input + batchSubmission
                                          no decision, effect, action, or checkpoint payload
```

The canonical selection contains only `interactionId`, `selectedOptionId`, and
optional input. The runtime resolves that choice against the authoritative
internal spec; it never trusts a supplied decision or effect. The surrounding
checkpoint fact is `PendingInterrupt`; human review is its payload and
presentation projection, not an independent lifecycle.

Current Chat/TUI carries the selection in a response for its implicit active
thread. Studio may later carry the same interrupt-resume semantics in a dispatch
to an explicit `petId`, but those dispatch coordinates do not enter the shared
projection. See [Studio Pet thread and dispatch
invocation](concepts/studio-pet-thread-dispatch-invocation.md).

### Batch submission is an interaction instruction

**Fact.** Human Review schema V2 makes every option declare:

```ts
batchSubmission: 'defer' | 'immediate'
```

This says when the client submits the ordered decisions for the current review
batch. `defer` permits collection of the next review; `immediate` submits now.
It does **not** say whether a conversation, graph, or agent continues. The
runtime currently projects approve options as `defer` and reject/respond options
as `immediate`; the client does not infer those runtime decision types.

### Checkpoint reload is the route

[`chatSessionAdapter`](../../services/local-agent/src/chatSessionAdapter.ts)
emits a public human-review projection when the graph stops at an interrupt.
It does not register a second server-side review lifecycle. On every response
or cancel attempt, the Chat handler reloads the implicit active thread's
checkpoint, obtains the current interrupt id and internal `ReviewSpec[]`, then
validates and builds the graph resume. If the checkpoint does not contain a
matching human-review interrupt, the command fails closed.

## Version and compatibility policy

**Decision.** A wire-shape change is explicit rather than silently reusing an
internal schema version.

- Public `HumanReviewRequest` emits schema V2. It requires `interactionId` and
  `batchSubmission`; legacy `id`, decision/effect fields, and the earlier
  `continuesReviewBatch` field are rejected at this boundary.
- Local inbound compatibility still accepts deprecated `reviewId` as an alias
  for `interactionId`; conflicting aliases are rejected.
- `AgentSessionSnapshot` emits V4. Its parser accepts valid V3 checkpointed
  internal review specs and projects them to public Human Review V2; malformed
  legacy reviews are rejected rather than silently dropping or inventing state.

The contract package supplies strict parsers for untrusted boundary values. A
transport may add an envelope or disclosure policy, but it must not weaken or
reinterpret these values.

## Session and transport relationship

`agent-contracts` is not an `AgentSession` replacement. `agent-session` owns
the request/session envelope, timeline projection, snapshot, and deterministic
reducer. `local-agent` owns HTTP, WebSocket, stdio, TUI, hosted-app routing, and
runtime lifecycle. These layers consume the contracts through adapters.

```text
PetAgentRuntime / checkpoint
  ├─ internal ReviewSpec + effects ──► runtime resolution
  └─ projection ──► agent-contracts ──► agent-session ──► local transports and UI
```

This separation lets a future Studio host invoke a long-lived Pet chat runtime
through the same boundary without changing stable Chat runtime behavior or
copying its internal graph protocol.

## Packaging and verification

`@pinpawo/agent-contracts` is publishable independently. Consumers are released
in dependency order:

```text
@pinpawo/agent-contracts → @pinpawo/pet-agent → pinpawo (local-agent)
```

The install smoke test packs and installs all three tarballs into an empty
project before running the installed launcher and PTY flow. This prevents a
workspace-only dependency from masking a missing published contract package.
