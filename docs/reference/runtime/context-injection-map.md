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
| `RUN-STABLE` | Fixed once per run, then replayed identically | New run |
| `DYNAMIC` | Recomputed from state on every single invocation | Every invocation |

**Axis 2 — Authority** (may the model treat it as an instruction?)

| Class | Meaning |
|---|---|
| `INSTRUCTION` | The model must obey it. System prompts only. |
| `BOUNDARY` | Defines what "done" means for this step. |
| `FACT` | Read-only data. Explicitly *not* an instruction. Carries `authority="none"`. |
| `HISTORY` | Canonical conversation or private delegation messages. |

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
                                                       └─> answer (current finalizer)
      capability ─────> plannerBoundaryIterationGuard ─> capabilityPlanner
```

Model-invoking nodes: **entryAnswer**, **capabilityPlanner**, **capability**
(subagent), **answer**, plus **compactContext** (summarizer).
`prepare`, `captureUserRequest` and the guards invoke no model.

`answer` is the current implementation name, not a permanent domain role. The
target finalization boundary and deterministic-response split are documented in
[`terminal-response.md`](../../design/agent-runtime/terminal-response.md).

## 3. Shared building blocks

These are assembled by several nodes. Defined in
`agent/orchestrator/prompts/shared.ts` and `prompts/context.ts`.

| Block | Class | Built by | Notes |
|---|---|---|---|
| `[配置]` | `RUN-STABLE` / `INSTRUCTION` | `buildDecisionConfig(actor)` | Only `entryAnswer` and `answer` use it. It accepts `workdir`/`runtimeEnvironment`, but **no call site passes them** — both are currently dead parameters. |
| `<run_user_request>` | `RUN-STABLE` / `BOUNDARY`* | `buildRunUserRequestContext(userRequest)` | Planner and finalizer use the shared top-level block. Capability embeds the same state value as goal context inside its briefing; see §8. |
| `<delegation_briefing>` | `RUN-STABLE` / `BOUNDARY` | `materializeDelegation()` | Capability-only projection: nested `<run_user_request>` + `<task>` + optional `<essential_context>` (initial) or `<guidance>` (continue). |
| `<context_summary>` | `DYNAMIC` / `HISTORY` | `createContextCompactionMessage()` | Replaces swept history. Carries `source="compaction"`, `authority="none"`. |

`xmlTextBlock()` wraps payloads in `CDATA` and escapes nested `]]>`. Always use
it for free text — never interpolate user or tool text into a tag directly.

> `buildDecisionConfig`'s `workdir`/`runtimeEnvironment` parameters are currently
> dead. Treat them as unverified surface — if you start using them, check the
> rendered prompt rather than assuming the intended behavior still holds.

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

`mainConversationMessages()` excludes every lane-tagged message. Briefings are
current Capability inputs and never enter canonical state. An accepted
typed Announce reaches this view after handoff moves its semantic identity into
the main queue. Entry Answer converts the selected main history to its ephemeral
model-visible view, then prepends its independently owned system message.

**Output → state:** `plan_request(goal)` resolves the run goal against the whole
conversation. This is the only place a goal is authored. See §8.

## 5. Node: capabilityPlanner

Two modes use the same steering domain. The target lifetime and ownership
contract is defined by
[`run-scoped-planner-session.md`](../../design/agent-runtime/run-scoped-planner-session.md).
Sources:
`runtime/nodes/capabilityPlanner.ts` (dispatch),
`capabilityPlanner/agent.ts` (assembly),
`orchestrator/modelMessageView.ts` (ephemeral model-visible view).

| Slot | Lifetime | Entry mode | Boundary mode |
|---|---|---|---|
| system | invocation projection / `INSTRUCTION` | entry objective and context meaning | boundary objective and context meaning |
| clean conversation | projected per invocation / `HISTORY` | canonical main conversation | current canonical main conversation |
| session state | `RUN-STABLE` / `FACT` | goal, plan and Capability disclosure | updated plan and disclosure from this run |
| current input | `DYNAMIC` / `BOUNDARY` | entry data | ordered active-delegation announces with one latest target, active delegation and prior remaining-plan proposal |
| tools | invocation projection / `INSTRUCTION` | `capability_search`, `submit_plan`, `request_user_input`, `report_unavailable` | `capability_search`, `continue_current`, `advance_plan`, `complete_goal`, `request_user_input`, `report_unavailable` |

Entry initializes a clean run-scoped Planner session. Boundary queries the exact
active delegation, extracts every typed Announce in chronological order, and
places that evidence in the current `CapabilityPlannerInput`; exactly the latest
message id is the evaluation target. This projection never changes the Announces
or root messages. Private Capability Human/AI/Tool messages are never included.
The prior remaining plan is marked as a non-authoritative proposal that the
Boundary must revalidate against current evidence.

Capability disclosure is run-scoped semantic state. It contains every
Capability whose complete document was disclosed during this run in stable
order; the configured default is candidate policy rather than an initial
disclosure. A compact routing manifest initialized from the effective registry
is projected into each Planner invocation, while complete Capability documents
remain progressively disclosed. Neither dynamic registry facts nor search-round
state enter the stable system prompt. A new run resets search attempts and
revalidates disclosure; resumed root tasks may seed the capabilities named by
their active and remaining plan.

`capability_search` remains callable with `tool_choice=auto`. Each ToolMessage
reports the post-call disclosure state, remaining empty rounds, and a planning
objective. After discovery closes, later calls return the stable
`capability_search_round_limit_exceeded` result instead of changing tool
availability.

Planner provider messages, search ToolMessages, and terminal ToolMessages do not
belong in root `messages`. Same-input recovery uses a typed run-scoped commit;
raw invocation detail belongs to tracing. No Planner provider lane is persisted
in the root conversation checkpoint.

Run `npm run planner:context-audit` to inspect the complete static provider
contract for both modes. It renders the production system/input builders,
projected history, tool descriptions, and argument schemas together.

## 6. Node: capability (subagent execution)

Executes one delegated task. Source: `runtime/nodes/capability.ts`.

| Slot | Class | Content |
|---|---|---|
| system | `RUN-STABLE` / `INSTRUCTION` | `SUBAGENT_GOVERNING_PROMPT` (static) + `promptSections`: toolkit instructions, capability instructions, and `buildSubagentExecutionContext({ workdir, artifactDiscovery })` |
| history | `DYNAMIC` / `HISTORY` | `queryAgentMessages(messages).main().delegation(scope).select()` — canonical main conversation plus this delegation's private messages |
| boundary | `RUN-STABLE` / `BOUNDARY` | One ephemeral `<delegation_briefing>` containing goal context and current task; always last |

The query returns unlaned main-conversation messages **plus** only this
delegation's own private messages. A different delegation in the same lane gets
a fresh `delegationId` and starts clean: conclusions cross task boundaries
through handoffs and summaries; private messages do not.

The Human-role briefing is assembled immediately before the Capability call and is not
written to checkpoint history. `runUserRequest` and delegation lifecycle state
remain separate canonical fields; model projection merges them without creating
a second protocol message. Artifact-discovery availability, when enabled, is
described by Capability prompt sections and bound tools rather than a synthetic
history message.

Initial projection:

```xml
<delegation_briefing role="task_boundary" source="orchestrator" mode="initial">
  <run_user_request role="goal_context" source="orchestrator_state" trust="read_only">
    <request><![CDATA[用户的整体目标与约束]]></request>
  </run_user_request>
  <task><![CDATA[当前 Capability 的执行边界]]></task>
  <essential_context><![CDATA[首次执行所需的补充背景]]></essential_context>
</delegation_briefing>
```

Continuation uses the same shape with `mode="continue"` and optional
`<guidance>` in place of `<essential_context>`.

## 7. Current node: answer

The current terminal finalizer is implemented by `runtime/nodes/answer.ts` and
`prompts/answer.ts`. It performs three jobs: terminal fact projection, reply
generation, and run cleanup. The target design separates those jobs but keeps
one finalization boundary.

For its model-backed paths, the current node receives no conversation history.
Its invocation contains exactly:

| Slot | Class | Content |
|---|---|---|
| system | `RUN-STABLE` / `INSTRUCTION` | `buildAnswerSystemPrompt({ actor })` |
| input | `DYNAMIC` / `FACT` | `<answer_input>` — the complete projected facts |

`<answer_input>` contains `<run_user_request>` and `<answer_context>`, including
the current reply mode, ordered accepted results, blocked reason, or
awaiting-input context. `projectAcceptedRunResults()` selects typed Announces by
completed delegation identity; it does not make canonical history model-visible.

Current routes include `goal_done`, `user_input_required`, blocked states, and
the explicit `planner_incomplete` protocol failure. Checkpoint incompatibility
also uses a deterministic message. Planner ordinary text is invocation-private
and cannot become a terminal root reply.

Historical replay is not a terminal-finalization responsibility. A later request
to re-show a result is an ordinary conversational request handled by Entry
Answer from canonical main history and any compaction summary.

## 8. `runUserRequest`: one state value, three projections

The same canonical string reaches three nodes, but each consumer owns its model
projection:

| Consumer | Role in practice |
|---|---|
| capabilityPlanner | **Input body.** This is what the planner plans against. |
| capability | **Nested background.** `<run_user_request role="goal_context">` lives inside the briefing; `<task>` is the real boundary (§6). |
| current finalizer | **Target.** What the reply must close against. |

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

The trigger is measured on main messages. The sweep covers root message lanes,
but pins every still-unaccepted lane Announce intact because lane content is
excluded from the generated summary and Boundary must retain all attempts.
The run-scoped Planner session is not a root message lane and therefore does not
participate in root conversation compaction. If Planner session history later
requires compaction, it must compact the whole run-private history rather than
clip individual Delegation Announces.

## 10. Checklist for adding context

1. Which node? Only nodes in §4–§7 invoke models.
2. Static, run-stable, or dynamic (§1)? Static belongs in a template constant,
   not in a per-invocation builder.
3. Instruction, boundary, fact, or history? Anything not an instruction needs
   `authority="none"` / `role="fact"`.
4. Wrap free text in `xmlTextBlock()`.
5. Does ordering matter? Capability invocation context must keep the ephemeral briefing last.
6. Will it survive compaction? Anything the model must not lose belongs in
   run-stable state, not only in a message.
