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
| `RUN-STABLE` | Held stable once prepared for this run; execution progress is projected separately | New run; plan changes require user confirmation |
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

### Canonical message ownership

`OrchestratorState.messages` is the only canonical message collection. An
untagged message belongs to the main conversation; a private Capability message
has one complete `{ lane, runId, delegationId }` scope. The immutable
`queryAgentMessages()` selection preserves canonical chronology and may append
invocation-only input without persisting it.

A fresh delegation never inherits another delegation's private history.
Continuing the exact delegation reuses its scope. Capability briefings and
Supervisor provider messages are invocation-private and never enter root
messages. Current handoff moves typed Announces into main and clears private
messages for that scope. In the target, root publishes Announces into main before
acceptance; acceptance updates task metadata and closes private execution scope,
without publishing the result again. Section 5 distinguishes these input paths.

## 2. Graph shape

```
START
  └─> prepare ──────────────> compactContext ──┬─> captureUserRequest ─> entryAnswer
                                               ├─> supervisorBoundaryIterationGuard
                                               └─> capability
      entryAnswer ─(plan_request)─> runSupervisor ─┬─> capability
                                                       └─> answer (current finalizer)
      capability ─────> supervisorBoundaryIterationGuard ─> runSupervisor
```

Model-invoking nodes: **entryAnswer**, **runSupervisor**, **capability**
(subagent), plus **compactContext** (summarizer).
`prepare`, `captureUserRequest` and the guards invoke no model.

`answer` is the current deterministic output node, not a permanent domain role.
A unified Finalizer node is planned after Supervisor optimization; its design is
deferred and this reference does not prescribe its future model usage.

## 3. Shared building blocks

These are assembled by several nodes. Defined in
`agent/orchestrator/prompts/shared.ts` and `prompts/context.ts`.

| Block | Class | Built by | Notes |
|---|---|---|---|
| `[配置]` | `RUN-STABLE` / `INSTRUCTION` | `buildDecisionConfig(actor)` | Used by `entryAnswer`; its builder currently lives in `prompts/answer.ts`. It accepts `workdir`/`runtimeEnvironment`, but **no call site passes them** — both are currently dead parameters. |
| `<run_user_request>` | `RUN-STABLE` / `BOUNDARY`* | `buildRunUserRequestContext(userRequest)` | Supervisor uses the shared top-level block. Capability embeds the same state value as goal context inside its briefing; see §8. |
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
the main queue. Entry Answer selects this history with the shared message query;
the model-invocation runtime renders typed messages without changing state.

**Output → state:** `plan_request(goal)` resolves the run goal against the whole
conversation. This is the only place a goal is authored. See §8.

## 5. Node: runSupervisor

Two modes use the same steering domain. The target lifetime and ownership
contract is defined by
[`run-scoped-supervisor-session.md`](../../design/agent-runtime/run-scoped-supervisor-session.md).
Capability exit, Boundary entry, and the target command convergence are defined
by the
[`delegation-boundary-protocol.md`](../../design/agent-runtime/delegation-boundary-protocol.md)
draft for issue #755. The implementation uses the single-proposal surface below.
The lifetime and tool-scope table includes the 2026-09-06 target clarification:
the committed plan and prepared disclosure stay stable during execution, and
conversation plus execution evidence arrive only through main messages.
Boundary plan rewrites, discovery, and separate private result extraction still
exist in current code; the target changes below are pending implementation.
Sources:
`runtime/nodes/runSupervisor.ts` (dispatch),
`runSupervisor/agent.ts` (assembly),
`orchestrator/modelInvocation.ts` (internal model-call wiring).

| Slot | Lifetime | Entry mode | Boundary mode |
|---|---|---|---|
| system | invocation projection / `INSTRUCTION` | entry objective and context meaning | boundary objective and context meaning |
| clean conversation | projected per invocation / `HISTORY` | canonical main conversation with typed result facts | current canonical main conversation including unaccepted Announces |
| session state | `RUN-STABLE` / `FACT` | goal, committed plan and prepared Capability disclosure; initialization may discover before plan commit | same execution agreement and prepared disclosure |
| current input | `DYNAMIC` / `BOUNDARY` | entry data, including remaining work on resume | active delegation association and remaining tasks from the established plan; result bodies are already in main |
| tools | invocation projection / `INSTRUCTION` | `capability_search`, `submit_plan` | execution: `continue_current`, `submit_plan`, `accept_result`; new-run user input may require discovery before execution resumes |

Entry initializes a clean run-scoped Supervisor session. In the target, root
publishes normal Capability results directly into main before Boundary, including
partial results. Supervisor associates attempts using existing Announce identities
and chronology, without reading the private delegation scope or receiving another
result body. Current code still builds `announceAttempts` and `latestAnnounce`
through that private query; remove this separate result projection. Projection
never changes canonical messages. Private Capability Human/AI/Tool messages remain
excluded, and publication must not be interpreted as task acceptance.
The remaining tail expresses task progress within the established plan. Boundary
checks execution results against the goal and current task; it asks the user
before changing task content, scope, or order. Task progress does not violate
`RUN-STABLE`. Plan prose is data, not an instruction override or evidence of
completion. Current input builders still label the tail as a proposal requiring
revalidation; that wording must converge on this restricted meaning.

The target `continue_current({ feedback?, remainingPlan? })` can apply a
user-confirmed future-plan change while retaining and continuing the active
delegation. Omission retains the existing tail; an array replaces only future
tasks, and a confirmed empty array clears those tasks without ending the current
one. Root commits both effects together. Current code supports feedback only;
this optional argument and its validation remain to be implemented.

In the current implementation, Capability disclosure is run-scoped semantic state. It contains every
Capability whose complete document was disclosed during this run in stable
order; the configured default is candidate policy rather than an initial
disclosure. A compact routing manifest initialized from the effective registry
is projected into each Supervisor invocation. It retains the Toolkit names and
descriptions resolved from each Capability's compiled `uses`, while complete
Capability documents remain progressively disclosed. Neither dynamic registry
facts nor search-round state enter the stable system prompt. A new run resets
search attempts and revalidates disclosure; resumed root tasks may seed the
capabilities named by their active and remaining plan.

Currently `capability_search` remains callable in both modes with `tool_choice=auto`. Each ToolMessage
reports the post-call disclosure state, remaining empty rounds, and a planning
objective. After discovery closes, later calls return the stable
`capability_search_round_limit_exceeded` result instead of changing tool
availability.

The target prepares disclosure before execution and reuses it during execution
Boundaries. Needing a different scope leads to a direct question. The user's
answer enters main with the active delegation retained, and Supervisor can
prepare documents needed for the explicit adjustment on the new run's first
decision, including in Boundary mode. It then resumes execution with stable
disclosure. No separate replanning stage, disclosure registry, or fallback is
needed; receiving input alone does not end or replace the delegation.

Supervisor provider messages, search ToolMessages, and terminal ToolMessages do not
belong in root `messages`. Only the final reply reaches main through the terminal
node. Committed transitions are recovered from graph checkpoints; raw invocation
detail belongs to tracing. No Supervisor provider lane is persisted
in the root conversation checkpoint.

Run `npm run supervisor:context-audit` to inspect the complete static provider
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

The terminal node `runtime/nodes/answer.ts` emits `runSupervisorReply` exactly
once and clears run-scoped state. It does not invoke a model. Root iteration
limits and incompatible checkpoints have deterministic notices. An empty reply
without a runtime stop is a protocol error, not a request for a fallback answer.

Natural Supervisor replies retain the active delegation and remaining plan.
`accept_result({ reply, remainingPlan })` accepts the active task before terminal
cleanup and saves any remaining plan without dispatching it. The existing
continuation snapshot also supports a remaining plan with no active delegation;
explicit resume then starts a fresh Entry session.

Supervisor itself supplies questions as well as answers. A question retains
unfinished work and exposes the existing continuation entry so the user's answer
returns to the same goal; it does not require an `interrupted` event. The answer
enters the next root main projection. Changing the plan requires user agreement,
not merely a new invocation. UI continuation integration is still pending.

Before any plan or delegation exists, a question has no execution snapshot to
resume: the answer follows ordinary `entryAnswer`, which resolves the goal from
main. With an active delegation, explicit user input reaches Supervisor before
further execution while retaining the delegation and existing messages. It need
not wait for another Announce, but acceptance still requires result evidence.

Historical replay is not a terminal-finalization responsibility. A later request
to re-show a result is an ordinary conversational request handled by Entry
Answer from canonical main history and any compaction summary.

## 8. `runUserRequest`: one state value, three projections

The same canonical string reaches three nodes with these responsibilities:

| Consumer | Role in practice |
|---|---|
| runSupervisor | **Input body.** This is what the Supervisor steers against. |
| capability | **Nested background.** `<run_user_request role="goal_context">` lives inside the briefing; `<task>` is the real boundary (§6). |
| current terminal node | **Continuation.** Retained with unfinished work; no model projection. |

**Lifecycle (3 writers, no drift):**

1. `captureRunUserRequest` — seeds a *provisional* value (last human message) so
   the state invariant holds. Not authoritative.
2. `plan_request(goal)` → committed by `runSupervisor` on the entry path —
   the **only** authoritative write.
3. `activeDelegationTransition` on resume — replays
   `activeDelegation.userRequest`, a **snapshot**, never a re-capture.

Because writer 3 replays a snapshot, the goal is fixed for the life of a
delegation. `readLatestHumanRequest()` at resume becomes `<guidance>` in the
briefing and does **not** overwrite the goal. The only legitimate replacement is
`supersede_active` — a genuinely new request, which runs a full fresh entry.
Supplementing the current task or confirming a plan adjustment does not use that
transition: append the user's message to main and let Supervisor consider it with
the existing task still active. A new user input is not an automatic goal rewrite.

Why the goal is model-authored: the last human message is often a continuation
utterance ("嗯。开始吧") that states no goal. Only entryAnswer sees enough
conversation to resolve what it refers back to. Verbatim text is still preserved
when the resolved goal equals the current message, so formatting-sensitive
requests are unaffected.

## 9. Compaction

Root history maintenance is owned by `contextCompaction.ts`,
`guardDefinitions/contextCompactionWatermarkGuard.ts`, and the run-entry graph.

- **Trigger** — a token watermark against the real context window
  (`contextWindowTokens` / `generationReserveTokens`), measured on
  `mainConversationMessages()`. The threshold is 75% of input capacity after
  generation reserves, leaving roughly 25% as headroom for new context.
- **Timing** — `prepare → compactContext` runs at new root-run entry. Execution
  loops do not return to compaction. This is already the graph structure.
- **Sweep** — `RemoveMessage({ id: REMOVE_ALL_MESSAGES })` then rebuild from
  `selectMessagesToKeep(messages, keepMessages)` (default 10), which operates on
  the **full** message array and re-runs `toolProtocolSafeMessages()` so no
  orphaned tool call survives.

Currently the sweep covers root message lanes and pins active private-lane
Announces intact because those results are excluded from the generated summary.
In the target, Announces live in main before acceptance. Keep the entry-only
schedule and the two existing retention rules: retain recent messages and every
original Announce for the current unfinished delegation, including attempts
outside the recent suffix. Match the latter by existing Announce identity metadata
and active-task state instead of private lane tags. This requires no additional
pinning state and allows other old history to compact normally on continuation.

Within the run, retain complete result messages and prior attempts. Do not add
per-Announce clipping or mid-run root compaction. The 25% headroom and retention
rules work together: more aggressive compaction of older history must still keep
current unfinished-delegation evidence intact. No whole-step deferral or duplicate
result storage is needed. Raw Supervisor invocation history stays private and
ephemeral; Capability's private context maintenance remains subagent-owned.

## 10. Checklist for adding context

1. Which node? Entry Answer, Supervisor, Capability, and the compaction summarizer
   invoke models; the current terminal answer node does not.
2. Static, run-stable, or dynamic (§1)? Static belongs in a template constant,
   not in a per-invocation builder.
3. Instruction, boundary, fact, or history? Anything not an instruction needs
   `authority="none"` / `role="fact"`.
4. Wrap free text in `xmlTextBlock()`.
5. Does ordering matter? Capability invocation context must keep the ephemeral briefing last.
6. Will it survive compaction? Keep goal and plan in run-stable state. Result
   evidence stays in main messages intact during execution; compaction retains
   all Announces for the current unfinished delegation by existing identity,
   independently of the recent-message suffix.
