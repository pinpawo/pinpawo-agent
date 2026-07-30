---
title: System Prompt Authoring Principles
page_type: concept
status: validated
updated: 2026-07-31
sources:
  - ../sources/model-prompting-and-harness-references.md
  - ../../PET_AGENT_DECISION_SYSTEM_PROMPT_DESIGN.md
  - ../../ORCHESTRATOR_TERMINAL_SEMANTICS_DRAFT.md
  - ../../PET_AGENT_API_CAPABILITY_TOOLKIT.md
  - ../../../packages/pet-agent/src/agent/orchestrator/prompts/templates/capabilityPlannerAgent.prompt.ts
  - https://github.com/pinpawo/pinpawo-agent/issues/417
  - https://github.com/pinpawo/pinpawo-agent/issues/490
  - https://github.com/pinpawo/pinpawo-agent/pull/492
  - https://github.com/pinpawo/pinpawo-agent/pull/515
related:
  - ../overview.md
  - ../capability-toolkit-architecture.md
  - orchestrator-practical-reasoning.md
  - prompt-knowledge-layers.md
  - decision-node-ownership.md
  - ../decisions/capability-planner-task-boundaries.md
  - ../decisions/delegation-completion-acknowledgement.md
  - ../questions/system-prompts-open-questions.md
---

# System Prompt Authoring Principles

## Purpose

Production prompts are one part of an agent harness. A prompt change is correct
only when its semantic owner, evidence boundary, structured result, runtime
transition, and evaluation objective remain coherent.

The target is the smallest model-visible contract that makes the desired
behavior understandable. Code deterministically owns what it can derive or
enforce.

## Evidence-backed position

Current model guidance converges on direct, structured, outcome-focused prompts:

- state the goal, context, constraints, evidence, success condition, and output
  clearly;
- prefer positive behavior over long anti-pattern lists;
- avoid preserving scaffolding merely because an older model needed it;
- treat tools, observations, memory, schemas, and control flow as part of the
  prompting system.

The external evidence and its authority are summarized in
[Model Prompting and Harness References](../sources/model-prompting-and-harness-references.md).

## Authoring contract

### 1. Start with the owned positive behavior

Describe what the actor should judge or produce, which evidence it may use, and
what success means. Add a prohibition only to close a real semantic, safety, or
authority boundary.

For example, entry owns whether a new result is still required. It does not need
an inventory of every tool operation or a warning for every unsupported guess.

### 2. Keep one semantic owner

State a rule once at the narrowest layer that owns it:

- entry owns result availability;
- the Capability Planner owns document exploration, task formation, concrete
  Capability choice, and future work;
- outcome owns the announce verdict;
- answer owns user-visible communication.

Do not duplicate the same judgment in the shared prefix, dynamic context, tool
description, schema, and graph route.

### 3. Distinguish contract, facts, and enforcement

Use [Prompt Knowledge Layers](prompt-knowledge-layers.md):

| Layer | Examples |
|---|---|
| Static contract | The Planner must form a current task and select its Capability |
| Conditional protocol | JSON-mode schema rendering |
| Injected facts | User intent, workspace digest, completed tasks, latest handoff |
| Deterministic enforcement | Schema validation, workspace containment, budgets, routing |

Invocation facts must not become an untrusted second instruction channel.
Mechanical invariants should not depend on model obedience.

### 4. Express outcomes, not a hand-written reasoning trace

Specify the mission, evidence, allowed results, stopping conditions, and
authority boundaries. Avoid prescribing an internal thought sequence unless
order itself is a product or safety requirement.

The Planner is intentionally a tool-loop agent. The prompt tells it what a valid
plan and selection accomplish; the model decides which files to discover and
read.

### 5. Make hard constraints operational

Critical behavior needs enforcement or detection outside prose when feasible:

- schemas and validators own output shape;
- graph guards own legal transitions and iteration limits;
- filesystem code owns containment, symlink safety, digest verification, and
  read budgets;
- registry compilation owns executable availability;
- response-format construction and runtime validation own selected-name
  membership and the General fallback invariant;
- semantic evals own judgments that code cannot prove.

### 6. Treat tools and observations as the agent-computer interface

Tool names, parameters, return shapes, errors, and observations teach the model
how to act. Before adding prompt text, check for:

1. missing or stale evidence;
2. ambiguous tool affordances;
3. an output schema that cannot express the intended distinction;
4. a graph or provenance error;
5. only then, an underspecified semantic contract.

For the Capability Planner, `glob_search`, `grep_search`, and
`view_file_chunk` are part of this interface. An in-memory relevance query would
change the decision architecture, not merely optimize tool usage.

### 7. Keep examples selective and eval-backed

Examples are strong steering signals and easy to overfit. Keep general rules in
production prompts and diverse normal, boundary, and adversarial cases in evals.
Add a production example only when a measured recurring failure improves without
regressing representative behavior.

### 8. Preserve product semantics across models

Prompt wording and scaffolding may vary by model. Node ownership, authority,
result meanings, and user-visible behavior do not.

For a model change:

1. preserve the current contract and eval profile;
2. remove legacy scaffolding incrementally;
3. test relevant reasoning and protocol settings;
4. compare success, failures, unnecessary work, tokens, latency, and cost;
5. keep provider-specific adaptation conditional.

### 9. Test behavior, not prompt prose

Deterministic tests should protect:

- template rendering and structured input;
- schema and tool-call contracts;
- message roles, order, lanes, and provenance;
- workspace and runtime invariants;
- graph transitions.

They should not infer semantic behavior from the presence of a phrase. Use
goal-based model evals for result availability, planning, Capability selection,
announce verdicts, and replies.

## Current evaluation ownership

| Contract | Semantic objective | Deterministic evidence | Diagnostics |
|---|---|---|---|
| `entry.result-availability` | Choose `answer` only from sufficient canonical evidence or necessary clarification; otherwise enter planning | enum/schema, invocation status, graph route | variants, tokens, latency, cost |
| `planner.task-and-capability` | Explore Capability documents, form the correct current task, choose a complete executor, and preserve justified future work | tool protocol, workspace membership, General invariant, budgets, runtime mapping | files observed, task count, plan effect, tokens, latency, cost |
| `outcome.announce-verdict` | Distinguish continuation, task completion with autonomous follow-up, user-goal completion, and required user input | enum/schema, transition, lane/handoff invariants | variants, tokens, latency, cost |
| `answer.user-visible-close` | Fulfil the current reply objective from canonical evidence without inventing terminal meaning | message filtering, typed terminal context, output existence | length, overlap, tokens, latency, cost |

The Planner is evaluated as a tool-loop behavior, not as a single-call Decision.
Its private transcript and file observations are implementation evidence; the
structured plan and graph lifecycle remain the externally meaningful result.

## Capability Planner-specific review

Review Planner changes against these questions:

1. Does the model still explore the immutable Capability Document Workspace
   itself?
2. Are task boundary and concrete Capability selection still one semantic
   judgment?
3. Does future work remain intent-only until it becomes current?
4. Does specialized mismatch select Workspace `general` rather than
   `unavailable`?
5. Is `unavailable` truthful only when no executable Capability exists?
6. Does goal completion remain with `outcomeDecision` rather than reappearing as
   a Planner `answer` path?
7. Are size, timeout, and containment risks handled through bounded tools and
   runtime controls rather than by injecting every document into the prompt?

## Acceptance status

The ownership and harness principles are validated against current production
code and deterministic suites. Cross-model behavior, large-registry exploration,
and evidence-freshness profiles remain open empirical work rather than reasons
to restore the removed search/selection pipeline.
