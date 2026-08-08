---
title: Prompt Knowledge Layers
page_type: concept
status: validated
updated: 2026-08-09
sources:
  - ../../PET_AGENT_DECISION_SYSTEM_PROMPT_DESIGN.md
  - ../../DYNAMIC_CONTEXT_GOVERNANCE_DESIGN.md
  - ../../../packages/pet-agent/src/agent/orchestrator/capabilityPlanner/agent.ts
  - https://github.com/pinpawo/pinpawo-agent/pull/492
  - https://github.com/pinpawo/pinpawo-agent/pull/515
related:
  - orchestrator-practical-reasoning.md
  - decision-node-ownership.md
  - message-context-and-provenance.md
  - dynamic-context-governance.md
  - system-prompt-authoring-principles.md
  - ../questions/system-prompts-open-questions.md
---

# Prompt Knowledge Layers

## Core model

The accepted design separates four kinds of knowledge. The first three appear in
model input; the fourth belongs to the runtime.

| Layer | Purpose | Examples |
|---|---|---|
| Static contract | Stable meaning of a node and its output | entry chooses result availability; Planner forms a task and selects its Capability; outcome validates an announce |
| Conditional protocol | Protocol selected by provider or product configuration without changing graph semantics | JSON mode schema rendering |
| Injected facts | Values that vary per call | Entry briefing, accepted completed-task result, future tail, announce, workdir |
| Deterministic enforcement | State and safety rules that code can derive | guards, workspace containment, terminal-tool availability, selected-name validation, routing, cleanup |

This model is defined by
[the decision prompt design](../../PET_AGENT_DECISION_SYSTEM_PROMPT_DESIGN.md)
and instantiated by the current Planner harness.

## Why the distinction matters

Static contracts give a structured output stable semantics. If the meaning of
`answer` or `goal_done` changes through arbitrary runtime text, the graph no
longer has one contract.

Injected facts must not become a second instruction channel. Dynamic task or
candidate content describes the current situation; it does not get to redefine
the node.

A runtime may project typed state for the current invocation. Such facts remain
bounded by code: callers cannot supply arbitrary policy text, and an injected
objective cannot add behavior outside the node's accepted contract.

Current Answer code identifies terminal state and composes state-derived reply
prose into the leading system message. That is implementation fact, not the
target placement rule. The
[Dynamic Context Governance](dynamic-context-governance.md) contract places
bounded facts through an explicit typed context message and keeps the stable
system contract free of invocation data.

Deterministic conditions should be enforced in code even if the prompt mentions
them for context. The model is not the sole guard for availability, iteration
limits, message identity, or state cleanup.

## Product policy is not yet fully modeled

The repository has a mature static-versus-fact distinction, but no accepted
general abstraction for dynamic product policies. Adding arbitrary scoped prompt
strings would recreate multiple policy sources and conflict-resolution problems.

Until such a model is designed and evaluated:

- stable action semantics remain in static contracts;
- current values remain facts;
- host permissions and guards remain typed runtime configuration;
- capability-private execution instructions stay in the selected subagent;
- new product policy channels require a separate design rather than piggybacking
  on an incident fix.

## Change test

Before adding a prompt clause, ask:

1. Does it define the stable meaning of this node or output? If yes, it may belong
   in the static contract.
2. Is it a value or evidence item for this invocation? If yes, inject it as a fact.
3. Can code derive or enforce it? If yes, put the enforcement in code.
4. Is it a configurable product preference? If yes, first identify a typed owner,
   scope, and conflict model; do not add a free-form prompt rule by default.
5. Is it only a response to one failing example? If yes, express the general
   semantic boundary and keep the example in evals.

For clause-level writing and review, apply
[System Prompt Authoring Principles](system-prompt-authoring-principles.md).
