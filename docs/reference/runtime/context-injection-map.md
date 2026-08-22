# Context Injection Map

> Scope: every model-invoking node in the orchestrator graph, and exactly what
> enters its context window.
> Audience: written to be read by an LLM working on this repo. Each node section
> is self-contained — you can read one section without reading the others.

Read this before changing what a node sends to its model. Prompt text lives in
`prompts/templates/`; this document is about **assembly**: which pieces exist,
which are stable across a run, and which are rebuilt per invocation.

## 1. The two axes

Everything below is classified on two independent axes. Do not conflate them.

**Axis 1 — Static vs Dynamic** (does it change between invocations?)

| Class | Meaning | Rebuilt when |
|---|---|---|
| `STATIC` | Same string for every invocation of this node, for the whole process | Never (module constant) |
| `RUN-STABLE` | Fixed once per run/trace, then replayed identically | New run, or a superseding request |
| `DYNAMIC` | Recomputed from state on every single invocation | Every invocation |

**Axis 2 — Authority** (may the model treat it as an instruction?)

| Class | Meaning |
|---|---|
| `INSTRUCTION` | The model must obey it. System prompts only. |
| `BOUNDARY` | Defines what "done" means for this step. |
| `FACT` | Read-only data. Explicitly *not* an instruction. Carries `authority="none"`. |
| `HISTORY` | Canonical conversation/transcript messages. |

The repo encodes Axis 2 in the XML itself — blocks carry `role=`, `source=` and
`trust=`/`authority=` attributes. When adding a block, set these; they are the
only thing preventing a data block from being read as a new user instruction.

## 2. Graph shape

```
START
  └─> prepare ──────────────> compactContext ──┬─> captureUserRequest ─> entryAnswer
                                               ├─> plannerBoundaryIterationGuard
                                               └─> capability
      entryAnswer ─(plan_request)─> capabilityPlanner ─┬─> capability
                                                       └─> answer
      capability ─────> plannerBoundaryIterationGuard ─> capabilityPlanner
```

Model-invoking nodes: **entryAnswer**, **capabilityPlanner**, **capability**
(subagent), **answer**, plus **compactContext** (summarizer).
`prepare`, `captureUserRequest` and the guards invoke no model.

## 3. Shared building blocks

These are assembled by several nodes. Defined in
`agent/orchestrator/prompts/shared.ts` and `prompts/context.ts`.

| Block | Class | Built by | Notes |
|---|---|---|---|
| `ORCHESTRATOR_DECISION_SHARED_PREFIX` | `STATIC` / `INSTRUCTION` | `buildOrchestratorDecisionPromptPrefix()` | ⚠️ Currently **unreferenced** — exported but no prompt renders it. Each node's system prompt is self-contained today. |
| `[配置]` | `RUN-STABLE` / `INSTRUCTION` | `buildDecisionConfig(actor)` | Only `entryAnswer` and `answer` use it. It accepts `workdir`/`runtimeEnvironment`, but **no call site passes them** — both are currently dead parameters. |
| `<run_user_request>` | `RUN-STABLE` / `BOUNDARY`* | `buildRunUserRequestContext(userRequest)` | *See §8 — its authority differs by consumer even though the string is identical. |
| `<delegation_briefing>` | `RUN-STABLE` / `BOUNDARY` | `materializeDelegation()` | `<task>` + optional `<essential_context>` (initial) or `<guidance>` (continue). |
| `<context_summary>` | `DYNAMIC` / `HISTORY` | `createContextCompactionMessage()` | Replaces swept history. Carries `source="compaction"`, `authority="none"`. |

`xmlTextBlock()` wraps payloads in `CDATA` and escapes nested `]]>`. Always use
it for free text — never interpolate user or tool text into a tag directly.

> Two shared helpers are currently dead: the prefix above, and
> `buildDecisionConfig`'s `workdir`/`runtimeEnvironment` parameters. Treat them
> as unverified surface — if you start using them, check the rendered prompt
> rather than assuming the intended behavior still holds.

## 4. Node: entryAnswer

Routes the request: reply directly, ask a question, or hand off via
`plan_request`. Source: `runtime/nodes/entryAnswer.ts`.

| Slot | Class | Content |
|---|---|---|
| system | `RUN-STABLE` / `INSTRUCTION` | `buildEntryAnswerSystemPrompt({ actor })` — `[配置]` + routing rules |
| history | `DYNAMIC` / `HISTORY` | `mainConversationMessages(state.messages)` |

**This node receives no XML fact blocks.** It is the only model node that sees
the main conversation and nothing else — deliberately, because it is the node
that decides what the goal *is*.

`mainConversationMessages()` excludes every laned message (delegation lanes and
the `orchestrator` planner lane) and pre-lane delegation briefings. A handoff
copy reaches this view because handoff writes it into the main queue.

**Output → state:** `plan_request(goal)` resolves the run goal against the whole
conversation. This is the only place a goal is authored. See §8.

## 5. Node: capabilityPlanner

Two modes, same node, different context. Sources:
`runtime/nodes/capabilityPlanner.ts` (dispatch),
`capabilityPlanner/agent.ts` (assembly),
`capabilityPlanner/messageContext.ts` (projection).

| Slot | Class | Entry mode | Boundary mode |
|---|---|---|---|
| system | `RUN-STABLE` / `INSTRUCTION` | entry prompt + `<default_capability>` + `<capability_search_state />` | boundary prompt + `<default_capability>` + `<capability_search_state />` |
| history | `DYNAMIC` / `HISTORY` | planner lane + main conversation up to current request | planner lane + main conversation + **the active delegation lane** |
| input | `DYNAMIC` / `FACT` | `<run_user_request>` | same + `继续规划所需事实：<planning_state>` |

Both modes are projected by `selectCapabilityPlannerMessages()`, filtered by
`traceId` **and** `registryDigest` — a registry change invalidates stale
document observations.

`<default_capability>` rides the system message because it is a property of the
immutable workspace, not of this turn: it is identical for every call against the
same registry. Rendering it beside `<run_user_request>` mixed a run-stable fact
into the one block that changes every turn.

`<capability_search_state />` is regenerated for each Planner model call. It is a
data-only control snapshot; the system prompt owns the rules for interpreting its
open or closed status.

The planner's own transcript (its inputs, `capability_search` observations and
terminal commits) is persisted in root `messages` under the `orchestrator` lane,
tagged `source: 'capability_planner'`. It is invisible to every other node.
There is no planner-lane compaction; the lane is bounded by the same global
watermark as everything else (§9).

**Boundary mode is the only place a full delegation transcript is projected into
a decision node.** That is what lets the planner judge whether a task is done.

## 6. Node: capability (subagent execution)

Executes one delegated task. Source: `runtime/nodes/capability.ts`.

| Slot | Class | Content |
|---|---|---|
| system | `RUN-STABLE` / `INSTRUCTION` | `SUBAGENT_GOVERNING_PROMPT` (static) + `promptSections`: toolkit instructions, capability instructions, and `buildSubagentExecutionContext({ workdir, artifactDiscovery })` |
| history | `DYNAMIC` / `HISTORY` | `laneMessages(messages, lane, transcriptRunId, delegationId)` |
| injected | `RUN-STABLE` / `FACT` | `<run_user_request>` via `withRunUserRequestContext()` |
| boundary | `RUN-STABLE` / `BOUNDARY` | `<delegation_briefing>` — last message in the lane |

`laneMessages()` returns unlaned main-conversation messages **plus** only this
delegation's own lane messages. A different delegation in the same lane gets a
fresh `delegationId` and starts clean: conclusions cross task boundaries through
handoffs and summaries, transcripts do not.

**Ordering is load-bearing.** `withRunUserRequestContext()` inserts the request
via `insertBeforeLatestDelegationBriefing()`, so the briefing stays last. The
governing prompt tells the subagent that the *latest* `<delegation_briefing>`
defines its task. The run request sits earlier as background.

> Known wording gap: `buildRunUserRequestContext()` hardcodes
> `role="task_boundary"` for all three consumers, but here the real boundary is
> `<task>` in the briefing. The insertion position already encodes the intended
> layering; the attribute string has not caught up. Do not "fix" this by
> reordering the messages.

## 7. Node: answer

Produces the user-facing reply. Source: `runtime/nodes/answer.ts`,
`prompts/answer.ts`.

**Answer receives no conversation history.** Its entire invocation is two
messages:

| Slot | Class | Content |
|---|---|---|
| system | `RUN-STABLE` / `INSTRUCTION` | `buildAnswerSystemPrompt({ actor })` |
| input | `DYNAMIC` / `FACT` | `<answer_input>` — the whole context |

`<answer_input>` carries `role="fact" source="orchestrator_state"
authority="none"` and contains `<run_user_request>` plus `<answer_context>`
(reply mode, accepted results, blocked reason, awaiting-input context).

Answer is a **closer**: it runs only after a decision, in `goal_done`,
`blocked` or `user_input_required` mode, and all three are fully served by that
block. History was never load-bearing for the reply — only for imitation.

Why it was removed: every completed turn left a near-duplicate pair in the main
conversation — the subagent handoff, and the reply Answer wrote *about* that
handoff. `projectAcceptedRunResults()` lifts the current run's handoff into
`<accepted_results>` and drops it from history, but prior runs kept both copies,
so Answer saw its own restatements and restated again. Measured on one session:
68% / 71% / 100% similarity across three pairs, history at 5269 chars against
539 chars of accepted results.

Two consequences worth knowing:

- The compaction summary does not reach Answer. Re-showing an older result is a
  conversational request that `entryAnswer` owns, and the summary survives in
  canonical history for it.
- `direct` mode still exists in `selectAnswerContextFacts()` as a fallback, but
  no route produces it — see §7a.

### 7a. Why `answer_directly` is gone

The Planner terminal action `answer_directly` was defined as "the current goal
can be answered from the canonical main conversation", making it the only route
into Answer that needed history. Since #663, `entryAnswer` owns conversational
replies and never hands such requests to the Planner, so the action was already
unreachable in production. It was removed rather than kept as a dead branch,
which is what turns "Answer is a closer, its input is `<answer_input>`" into an
invariant rather than a convention.

## 8. `<run_user_request>`: one string, three consumers

The same rendered block reaches three nodes, but its role differs:

| Consumer | Role in practice |
|---|---|
| capabilityPlanner | **Input body.** This is what the planner plans against. |
| capability | **Background.** The real boundary is `<task>` (§6). |
| answer | **Target.** What the reply must close against. |

**Lifecycle (3 writers, no drift):**

1. `captureRunUserRequest` — seeds a *provisional* value (last human message) so
   the state invariant holds. Not authoritative.
2. `plan_request(goal)` → committed by `capabilityPlanner` on the entry path —
   the **only** authoritative write.
3. `activeDelegationTransition` on resume — replays
   `activeDelegation.userRequest`, a **snapshot**, never a re-capture.

Because writer 3 replays a snapshot, the goal is fixed for the life of a
delegation. `readLatestHumanRequest()` at resume becomes `<guidance>` in the
briefing and does **not** overwrite the goal. The only legitimate replacement is
`supersede_active` — a genuinely new request, which runs a full fresh entry.

Why the goal is model-authored: the last human message is often a continuation
utterance ("嗯。开始吧") that states no goal. Only entryAnswer sees enough
conversation to resolve what it refers back to. Verbatim text is still preserved
when the resolved goal equals the current message, so formatting-sensitive
requests are unaffected.

## 9. Compaction

One mechanism bounds all context. Source: `contextCompaction.ts`,
`guardDefinitions/contextCompactionWatermarkGuard.ts`.

- **Trigger** — a token watermark against the real context window
  (`contextWindowTokens` / `generationReserveTokens`), measured on
  `mainConversationMessages()`.
- **Sweep** — `RemoveMessage({ id: REMOVE_ALL_MESSAGES })` then rebuild from
  `selectMessagesToKeep(messages, keepMessages)` (default 10), which operates on
  the **full** message array and re-runs `toolProtocolSafeMessages()` so no
  orphaned tool call survives.

The trigger is measured on main messages; the sweep covers **every lane**,
including the planner lane. No lane carries its own budget. A per-lane
compaction was removed deliberately — nested self-summarizing summaries made the
lane grow faster than they shrank it.

## 10. Checklist for adding context

1. Which node? Only nodes in §4–§7 invoke models.
2. Static, run-stable, or dynamic (§1)? Static belongs in a template constant,
   not in a per-invocation builder.
3. Instruction, boundary, fact, or history? Anything not an instruction needs
   `authority="none"` / `role="fact"`.
4. Wrap free text in `xmlTextBlock()`.
5. Does ordering matter? If it lands in a capability lane, keep the briefing last.
6. Will it survive compaction? Anything the model must not lose belongs in
   run-stable state, not only in a message.
