---
title: Dynamic Context Governance
page_type: concept
status: draft
updated: 2026-08-09
sources:
  - ../../DYNAMIC_CONTEXT_GOVERNANCE_DESIGN.md
  - ../../../packages/pet-agent/src/agent/orchestrator/prompts/context.ts
  - ../../../packages/pet-agent/src/agent/orchestrator/prompts/answer.ts
  - ../../../packages/pet-agent/src/agent/orchestrator/prompts/answer.test.ts
  - ../../../packages/pet-agent/src/agent/orchestrator/runtime/nodes/answer.ts
  - ../../../packages/pet-agent/src/agent/orchestrator/runtime/nodes/answer.test.ts
  - ../../../packages/pet-agent/src/agent/orchestrator/runtime/nodes/capability.ts
  - ../../../packages/pet-agent/src/agent/orchestrator/capabilityPlanner/runner.ts
  - ../../../packages/pet-agent/src/agent/orchestrator/runtime/decisions/orchestrationDecision.ts
  - ../../../packages/pet-agent/src/agent/orchestrator/runtime/nodes/capabilityPlanner.ts
  - ../../../packages/pet-agent/src/agent/orchestrator/contextCompaction.ts
related:
  - ../overview.md
  - prompt-knowledge-layers.md
  - system-prompt-authoring-principles.md
  - message-context-and-provenance.md
  - decision-node-ownership.md
  - ../decisions/delegation-completion-acknowledgement.md
---

# Dynamic Context Governance

## Status and evidence

This page records the repository's dynamic-context governance model. The raw
design retains delivery planning; this Wiki page keeps only reusable contracts
and current implementation facts.

> **Per-node assembly is owned by [Context injection map](context-injection-map.md).**
> This page keeps the *governance contract* — who may own, render, and place
> dynamic context. For what each node actually receives today, read the map.

This page's earlier survey of current assembly has been removed: several of its
claims no longer hold. In particular, Answer's production invocation now uses
the typed `<answer_input>` fact message via `appendAnswerInputMessage()`, not a
legacy system-prose renderer, and the compaction summary is an `AIMessage`
carrying `authority="none"`, not a `SystemMessage`.

## Governance priority

The order is structural:

1. define the owner, location, typed shape, role, placement, and bounds of each
   context;
2. prevent dynamic facts and summaries from gaining system authority;
3. minimize propagation to the consumers that need each fact;
4. then measure stable prefixes, duplicate tokens, provider cache behavior,
   latency, and cost.

A stable cacheable prefix is an acceptance diagnostic. It is not the primary
abstraction and does not decide where context belongs.

## Context lifecycle

Every model-visible dynamic context should follow one reviewable path:

```text
runtime state and canonical messages
  -> context projection
  -> typed context facts
  -> context rendering
  -> invocation assembly
  -> model
```

- **Projection** belongs to the runtime semantic owner. It selects values and
  returns typed data, not prompt prose.
- **Typed facts** use closed variants and bounded fields. They do not expose an
  `extraSystemPrompt`, `replyInstruction`, or similar policy channel.
- **Rendering** belongs to the consumer's prompt package. It serializes facts
  as role-labelled data without inventing policy.
- **Invocation assembly** belongs to the same prompt package and owns message
  roles, ordering, omission, and bounds.

Runtime nodes retain graph transitions, state cleanup, invocation, and typed
projection. They should not concatenate model-facing context strings.

## Code ownership

The existing flat prompt-package layout is sufficient. Each model-facing actor
owns its stable contract, context renderer, and invocation builder in one review
location. Shared prompt helpers provide only mechanical escaping, clipping,
indentation, and provenance operations.

| Stage | Naming pattern | Return value |
|---|---|---|
| Runtime projection | `select<Node>ContextFacts` | typed facts |
| Static contract | `build<Node>SystemPrompt` | stable string |
| Fact rendering | `render<Node>Context` | bounded data string |
| Context message | `create<Node>ContextMessage` | synthetic message |
| Invocation assembly | `build<Node>InvocationMessages` | ordered messages |

The broad `prompts/context.ts` should be decomposed incrementally. A shared
module is justified only when multiple consumers have the same semantic
contract, not merely because their values are serialized with similar XML.

## Context Contract Map

The Prompt Contract Map indexes stable behavior. This separate map governs how
invocation facts reach those semantic owners.

| Context | Semantic owner | Target role and placement | Authority | Principal exclusions |
|---|---|---|---|---|
| Entry facts | `entryDecision` | synthetic facts for the current decision | read-only facts | registry, task drafts, private lanes |
| Planner entry briefing | Entry / Capability Planner boundary | Human input after the stable agent contract | objective (≤2,000 chars) and optional context (≤4,000 chars) | canonical transcript, private lanes, durable graph state |
| Planner boundary facts | Outcome / Capability Planner boundary | Human input after the stable agent contract | completed task, accepted announce result (≤16,000 chars), advisory remaining plan | Entry briefing, canonical transcript, private lanes |
| Outcome input | `outcomeDecision` | Human input after the stable decision contract | evidence plus advisory future plan | Capability documents, mutation policy |
| Answer context | `answer` | bounded context after canonical main history | typed reply-mode facts | copied request, full handoff, URL, arbitrary instruction |
| Delegation briefing | selected Capability | latest task-boundary message in its private lane | current task boundary | future plan, framework policy |
| Capability runtime facts | selected Capability | bounded context before the briefing | runtime facts | Capability or Toolkit policy |
| Compaction summary | downstream consumers | provenance-tagged context before retained messages | non-authoritative derived context | new policy, terminal meaning, current-user override |
| Auto-review facts | security reviewer | Human data after trusted review policy | untrusted evidence | action text in system policy |

Each maintained row also needs source state, typed fields, bounds, persistence,
provenance, prohibited content, and deterministic/model verification.

## Planner dispatch lifecycle

Planner input has two discriminated modes rather than one accumulating context:

- `entry` carries the current run's bounded request briefing. It exists only for
  the graph dispatch and is not reconstructed from a transcript later;
- `boundary` carries the task Outcome just accepted, its bounded result, and
  unstarted future work. It does not reuse the Entry briefing.

This keeps request interpretation close to Entry while preserving enough of the
actual execution result for boundary replanning. The runtime preserves the head
and tail when an unusually large result must be clipped so late constraints are
not silently discarded.

## Verification contract

Deterministic tests should protect role, order, provenance, bounds, typed
variants, absence of dynamic system data, Capability system-prompt invariance,
and zero Answer-model calls for fixed completion. Model evals should cover long
imperative completed tasks, instruction-like context, required-user-input
closes, and newer user messages overriding older summaries.

Tests should verify behavior and invocation structure, not the presence of a
particular natural-language clause.
