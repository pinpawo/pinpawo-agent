# Supervisor–Root Interaction Protocol

Status: working design for issue #755, fully rewritten around the direction discussed on 2026-09-06. This document describes the target design; implementation status is recorded at the end.

[中文版本](delegation-boundary-protocol.zh-CN.md). Both versions describe the same design. Existing file paths are retained to preserve links.

## Supervisor simplification (2026-09-08)

User-approved cleanup: Supervisor reads an immutable in-memory Capability catalog
built from the compiled, host-allowed registry. Exact-name `capability_details`
returns catalog documents; there is no search backend, filesystem snapshot,
repair lock, or model-generated routing manifest. The routing description comes
directly from authored Capability and Toolkit descriptions. Keep registry identity,
allowed-name validation, disclosure deduplication, and the document byte budget.

Remove unused session revision counters and arbitrary additional Supervisor tools.
The Supervisor only has capability details and phase-specific control tools.
Keep caller cancellation, result provenance, plan continuation, and root validation.

Pause-continuation routing is explicitly excluded from this cleanup. Its existing
behavior is unchanged and tracked separately in [#785](https://github.com/pinpawo/pinpawo-agent/issues/785).

Validation covers registry isolation and document fidelity, exact-name disclosure,
no routing-preparation model call, caller cancellation, and existing continuation behavior.

## Capability details (2026-09-08)

The manifest describes the available Capability set and supports planning directly.
Supervisor arranges the goal from main messages, the manifest and already provided
information. `capability_details({ names })` optionally supplies full documents for
exact manifest names when specific responsibilities, constraints or usage details
are needed. Calling this tool is not a prerequisite for `submit_plan`; root still
validates every selected name against the immutable registry.

The result distinguishes newly supplied `documents`, `alreadyDisclosed` names and
`unknownNames`. It never performs substring search or suggests keyword expansion.
Already supplied documents are not read or repeated. Disclosure state keeps only registry identity and disclosed names. Empty-round
counters, open/closed flags and model/tool-call observations are removed.
The document byte budget remains. Supervisor has no elapsed-time limit and
continues to honor caller cancellation; no separate sufficiency judge or new planning
stage is added. Disclosure stays stable during execution Boundaries, as before.

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

## Prompt and tool responsibilities

The system prompt states the Supervisor role, phase, relation between goal and current task, and when to ask the user. Tool descriptions and parameter schemas own acceptance criteria, reason, reply, future-plan semantics, and invocation termination. Code enforces deterministic argument, batch, and state validity. Review and control are one call; no second model judges completed.

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

Boundary selects only the current logical task’s main messages using the existing `traceId`, not the physical `runId`. Resume retains traceId, including earlier delegation deliveries, all current attempts, Supervisor questions, and user supplements across runs. Unrelated tasks are excluded. Entry may still read the full conversation to establish the goal. Root stamps new human messages after resolving resume identity, and stamps replies and main Announces with the same traceId.

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

The root graph’s `runSupervisor` node invokes the Supervisor agent using main messages and receives its decision. Tool history is invocation-local; canonical state remains root-owned. Supervisor returns an existing control proposal or `{ reply }`; unhandled exceptions propagate. Existing disclosure return fields carry information prepared at Entry; Boundary retains that execution scope.

Tools express operations; natural text expresses a reply. Two control tools suffice:

| Return | When used | Root effect |
| --- | --- | --- |
| `submit_plan({ tasks })` | Establish or resume a plan at Entry | Commit the plan and dispatch its first task only when no delegation is active; never accept a task |
| `review_current({ completed, reason, reply?, remainingPlan? })` | Review delivery of the current Boundary task | true accepts and advances the established plan, or ends the run with reply; false preserves the delegation and forwards reason as continuation feedback. remainingPlan only carries user-confirmed future-plan changes |
| Natural final text | Reply directly at Entry or Boundary | Emit the supplied text, preserving unfinished task ownership and the remaining plan; no implicit acceptance or dispatch |

Entry establishes the plan; Boundary uses one tool with an explicit completion judgment and reason. completed concerns only the current task, not whole-goal completion, cancellation, or replacement. For true, reason identifies delivery evidence; for false, it specifies a concrete gap within the current task. Outstanding future tasks are not grounds for false. Explicit cancellation or replacement still uses existing user task controls.

Keeping these fields does not retain permission for arbitrary plan rewrites. Normal progression must match the established next task and tail. User confirmation remains in root's main conversation, without a new approval tool, confirmation flag, or change protocol. Root checks structural consistency of progression; Supervisor interprets the scope authorized by the user.

`review_current.remainingPlan` contains only tasks after the current delegation, excluding the current task. Omission retains the existing future plan; a supplied array replaces it with the user-confirmed list; `[]` means the user confirmed cancellation of all future tasks. An empty array neither completes nor cancels the current delegation. Root applies the future-plan update and continuation feedback in one transition, then resumes that same delegation. No `update_plan` tool is added.

Each invocation returns at most one control decision. Acceptance with dispatch and acceptance with a reply are each expressed in one proposal, whose related state effects root applies together. Intermediate discovery returns are not final decisions.

### Natural reply versus reply after acceptance

Natural text ends **this run** without changing whether an existing task is accepted. “Please provide test credentials” preserves the current delegation. Even if the text incorrectly claims everything is complete, root does not infer acceptance from it.

completed=false cannot include reply; ask the user with natural text instead. When the current task is complete but an independent next step needs clarification, Supervisor may use `review_current(completed=true)` with the question and established remaining plan. When the current task is complete and no planned tasks remain, use it with an empty plan; Entry without an active task can simply return natural text. A goal-completion judgment must not silently skip outstanding tasks; ask the user if those tasks should be cancelled.

Supervisor may also ask naturally before accepting a task with sufficient delivery evidence, retaining that delegation until the user answers. Evals must accept this path and verify preservation and resumption rather than require acceptance before every question. Finalization without missing user input remains a separate explicit-acceptance check.

Both paths converge on the existing `answer` node, which emits one assistant reply and cleans up the run. No second model rewrite or root prose classification occurs. Text accompanying a control call is not another reply: the proposal owns that path, and user-facing text comes from `review_current.reply`.

`answer` is the current implementation exit. A unified Finalizer node will own finalization later; its responsibilities and implementation will be designed after Supervisor optimization. This proposal does not freeze the current node as the final architecture.

Without a proposal, the adapter accepts only the final non-empty AI text message without tool calls. Empty or tool-only output fails; it does not reuse an earlier reply.

### Supervisor asks the user directly

When prerequisites are missing, a deviation from the goal cannot be corrected within the current task, or the plan should change, the Supervisor node generates the question directly, explaining what input or decision is needed. Use natural text while the task is unfinished, or `review_current(completed=true)` with a reply when it can be accepted. No extra model node composes the question.

The simplest interaction displays the question and preserves unfinished work. The user answers through that work's continuation entry, which uses existing `resume_active` semantics for the next invocation. The answer enters root's main conversation and Supervisor evaluates current input. Supplying prerequisites does not approve a plan change; without agreement, no replacement occurs. The UI must expose continuation without requiring knowledge of internal commands, and must not submit an answer from that entry as `supersede_active`.

While a delegation remains unfinished, a user answer or explicit plan adjustment enters main as a new HumanMessage. Retain its identity, private history, existing Announces, and remaining plan, then invoke Supervisor / Boundary. Arrival alone does not accept, end, replace, or clear the delegation for replanning. Supervisor uses feedback to continue the same delegation when the input supplies prerequisites or implementation guidance, or applies an explicitly requested plan adjustment through existing controls. Replacing the current delegation uses existing user task controls; receiving a supplement is not a replacement signal.

User input is a valid decision input even without a new Announce; the subagent need not execute again first. If the task has no result evidence, Supervisor may clarify, supply continuation feedback, or address an explicit user adjustment, but cannot accept an unevidenced task. Execution failures without results still stop through the error path; this is user-initiated continuation, not an automatic repair loop.

Plan and disclosure stability applies within the execution loop. This new-run decision may prepare Capability information required by an explicit user adjustment before resuming execution, without first ending the current delegation or introducing another Supervisor mode. Supervisor interprets user authorization from main; root validates structure and execution legality without another semantic approval layer.

An ordinary question requires neither an `interrupted` event nor a suspended inner agent invocation. Review and explicit user pauses retain existing interrupts; Supervisor questions add no separate waiting state machine.

## Root applies the decision and continues

Root validates result shape, mode, Capability scope, active delegation identity, and plan progression before updating state. It does not independently judge result completeness or veto Supervisor's semantic judgment using stop reasons.

| Decision | Current delegation and evidence | Subsequent execution |
| --- | --- | --- |
| Accept and advance | Record task acceptance against results already in main and close the old private scope without moving or publishing results again | Create and execute the next delegation |
| Improve current work | Retain delegation identity, task, and complete private context; optionally save a user-confirmed future-plan revision | Continue the same delegation; feedback enters its next briefing without replacing the current task |
| Explicit user task replacement | Existing task controls detach the old active scope while retaining evidence without success | The new task enters ordinary goal capture and planning |
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

Compaction reuses the existing summary message type, separating the current traceId from older history into at most two summaries. Later compactions fold each group again. The current-task summary keeps traceId so Boundary retains earlier accepted work without importing unrelated tasks.

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

Register the two control tools with `returnDirect: true`. Each directly returns a LangGraph `Command` containing only `update`:

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

Natural replies and `review_current(completed=true)` replies both end the current root run. They do not create an `interrupt` or suspend the inner Supervisor invocation.

For unfinished work, use the existing continuation snapshot to retain the needed goal, active delegation association, and remaining plan, then clear the run's Supervisor session. Explicit continuation initializes a new session from current root context: an active delegation with user input or result evidence enters Boundary first; absent both, execution resumes through the existing mechanism; a remaining plan without an active delegation enters Entry. Questions without either an active delegation or remaining plan return through ordinary `entryAnswer`. Review and other interrupts retain their existing mechanisms rather than being converted to ordinary reply termination.

A new run can prepare revised plans and Capability information based on user confirmation. Merely creating a new session or receiving a continuation request does not authorize a revision. Answering Supervisor's question continues the original work; normal termination of the previous run must not lose that association.

Root checkpoints own committed transitions and pending nodes. Resuming committed decisions must not repeat acceptance or dispatch; failure before the decision commits may require a new Supervisor invocation. Invocation-local `supervisorCommand` is not a durable decision cache.

Control tools have no external execution effects and need no separate ledger. External Capability tools retain their existing idempotency requirements; `returnDirect` does not provide exactly-once external execution.

## Validate with complete scenarios

Consider “fix a bug, verify tests, then prepare release notes”:

1. Entry reads existing root context and submits a plan to fix/verify, then prepare notes.
2. The first result contains a patch but no test evidence and enters main as an Announce. Boundary continues the same delegation with feedback to test; root preserves its execution context.
3. The next result includes passing tests and is appended to main. Boundary considers both complete attempts in main, accepts the task, and dispatches release notes. Root records acceptance without publishing results again.
4. When notes are ready, Boundary uses updated main context to accept and return the final reply through `review_current(completed=true)` with an empty plan.

A handled test-tool argument error returns to Capability's LLM. Corrupted checkpoint or protocol state stops execution for user decision. If later work requires a user-selected publication destination, use `review_current(completed=true)` with a question and remaining plan when the current task is satisfied; use a natural reply to preserve the current task when it is not. completed records current-task acceptance; reply supplies the user-facing output.

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

First fix per-loop inputs, return values, and root effects; then replace inner mechanics. Keep the two controls and existing runner interface rather than simultaneously redesigning session storage, the full Finalizer, or interrupts.

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

2026-09-07: the implementation follows this interaction. Entry uses only
`submit_plan`; Boundary uses `review_current`. Control tools
return `Command({ update })` with `returnDirect`; the root `runSupervisor` node
applies deterministic transitions. The current answer node emits supplied text
once; the unified Finalizer remains deferred.

Announces enter main before acceptance. Supervisor has no separate result list
or private execution query. Acceptance updates metadata on the original message
id. Entry-only compaction protects every attempt of unfinished work through
existing Announce identities.

User supplements enter main before Supervisor. Optional continuation plan changes
are applied atomically; normal execution cannot rewrite the established plan or
expand disclosure. TUI exposes continuation from authoritative unfinished plans.

Removed completionReason transport, competing terminal commands, answer model
rewrites, control JSON round trips, and disclosure/compaction failure fallbacks.
Provider-native parallel flags are not forced onto unknown compatible endpoints;
pre-tool response validation enforces the control-batch contract.

Behavior tests cover single-call controls, evidence publication, continuation,
plan constraints, protected compaction, and checkpoint recovery. The synthetic real-model eval on DeepSeek v4-pro (2026-09-07) passed 7 of 8 cases with thinking disabled; finalization emitted XML text instead of calling the control tool. After enabling thinking by default as requested, the same 8 cases passed, including natural questions and two user-answer continuations; finalization called review_current. Production prompts were unchanged. This single-run comparison establishes neither stability nor causality.

Current model policy: runtime and eval omit thinking and reasoning_effort overrides for every role, leaving provider defaults in effect. The old subagent thinking switch and per-role effort policy have been removed. The explicit-thinking results above are historical experiment settings.

## Related documents

This document owns the overall interaction. Existing documents retain their details without introducing new concepts or duplicating field definitions here:

- [Supervisor session](run-scoped-supervisor-session.md): run-scoped semantic state and session lifetime.
- [Announce implementation reference](../../reference/runtime/delegation-announces.md): result identity, version, handoff metadata, and model projection.
- [Context injection map](../../reference/runtime/context-injection-map.md): message ownership and selection.
- [Error handling reference](../../reference/api/error-handling.md) and [Guard design](../../reference/runtime/guards.md): existing error exits, internal limits, and diagnostics.
