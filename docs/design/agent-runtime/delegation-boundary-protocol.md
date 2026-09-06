# Supervisor–Root Interaction Protocol

Status: working design for issue #755, fully rewritten around the direction discussed on 2026-09-06. This document describes the target design; implementation status is recorded at the end.

[中文版本](delegation-boundary-protocol.zh-CN.md). Both versions describe the same design. Existing file paths are retained to preserve links.

## Problem to solve

Supervisor is the decision-maker within root's orchestration loop. Entry establishes a plan for the goal. Subsequent invocations read conversation and execution evidence only from root's current main messages, judge alignment with the established goal and current task, and decide whether to accept and advance or request improvement. Normal Capability subagent results enter main as existing Announce messages before acceptance. Root applies decisions and records new facts. New evidence does not authorize Supervisor to change the goal or rewrite the plan; it asks the user when a change is needed.

The interaction needs one division of responsibilities. Result markers, control commands, root routing, and final-response logic previously each participated in completion judgment. Removing `completionReason` alone, or introducing another finish command, would not resolve that overlap.

The design follows a complete interaction: **root supplies current context → Supervisor judges → a decision or reply returns → root applies it → execution produces new facts → the next judgment.** `completionReason`, Announce, `returnDirect`, and cleanup serve that interaction.

## Responsibilities

| Component | Responsibility |
| --- | --- |
| Root Orchestrator | Own canonical messages, goal, active delegation, and orchestration state; supply inputs, validate and apply decisions, dispatch execution, and finish runs |
| Supervisor | Establish the plan at Entry; at Boundary, check results against the goal and established task, accept and advance within the plan or request improvement; ask the user directly for prerequisites or plan changes |
| Capability | Execute its delegated task, handle its tool feedback, and produce results that can be evaluated |
| User | Supply prerequisites, decide whether to change the goal or plan, and decide what happens after architecture or unhandled failures stop execution |

Supervisor reads current root context on each invocation, but changing facts do not automatically change the execution agreement. The goal, Capability disclosure prepared at Entry, and committed plan are `RUN-STABLE`; evidence and task progress change during execution. Supervisor maintains no separate main conversation and does not continuously watch internal Capability tool calls.

Plan stability means Supervisor does not autonomously add, remove, reorder, or change the scope of tasks. Accepting a task, dispatching the established next task, and shortening the remaining tail are progress, not plan revisions. This distinction needs no second plan copy or new state protocol. When a revision is needed, Supervisor explains the reason and proposed change and asks the user first; a subsequent invocation applies it after confirmation. Creating the initial plan from the user's goal does not require another approval step.

Acceptance means judging that **the current delegation's task has been satisfied**, using the existing acceptance effect. Supervisor may combine evidence from multiple attempts. This design adds no per-message selection, partial acceptance, or per-Announce completion protocol.

## A complete interaction

```text
current root context + goal
  -> Supervisor / Entry: how should this goal be achieved?
  -> root applies the returned decision
  -> Capability executes the current delegation
  -> root writes result evidence into main messages as an Announce
  -> Supervisor / Boundary: accept and advance, or improve this work?
  -> root dispatches next work, continues this task, or replies and ends the run
```

This is root's orchestration loop. Supervisor may use several discovery calls internally; Capability has its own model/tool loop. Those internal steps do not each trigger a new root decision.

### What root supplies each time

Every invocation builds input from current root state instead of replaying the previous Supervisor transcript.

| Input | Entry | Boundary |
| --- | --- | --- |
| Current root main conversation: user context, ordinary replies, Announce execution facts including unaccepted results | Present | Present |
| Current goal | Present | Present |
| Available Capabilities and disclosed documents | Discovery available before committing the plan | Reuse prepared information during execution; new-run user input may require preparation for a confirmed adjustment before execution resumes |
| Work not yet executed | May be empty for new work; retain the existing plan on resume unless the user confirmed a change | Present to check progress and the established next task |
| Current delegation identity and task | No active delegation | Present to associate results in main; no separate result body |

Observing root messages means reading the main-conversation projection of `root.messages`. Storage can also contain private lanes; the raw array must not be passed wholesale. Main is the sole input path for conversation and execution evidence. Goal, the fixed plan, and current delegation association remain root-owned orchestration state. Boundary no longer reads Capability's private scope or receives `announceAttempts` or another copy of result bodies.

Supervisor discovery, tool calls, and intermediate text belong to the invocation. Private Capability Human/AI/Tool history remains in its delegation scope. Task facts and result evidence cross the boundary.

### Entry: how to achieve the goal

Supervisor considers the user's goal, existing work, and available Capabilities to decide what actually needs execution. Existing facts may eliminate work; it need not start over.

For executable work, it submits an ordered plan. Root dispatches the first task and saves the tail. If user-owned information is missing or a direct answer is appropriate, Supervisor returns a complete natural reply and root ends the run.

Entry has no active delegation, so it cannot accept or continue one. Explicit resume with only a remaining plan still uses Entry, reads current context, and follows that plan. Resuming does not authorize replanning; ask the user if the plan is no longer executable.

If Entry asks a question before committing a plan and without an active delegation, the question stays in main. The user's answer follows ordinary conversation through `entryAnswer`, which resolves the goal from main context before handing it to Supervisor. Do not manufacture `resume_active` or suspended state for execution work that has not been established.

### Boundary: accept and advance, or improve

After Capability returns normally with a result, root writes it into main before invoking Supervisor. Supervisor identifies the current task's attempts through existing Announce `delegationId`, `runId`, `announceMessageId`, and message order. Reuse those attributes without new identity fields or message types, and do not assume the latest result subsumes earlier evidence. Model projection must retain those associations.

Using the goal and current root main conversation, Supervisor decides:

- The current task is satisfied and aligned with the goal: accept it and advance within the established plan or reply.
- Content or verification is missing and the same delegation can supply it: continue that task with specific feedback when useful.
- The execution direction is no longer suitable and the plan needs revision: explain the deviation and proposed change, then ask the user. Replace execution only after confirmation, retaining old evidence without marking the old task complete.
- Autonomous progress requires user-owned prerequisites: explain the obstacle and preserve unfinished work.

The remaining plan supplies the established arrangement. Boundary chiefly judges whether Capability results satisfy the current task and serve the goal. It can stop and ask when the plan is blocked; checking the plan is not permission to rewrite it. Accepting a delegation does not establish completion of the whole goal.

## One return boundary, two successful outputs

Root awaits `runner.invoke(input)`. Supervisor returns an existing control proposal or `{ reply }`; unhandled exceptions propagate. Existing disclosure return fields carry information prepared at Entry; Boundary retains that execution scope.

Tools express operations; natural text expresses a reply. The existing three control tools suffice:

| Return | When used | Root effect |
| --- | --- | --- |
| `submit_plan({ tasks, acceptCurrent })` | Start at Entry; accept and advance within the plan at Boundary; replace after user confirmation | Commit a non-empty plan, dispatch its first task, and save the tail. Entry requires `acceptCurrent: false`; at Boundary, true accepts the current task and false is reserved for user-confirmed replacement without acceptance |
| `continue_current({ feedback?, remainingPlan? })` | Current Boundary task needs improvement or continues after user input | Preserve the exact delegation, task, and private history, then continue with feedback; retain the future plan by default or update it alongside continuation when the user confirmed a change |
| `accept_result({ reply, remainingPlan })` | Current task can be accepted and this run should reply | Accept, emit the reply, and dispatch nothing; save the established unfinished tasks or the user-confirmed revised future plan. Use an empty plan only when none remain or the user confirmed cancellation |
| Natural final text | Reply directly at Entry or Boundary | Emit the supplied text, preserving unfinished task ownership and the remaining plan; no implicit acceptance or dispatch |

This table defines domain effects. The tool `submit_plan` maps to the existing result `action: 'execute_plan'`; the other controls retain their corresponding action names. No additional command envelope is needed.

Keeping these fields does not retain permission for arbitrary plan rewrites. Normal progression must match the established next task and tail. User confirmation remains in root's main conversation, without a new approval tool, confirmation flag, or change protocol. Root checks structural consistency of progression; Supervisor interprets the scope authorized by the user.

`continue_current.remainingPlan` contains only tasks after the current delegation, excluding the current task. Omission retains the existing future plan; a supplied array replaces it with the user-confirmed list; `[]` means the user confirmed cancellation of all future tasks. An empty array neither completes nor cancels the current delegation. Root applies the future-plan update and continuation feedback in one transition, then resumes that same delegation. No `update_plan` tool is added.

Each invocation returns at most one control decision. Acceptance with dispatch and acceptance with a reply are each expressed in one proposal, whose related state effects root applies together. Intermediate discovery returns are not final decisions.

### Natural reply versus reply after acceptance

Natural text ends **this run** without changing whether an existing task is accepted. “Please provide test credentials” preserves the current delegation. Even if the text incorrectly claims everything is complete, root does not infer acceptance from it.

When the current task is complete but an independent next step needs clarification, use `accept_result` with the question and established remaining plan. When Boundary judges the whole goal complete and no planned tasks remain, use it with an empty plan; Entry without an active task can simply return natural text. A goal-completion judgment must not silently skip outstanding tasks; ask the user if those tasks should be cancelled.

Both paths converge on the existing `answer` node, which emits one assistant reply and cleans up the run. No second model rewrite or root prose classification occurs. Text accompanying a control call is not another reply: the proposal owns that path, and user-facing text comes from `accept_result.reply`.

`answer` is the current implementation exit. A unified Finalizer node will own finalization later; its responsibilities and implementation will be designed after Supervisor optimization. This proposal does not freeze the current node as the final architecture.

Without a proposal, the adapter accepts only the final non-empty AI text message without tool calls. Empty or tool-only output fails; it does not reuse an earlier reply.

### Supervisor asks the user directly

When prerequisites are missing, a deviation from the goal cannot be corrected within the current task, or the plan should change, the Supervisor node generates the question directly, explaining what input or decision is needed. Use natural text while the task is unfinished, or `accept_result` with a reply when it can be accepted. No extra model node composes the question.

The simplest interaction displays the question and preserves unfinished work. The user answers through that work's continuation entry, which uses existing `resume_active` semantics for the next invocation. The answer enters root's main conversation and Supervisor evaluates current input. Supplying prerequisites does not approve a plan change; without agreement, no replacement occurs. The UI must expose continuation without requiring knowledge of internal commands, and must not submit an answer from that entry as `supersede_active`.

While a delegation remains unfinished, a user answer or explicit plan adjustment enters main as a new HumanMessage. Retain its identity, private history, existing Announces, and remaining plan, then invoke Supervisor / Boundary. Arrival alone does not accept, end, replace, or clear the delegation for replanning. Supervisor uses feedback to continue the same delegation when the input supplies prerequisites or implementation guidance, or applies an explicitly requested plan adjustment through existing controls. Any replacement follows that decision; receiving input is not a replacement signal.

User input is a valid decision input even without a new Announce; the subagent need not execute again first. If the task has no result evidence, Supervisor may clarify, supply continuation feedback, or address an explicit user adjustment, but cannot accept an unevidenced task. Execution failures without results still stop through the error path; this is user-initiated continuation, not an automatic repair loop.

Plan and disclosure stability applies within the execution loop. This new-run decision may prepare Capability information required by an explicit user adjustment before resuming execution, without first ending the current delegation or introducing another Supervisor mode. Supervisor interprets user authorization from main; root validates structure and execution legality without another semantic approval layer.

An ordinary question requires neither an `interrupted` event nor a suspended inner agent invocation. Review and explicit user pauses retain existing interrupts; Supervisor questions add no separate waiting state machine.

## Root applies the decision and continues

Root validates result shape, mode, Capability scope, active delegation identity, and plan progression before updating state. It does not independently judge result completeness or veto Supervisor's semantic judgment using stop reasons.

| Decision | Current delegation and evidence | Subsequent execution |
| --- | --- | --- |
| Accept and advance | Record task acceptance against results already in main and close the old private scope without moving or publishing results again | Create and execute the next delegation |
| Improve current work | Retain delegation identity, task, and complete private context; optionally save a user-confirmed future-plan revision | Continue the same delegation; feedback enters its next briefing without replacing the current task |
| User-confirmed replacement | Retain results in main without marking success; close the old scope | Create and execute the replacement task according to the confirmed change |
| Accept and reply | Record task acceptance against results already in main | Save the remaining plan, reply, and end this run |
| Natural reply | Preserve the active delegation and unaccepted evidence, if any | Save unfinished work, reply, and end this run |

Evidence publication and task acceptance happen separately. Main records facts, not only completed tasks. Root records acceptance in existing message metadata and delegation summaries without rewriting results; other main consumers must not infer success from a result's presence either.

The next Supervisor invocation reads updated root context. Control acknowledgements, intermediate Supervisor text, and private Capability tool records do not enter main. Tracing records raw invocation details.

### How execution results reach Boundary

Use the existing Announce as delegation result evidence: source, task, message identity, and complete output, without a completion judgment. The [Announce implementation reference](../../reference/runtime/delegation-announces.md) owns serialization fields and versions; this document does not repeat the schema.

A clean execution stop with a selected new deliverable makes root write an Announce directly into main before entering Boundary. A deliverable need not complete the task: a partial natural reply, unsuccessful attempt, or missing-prerequisite report can be result evidence. Each output retains one Announce identity; another execution appends another result, without storing duplicate Announces in private scope and main. Internal stop reasons do not determine acceptance, allowing `completionReason` to leave the cross-layer protocol while retaining necessary diagnostics.

Unhandled exceptions do not generate Announces. Execution ending without a deliverable does not produce an empty Announce or automatically enter an empty Boundary: retain existing records, stop, and report the failure. Later user input with explicit continuation may invoke Supervisor through the input path above. Review, cancellation, and interrupts keep their existing handling.

### Check compaction only when a new run starts

A run here means one root run, not one Supervisor/Capability loop iteration. Keep the existing `prepare → compactContext` entry: check the watermark when a new run starts and compact old history if needed. Once execution starts, do not compact root messages or clip individual Announces. New results and prior attempts remain complete throughout the run for acceptance judgment.

The existing watermark is 75% of usable input capacity after generation and reasoning reserves, leaving roughly 25% for context added during the run. Context protection also relies on compaction retention rules, not only on that headroom.

Each compaction retains recent messages and every Announce for the current unfinished delegation, including attempts outside the recent-message suffix. Existing active-task state and Announce identity metadata determine that association; other old history can be compacted normally. Continuation can therefore check and perform compaction without skipping the entire step.

After Announces enter main, match protection through their existing delegation identities rather than the presence of a private lane tag. Retain the original text of all attempts needed for acceptance instead of replacing it with a summary. This rule survives more aggressive watermark or history-retention settings without new protection state, duplicate result storage, or fallbacks. Capability retains ownership of its private subagent context maintenance.

## Who handles errors

The interaction needs two handling locations, not another error type system.

| Error boundary | Behavior |
| --- | --- |
| Tool operation error that its contract permits the caller to handle | Return the existing tool error result to the calling LLM, which may adjust its call, change approach, or explain the obstacle |
| Architecture, protocol, or unhandled failure | Clean up and propagate through the existing node-error path; stop this run and show the error so the user decides next |

Capability handles feedback from its tools; Supervisor handles feedback from discovery tools. Continuing based on that feedback is the normal tool loop and needs no general root repair loop.

Whether an error is tool feedback depends on the existing contract. Being thrown inside a tool function does not justify converting programming defects, corrupted state, or arbitrary exceptions into retryable ToolMessages.

Invalid control responses, inconsistent delegation state, and incompatible checkpoints are flow or protocol failures; Supervisor must not guess a compensating command. Unhandled model-service, execution, summarization, or finalization failures also propagate rather than becoming natural replies or result evidence.

Retain original diagnostics and recoverable records, and show a concrete next step. Users may supply prerequisites, explicitly continue, or start a new task, subject to existing recovery capabilities. Saved state does not imply automatic continuation, retry, replacement, or acceptance. Host's existing fatal/recoverable distinction remains even though both stop this run.

## Implementing the return with LangChain and LangGraph

Supervisor is an agent invocation awaited inside a root node. Its completion returns a result to root; root decides whether to dispatch work or end the outer graph.

### Control tools use returnDirect

Register the three control tools with `returnDirect: true`. Each directly returns a LangGraph `Command` containing only `update`:

```ts
// proposal is the existing domain proposal; register the tool with returnDirect: true.
return new Command({
  update: {
    supervisorCommand: proposal,
    messages: [new ToolMessage({
      name: toolName,
      tool_call_id: runtime.toolCallId,
      content: 'Proposal recorded.',
    })],
  },
});
```

`supervisorCommand` holds only this invocation's result. The ToolMessage call id completes the request/response pair, and its name lets the installed LangChain router recognize `returnDirect`. It is a private acknowledgement, not command transport or a user reply.

After `agent.invoke` returns, the adapter reads the proposal directly and returns it through the existing runner type. Root constructs its own `Command` for domain updates and routing. Inner tools do not use `Command.PARENT` to jump into the parent graph.

This removes JSON round trips, the control-tool `wrapToolCall` conversion, inner-exit `goto: END`/`jumpTo`, and the next-model-entry command check. Natural text still uses ordinary agent termination; no finish tool or extra exit hook is needed.

### Validate before tools execute

The model wrapper retains prompt selection, tool selection, and whole-response validation. A control must be the sole tool call in its response. Multiple controls, mixed discovery/control calls, and malformed control proposals are rejected before any tool executes.

Do not pick the first control, execute conflicting decisions sequentially, or add a correction round. Root also validates the returned domain result because production adapters and injected test runners share that boundary.

Where support is confirmed, a native provider option may disable parallel Supervisor tool generation while retaining automatic tool choice for natural replies. Do not send unsupported options to unknown endpoints or add a capability registry or parameter-removal retry. This reduces invalid output but does not replace validation; discovery-only batches remain legal. Capability tool scheduling is unchanged.

### Framework evidence and validation scope

The official [subgraph composition guide](https://docs.langchain.com/oss/javascript/langgraph/use-subgraphs#call-a-subgraph-inside-a-node) supports calling a child graph within a parent node and transforming its return. [returnDirect](https://reference.langchain.com/javascript/langchain/index/Tool/returnDirect) stops the agent loop after a tool call. The [Command documentation](https://docs.langchain.com/oss/javascript/langgraph/graph-api#command) explains that `goto` adds dynamic edges without replacing static ones.

A prior fake-model probe using LangChain 1.5.2 and LangGraph 1.4.7 observed two model calls for an ordinary tool and for `Command({ update, goto: END })`, but one for `returnDirect` with `Command({ update })`, retaining state updates. This supports the implementation choice, not a claim that production integration is already verified.

## Ending this run and recovering later

Natural replies and `accept_result` replies both end the current root run. They do not create an `interrupt` or suspend the inner Supervisor invocation.

For unfinished work, use the existing continuation snapshot to retain the needed goal, active delegation association, and remaining plan, then clear the run's Supervisor session. Explicit continuation initializes a new session from current root context: an active delegation with user input or result evidence enters Boundary first; absent both, execution resumes through the existing mechanism; a remaining plan without an active delegation enters Entry. Questions without either an active delegation or remaining plan return through ordinary `entryAnswer`. Review and other interrupts retain their existing mechanisms rather than being converted to ordinary reply termination.

A new run can prepare revised plans and Capability information based on user confirmation. Merely creating a new session or receiving a continuation request does not authorize a revision. Answering Supervisor's question continues the original work; normal termination of the previous run must not lose that association.

Root checkpoints own committed transitions and pending nodes. Resuming committed decisions must not repeat acceptance or dispatch; failure before the decision commits may require a new Supervisor invocation. Invocation-local `supervisorCommand` is not a durable decision cache.

Control tools have no external execution effects and need no separate ledger. External Capability tools retain their existing idempotency requirements; `returnDirect` does not provide exactly-once external execution.

## Validate with complete scenarios

Consider “fix a bug, verify tests, then prepare release notes”:

1. Entry reads existing root context and submits a plan to fix/verify, then prepare notes.
2. The first result contains a patch but no test evidence and enters main as an Announce. Boundary continues the same delegation with feedback to test; root preserves its execution context.
3. The next result includes passing tests and is appended to main. Boundary considers both complete attempts in main, accepts the task, and dispatches release notes. Root records acceptance without publishing results again.
4. When notes are ready, Boundary uses updated main context to accept and return the final reply through `accept_result` with an empty plan.

A handled test-tool argument error returns to Capability's LLM. Corrupted checkpoint or protocol state stops execution for user decision. If later work requires a user-selected publication destination, use `accept_result` with a question and remaining plan when the current task is satisfied; use a natural reply to preserve the current task when it is not. These situations must not collapse into a single completed flag.

If execution reveals that a dependency upgrade outside the established task scope is necessary, Supervisor explains why and asks whether to revise the plan. Providing test credentials alone preserves the original plan; explicitly agreeing to add the upgrade lets a subsequent invocation apply that change. Additional testing or corrections within the same task do not constitute such a revision.

Checks exercise interaction behavior, not literal prompt wording:

| Focus | Required observation |
| --- | --- |
| Per-loop context | Conversation and execution evidence come only from current main; no private delegation result channel or duplicate result injection; existing message identities associate the current task |
| Entry decisions | Executable work produces a plan; questions or direct answers return naturally; no nonexistent task is accepted |
| Improvement | Same task and private history survive; feedback reaches execution; omission retains the future plan, a confirmed array update commits with continuation, and an empty array does not end the current task |
| Acceptance and replacement | Acceptance advances within the established plan; replacement requires user confirmation and preserves evidence without success |
| Plan stability | No task additions, removals, reordering, or goal changes without user confirmation; ordinary task progress needs no extra approval |
| User interaction | Supervisor asks directly; answers through continuation return to the original goal and unfinished work; absent approval, the original plan survives |
| Question entry | Before plan creation, answers go through `entryAnswer`; with an active delegation, input enters main before Supervisor without ending or replacing work; no acceptance without evidence |
| Result input | Attempts remain ordered; different clean stops do not change input; absent deliverables or unhandled failures do not automatically manufacture Boundaries, while later user input may request another decision |
| Publication and acceptance | Partial natural results enter main before acceptance; presence does not imply success and acceptance does not republish |
| Compaction timing and retention | Root checks compaction only at new-run entry; retain recent messages and all original Announces for the current unfinished delegation, even outside the recent suffix; other old history can compact normally |
| Return after tools | Each control records its proposal without another model call; discovery can continue the model loop |
| Return after text | Exact text is emitted once without implicit acceptance or lost work; empty/tool-only output cannot reuse an old reply |
| Invalid batches | Multiple controls, mixed calls, bad shape, or invalid scope are rejected before execution without partial effects or repair rounds |
| Errors | Handled tool errors reach the calling LLM; architecture failures stop without compensating dispatch |
| Recovery and isolation | Root replay does not repeat committed effects; new sessions use canonical facts; private messages and acknowledgements stay outside main |

Models must express completion judgments using the appropriate control. That semantic choice requires real-model evaluation; local structural tests cannot establish it.

## Implementation order and legacy cleanup

First fix per-loop inputs, return values, and root effects; then replace inner mechanics. Keep the three controls and existing runner interface rather than simultaneously redesigning session storage, the full Finalizer, or interrupts.

| Cleanup target | Direction |
| --- | --- |
| Repeated planning and completion judgment | Prompts define Supervisor judgment, tool descriptions state effects, and root validates and executes |
| Separate Boundary result input and acceptance-time movement | Publish Announces into main first; remove private result extraction, duplicate projection, and republishing on acceptance; retain identity association and task acceptance records |
| Inner control-tool exit | Use `Command({ update })` and `returnDirect`; remove serialization transport and duplicate exit controls |
| `completionReason` and stop-reason vetoes | Remove from cross-layer results and judgment, keeping necessary runtime diagnostics |
| Second final-response generation and old terminal commands | Emit supplied reply text; remove competing commands and model rewrites |
| Last-command cache and error fallbacks | Use existing root checkpoints and error paths; add no decision cache, protocol repair, or provider negotiation loop |

Check each step against the complete scenarios above. Keep one decision objective when updating prompts and tools rather than copying the same policy into several layers.

### Current implementation status

These implementation observations refer to the local worktree, whose code changes remain uncommitted. This commit contains documentation only and does not imply that the PR includes those implementations.

The worktree already has the three proposals, natural replies, root transitions, continuation snapshots, and `completionReason` cleanup. `returnDirect`, provider parallel-call settings, the newly clarified stable-plan constraint, fixed disclosure during execution, and continuation after ordinary questions still need implementation and validation. Current Boundary behavior still permits rewriting the remaining plan and further discovery; it does not yet satisfy this constraint. The unified Finalizer node follows Supervisor optimization. This revision changes documentation only.

Current `continue_current` code accepts only optional `feedback`. Optional `remainingPlan`, its validation, and the combined root update are a newly specified interface extension pending implementation.

The clarified continuation target also sends new user input to Supervisor before preparing needed information and continuing the delegation. Current pending-task recovery may still route directly to Capability, and Boundary input still requires an Announce. Both need adjustment for user-initiated input; documented intent is not an implementation claim.

Announce identity fields and root entry-only compaction already exist; compaction already retains recent messages and current-delegation Announces. Direct main publication, removal of the separate Boundary result input, adjustment of model projection and acceptance-time movement, and matching existing compaction protection to main Announces by identity remain unimplemented. Current code stores Announces privately before handoff into main; protection still depends on private lane tags and does not yet cover the migrated main messages.

Previously, 458 shared-runtime tests and the full workspace test command, typecheck, build, and context audit passed. These are observations of the earlier implementation, not validation of pending changes. The local `packages/pet-agent/evals/supervisor-boundary.eval.ts` contains four synthetic real-model cases; it is not included in this documentation commit, still requires outbound authorization, and remains unverified.

## Related documents

This document owns the overall interaction. Existing documents retain their details without introducing new concepts or duplicating field definitions here:

- [Supervisor session](run-scoped-supervisor-session.md): run-scoped semantic state and session lifetime.
- [Announce implementation reference](../../reference/runtime/delegation-announces.md): result identity, version, handoff metadata, and model projection.
- [Context injection map](../../reference/runtime/context-injection-map.md): message ownership and selection.
- [Error handling reference](../../reference/api/error-handling.md) and [Guard design](../../reference/runtime/guards.md): existing error exits, internal limits, and diagnostics.
