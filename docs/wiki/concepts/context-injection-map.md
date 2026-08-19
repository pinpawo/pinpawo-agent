---
title: Context Injection Map
page_type: concept
status: validated
updated: 2026-08-18
sources:
  - ../../reference/runtime/context-injection-map.md
  - ../../../packages/pet-agent/src/agent/orchestrator/prompts/shared.ts
  - ../../../packages/pet-agent/src/agent/orchestrator/prompts/context.ts
  - ../../../packages/pet-agent/src/agent/orchestrator/prompts/answer.ts
  - ../../../packages/pet-agent/src/agent/orchestrator/prompts/capabilityPlannerAgent.ts
  - ../../../packages/pet-agent/src/agent/orchestrator/capabilityPlanner/agent.ts
  - ../../../packages/pet-agent/src/agent/orchestrator/capabilityPlanner/messageContext.ts
  - ../../../packages/pet-agent/src/agent/orchestrator/contextCompaction.ts
  - ../../../packages/pet-agent/src/agent/orchestrator/delegationBriefing.ts
  - ../../../packages/pet-agent/src/agent/orchestrator/messageLanes.ts
  - ../../../packages/pet-agent/src/agent/orchestrator/runtime/nodes/entryAnswer.ts
  - ../../../packages/pet-agent/src/agent/orchestrator/runtime/nodes/capability.ts
  - ../../../packages/pet-agent/src/agent/orchestrator/runtime/nodes/capabilityPlanner.ts
  - https://github.com/pinpawo/pinpawo-agent/pull/664
  - https://github.com/pinpawo/pinpawo-agent/pull/666
  - https://github.com/pinpawo/pinpawo-agent/pull/668
related:
  - dynamic-context-governance.md
  - prompt-knowledge-layers.md
  - message-context-and-provenance.md
  - decision-node-ownership.md
  - ../decisions/capability-planner-task-boundaries.md
---

# Context Injection Map

> **Authority.** This page is the canonical description of what enters each
> model's context window. Where any other Wiki page describes context assembly
> differently, this page wins and the other page is stale. The maintained
> reference lives at `docs/reference/runtime/context-injection-map.md`.

## Status and evidence

Validated against merged `main` after PR #664 (Planner context in root lanes)
and PR #666 (Entry Answer goal resolution). Every claim below was read from
source, not from prior design documents.

## Two orthogonal axes

Context is classified on two axes that are routinely conflated:

**Static-ness** — `STATIC` (process constant) / `RUN-STABLE` (fixed once per
run, then replayed identically) / `DYNAMIC` (recomputed every invocation).

**Authority** — `INSTRUCTION` (must obey; system prompts only) / `BOUNDARY`
(defines done-ness for this step) / `FACT` (read-only data, explicitly not an
instruction) / `HISTORY` (canonical messages).

The second axis is already encoded in the XML: blocks carry `role=`, `source=`
and `trust=`/`authority=`. Those attributes are the only thing preventing a data
block from being read as a new user instruction.

## Model-invoking nodes

`entryAnswer`, `capabilityPlanner`, `capability` (subagent), `answer`, plus
`compactContext` as summarizer. `prepare`, `captureUserRequest` and the guards
invoke no model.

| Node | History projection | Injected facts |
|---|---|---|
| entryAnswer | `mainConversationMessages()` | none — no XML fact block at all |
| capabilityPlanner | `selectCapabilityPlannerMessages()`, filtered by `traceId` **and** `registryDigest` | `<run_user_request>`, boundary adds `<planning_state>`; `<default_capability>` rides the system message |
| capability | `laneMessages(lane, transcriptRunId, delegationId)` | `<run_user_request>` as background; `<delegation_briefing>` last |
| answer | **none** | `<answer_input>` — the entire context |

The two extremes are deliberate and opposite. `entryAnswer` receives no fact
block because it decides what the goal *is*, so it sees the conversation and
nothing else. `answer` receives no history because it is a **closer** — it runs
only after a decision, in `goal_done` / `blocked` / `user_input_required` mode,
and `<answer_input>` fully serves all three.

Boundary-mode `capabilityPlanner` is the only decision node that receives a full
delegation transcript. That is what lets it judge whether a task is done.

## Why Answer has no history

Every completed turn left a near-duplicate pair in the main conversation: the
subagent handoff, and the reply Answer wrote *about* that handoff.
`projectAcceptedRunResults()` lifts the current run's handoff into
`<accepted_results>` and drops it from history, but prior runs kept both copies —
so Answer saw its own restatements and learned to restate again. Measured on one
session: 68% / 71% / 100% similarity across three pairs, with history at 5269
chars against 539 chars of accepted results.

The Planner action `answer_directly` was the only route into Answer that needed
history — its contract was "answerable from the canonical main conversation".
Since #663 `entryAnswer` owns conversational replies and never routes such
requests to the Planner, so the action was already unreachable in production and
was removed. That is what makes "Answer is a closer, its input is
`<answer_input>`" an invariant rather than a convention.

Consequence worth knowing: the compaction summary no longer reaches Answer.
Re-showing an older result is a conversational request that `entryAnswer` owns,
and the summary survives in canonical history for it.

## One request string, three roles

`buildRunUserRequestContext()` renders one identical block for three consumers,
but its role differs:

- **capabilityPlanner** — input body; what the planner plans against.
- **capability** — background only. The real execution boundary is `<task>`
  inside `<delegation_briefing>`.
- **answer** — the target the reply must close against.

`withRunUserRequestContext()` inserts the request via
`insertBeforeLatestDelegationBriefing()`, keeping the briefing last, because the
governing prompt tells the subagent that the *latest* briefing defines its task.

> Known wording gap: the rendered block hardcodes `role="task_boundary"` for all
> three consumers. In the capability lane that attribute overstates its
> authority; the insertion position already encodes the intended layering. Do
> not resolve this by reordering messages.

## Run goal lifecycle

Three writers, no drift:

1. `captureRunUserRequest` seeds a **provisional** value (last human message) so
   the state invariant holds. Not authoritative.
2. `plan_request(goal)`, committed by `capabilityPlanner` on the entry path — the
   **only** authoritative write.
3. `activeDelegationTransition` on resume replays
   `activeDelegation.userRequest`, a **snapshot**, never a re-capture.

Because writer 3 replays a snapshot, the goal is fixed for the life of a
delegation. At resume, `readLatestHumanRequest()` becomes `<guidance>` in the
briefing and does not overwrite the goal. The only legitimate replacement is
`supersede_active`, which runs a full fresh entry.

The goal is model-authored because the last human message is often a
continuation utterance ("嗯。开始吧") that states no goal; only `entryAnswer`
sees enough conversation to resolve what it refers back to. Verbatim text is
preserved when the resolved goal equals the current message.

## One compaction bounds everything

- **Trigger** — token watermark against the real context window
  (`contextWindowTokens` / `generationReserveTokens`), measured on
  `mainConversationMessages()`.
- **Sweep** — `RemoveMessage({ id: REMOVE_ALL_MESSAGES })`, then rebuild from
  `selectMessagesToKeep()` over the **full** message array.

The trigger is measured on main messages; the sweep covers every lane, including
the Planner lane. No lane carries its own budget. Per-lane Planner compaction was
removed in PR #664: nested self-summarizing summaries grew the lane faster than
they shrank it.

The compaction summary is an `AIMessage` carrying `source="compaction"` and
`authority="none"` — not a `SystemMessage`.

## Superseded by this page

- **Goal Creation / `runUserGoal`** — the node and the state field no longer
  exist. Goal authorship moved into `entryAnswer` via `plan_request(goal)`.
- **Planner private child checkpoint** — the Planner transcript is persisted in
  root `messages` under the `orchestrator` lane.
- **Planner lane compaction** — removed; see above.
- **Answer "legacy system-prose renderer"** — production Answer uses
  `appendAnswerInputMessage()` with the typed `<answer_input>` fact block.
- **Answer reading canonical history** — Answer receives no history at all; see
  above. `answer_directly` no longer exists as a Planner action.

## Dead surface

Two shared helpers are currently unreferenced. Treat them as unverified; if you
start using them, check the rendered prompt rather than assuming intent holds.

- `ORCHESTRATOR_DECISION_SHARED_PREFIX` — exported, no prompt renders it.
- `buildDecisionConfig`'s `workdir` / `runtimeEnvironment` parameters — no call
  site passes them. `workdir` reaches the model through the capability's
  `promptSections` via `buildSubagentExecutionContext()`.
