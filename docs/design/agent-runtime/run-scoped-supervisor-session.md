# Run-scoped Supervisor session

Status: working design. The 2026-09-06 interaction simplification uses native
`returnDirect`; that integration is pending implementation. The same discussion
fixes the execution plan and prepared Capability disclosure during execution;
the current implementation still permits Boundary replanning and discovery.

## Goal

Define how the Run Supervisor uses current root context on each orchestration
loop. At Entry it plans how to achieve the goal; at Boundary it decides whether
to accept the delegation's work and advance or have that delegation improve it.
Root owns execution and canonical state changes.

This document owns Supervisor session lifetime, semantic memory, context, and
replay. The [Supervisor–Root Interaction Protocol](delegation-boundary-protocol.md)
owns per-loop inputs, decisions, return values, root effects, and failure exit.
Capability exit and Announce eligibility serve that interaction. Those policies
are not duplicated here.

The Supervisor owns:

- initial formation of the executable Capability plan;
- checking Capability results against the goal and established task, then
  accepting and progressing or requesting improvement;
- directly asking the user for missing prerequisites or proposed plan changes,
  applying revisions only after confirmation through the existing commands.

The deterministic root Orchestrator remains the only component that mutates
canonical messages, delegation lifecycle, and root graph state. The Supervisor
observes canonical facts and returns a proposal or a natural reply; its private
invocation state does not mutate root directly.

`entry` and `boundary` remain valid decision modes. The design changes the
lifetime and ownership of their data: a Supervisor session lives for one root run,
while each Boundary reads current result messages from root main history.

## Problem

The previous design persisted Supervisor Human, AI, search Tool, and command Tool
messages in the root `messages` channel under a trace-scoped lane. That made
Supervisor execution history survive multiple runs and forced every consumer to
decide which Supervisor messages to select, replay, compact, invalidate, or remove.

Excluding those messages from later model calls avoids self-reinforcement, but
leaves an incoherent intermediate shape: Supervisor provider messages are
persisted even though they are not Supervisor working memory.

The domain needs state. It does not need to turn root conversation messages into
the storage format for that state.

## Decision

The Run Supervisor is a stateful domain component scoped to one `runId`.

- A new run creates a clean Supervisor session.
- Entry initializes the session while reading a clean main-conversation projection.
- Boundary reuses the session and reads main with current task associations.
- Every invocation projects root's current main messages again, including result
  evidence already published before acceptance; private executor history is absent.
- Supervisor delivers at most one control proposal per invocation; root
  validates and materializes its related effects in one transition.
- Supervisor prompt messages never enter canonical root `messages`.
- The next run does not inherit the previous run's Supervisor provider messages,
  search attempts, command calls, or command replay cache.

Supervisor statefulness is semantic. Raw provider messages are not the source of
truth for the plan, current task, disclosure state, or idempotency.

## Independent axes

Decision mode and data lifetime are independent.

### Decision mode

| Mode | Purpose |
|---|---|
| `entry` | Read the current goal and root context; decide how to achieve it or what user input is needed. |
| `boundary` | Read updated root context and current delegation evidence; accept and advance, request improvement of the same delegation, or reply. |

Goal, the committed plan, and prepared Capability disclosure are `RUN-STABLE`.
Evidence and progress are dynamic. A shrinking remaining tail reflects execution
of the same plan, not permission to add, remove, or reorder tasks. If a task cannot
meet the goal within that plan, Supervisor asks the user before revising it.

### Data lifetime

| Scope | Owner | Examples |
|---|---|---|
| conversation/goal | root | main conversation, Delegation Announces including unaccepted results |
| run | Supervisor session and root typed state | goal, plan, Capability disclosure |
| invocation | Supervisor adapter | current main projection and task association, system projection, bound tools |
| delegation | Capability subagent | private execution messages; returned outputs are published by root |

No message tag or lane changes one scope into another. Projection may expose
data across a boundary, but it does not transfer ownership or mutate the source.

## Clean main conversation

The Supervisor starts from the centralized `queryAgentMessages(...).main()` view:

- every lane-tagged message is excluded;
- delegation briefings never enter canonical messages;
- normal result outputs are published as `DelegationAnnounceMessage` values in
  main before acceptance, including partial results;
- provider projection happens after selection and never writes back to state.

Supervisor inputs, intermediate model outputs, search results, and control-tool
messages remain private. The final natural reply alone is projected to main by
the terminal node. Capability results enter main independently through root
publication; presence in main does not establish task success.

## Supervisor session state

The exact storage type may evolve, but its semantic shape is:

```ts
type RunSupervisorSessionState = {
  runId: string;
  revision: number;

  plan: CapabilityPlanTask[];
  capabilityDisclosure: CapabilityDisclosureState;
};
```

The session can be a dedicated root state channel or a private Supervisor subgraph
state. A dedicated state value is preferred over a lane in root `messages`.

There is one plan source of truth. In the target state shape,
`RunSupervisorSessionState.plan` replaces or directly owns the value currently exposed
as `runCapabilityPlan`; the two must not coexist as independently writable
copies. The normalized goal remains the root-owned `runUserRequest` and is read
by Supervisor rather than copied into another authoritative field.

The existing `plan` field stores remaining execution work. Its tail advances
after acceptance, while task content, scope, and order remain fixed without user
confirmation. This semantic distinction needs no second immutable-plan store or
new progress protocol. The session's `revision` is not authorization to replan.

Tool-effect replay remains runtime-owned. This implementation removes the old
last-command cache and uses committed graph checkpoints and pending-node replay.
There is no per-tool effect ledger or Supervisor message lane.

### State that remains root-owned

Root continues to own execution lifecycle facts:

```text
runUserRequest
taskActiveDelegation
runDelegationSummaries
runSupervisorReply
```

Supervisor session state cannot directly create a delegation, accept an announce,
clear a Capability lane, or write a user-visible response. The runner returns an
existing typed command or `{ reply }`; root alone applies the result.

## Session lifecycle

```text
new root run
  -> initialize clean Supervisor session
  -> Entry decision
  -> Capability execution
  -> typed Boundary input + Boundary decision
  -> Capability execution / terminal route
  -> root run ends
  -> discard Supervisor session
```

A later run always creates another Supervisor session. If a run stops with work
that may be resumed, root persists a separate task-continuation snapshot rather
than preserving the old Supervisor session. An explicit resume seeds a new session
from canonical facts such as the active delegation, remaining plan, accepted
Announces, and normalized goal. It does not resume the previous Supervisor working
history, search attempts, or command replay cache.

Terminal Supervisor, Capability, and Answer exceptions follow the same lifetime
rule. Root first checkpoints a continuation snapshot for resumable work and
clears the run-scoped Supervisor session, then rethrows the failure. An exception
must not leave a previous run's session available to a later invocation.

Recovery availability does not mean automatic recovery. Architecture, protocol,
and unhandled execution failures stop the run and surface to the user, who decides
whether to continue or start again. Tool operation errors handled under their
existing contract may instead return to the LLM calling that tool. No Supervisor
session is started merely to repair an architecture failure.

Capabilities referenced by a resumed active task or remaining plan may be
materialized into the new run's initial disclosure. Previous search attempts and
empty-search counters are not inherited merely because the trace is unchanged.

## Entry invocation

Entry reads the clean main conversation and adds an Entry frame containing the
normalized goal, the compact Capability routing manifest, and any Capability
documents already disclosed by continuation state. The conversation
remains root-owned; later Supervisor invocations project the current clean view
again rather than persisting a Supervisor-owned copy.

Conceptual model input:

```text
SystemMessage(Supervisor entry objective and context semantics)
MainConversationMessages(clean canonical projection)
SupervisorEntryFrame(
  goal,
  routingManifest,
disclosedCapabilities
)
```

Entry has no active delegation or announce attempts.

On continuation without an active delegation, Entry also receives the existing
remaining plan and follows it unless root's user context confirms a change.
New session initialization alone does not authorize a new plan.

If Supervisor asks before any plan or delegation exists, keep the question in
main and process the answer through ordinary `entryAnswer`. It resolves the goal
from that conversation before handing execution to Supervisor. No continuation
snapshot or suspended planning state is needed for this case.

The resulting plan-commit command initializes the run plan. Provider-facing
Human/AI/Tool messages produced while making that decision remain inside the
invocation or run-private observability stream; they do not become root history.

## Boundary reads main messages

Main is the sole conversation and execution-evidence input for Supervisor.
Root publishes each normal Capability result as an existing
`DelegationAnnounceMessage` before invoking Boundary, even if the task is only
partly complete. Supervisor never queries the Capability private message scope.

Goal, the established plan, and current delegation association remain typed
root state. They identify what is being evaluated; result bodies exist only in
main. The model projection reuses existing `delegationId`, `runId`, and
`announceMessageId` attributes and message order to associate attempts. No new
message identity, separate result list, or duplicate result body is needed.

Publication does not accept the task. Prior and latest attempts remain ordered
execution evidence in main; Supervisor may need several of them to judge the
task. Acceptance updates root-owned task metadata and lifecycle without moving
or publishing those messages again. Intermediate Capability Human/AI/Tool
messages remain private.

User input on continuation is also main-conversation evidence. Retain the active
delegation, private history, Announces, and remaining plan when appending that
HumanMessage, then invoke Boundary before further execution. Input arrival does
not accept, terminate, replace, or clear the delegation. Supervisor interprets
the user's requested adjustment and uses existing controls to continue or apply
it. This path needs no new Announce; without any result evidence it may guide or
clarify work, but cannot accept the task. Automatic execution failure without a
deliverable still stops instead of invoking Supervisor.

Current code still constructs `announceAttempts` and `latestAnnounce` from a
private delegation query and projects a separate Boundary result frame. Remove
that result path when moving Announce publication into main. Entry and Boundary
modes, root task ownership, and the existing return interface remain.
The current unconditional Boundary evidence requirement and direct pending-task
resume route also need to distinguish user-initiated input from automatic result
evaluation. No third mode is introduced.

## Provider contract audit

Supervisor behavior depends on the complete provider-visible contract, not prompt
text alone. Before changing Supervisor policy or investigating a model regression,
render the production contract without calling a model:

```sh
npm run supervisor:context-audit
```

The command uses the production system/input builders, main-message projection,
tool descriptions, and argument schemas for both modes. Review the output in one
fixed order:

1. **Goal:** each mode has one clear decision objective.
2. **Evidence:** accepted history, current announce evidence, and established
   remaining tasks have distinct meanings; plan items are not completion evidence.
3. **Actions:** the provider sees only command actions valid for that mode, with
   mutually exclusive effects and complete coverage of valid Boundary states.
4. **Arguments:** schemas describe the command payload rather than adding a
   second decision policy.
5. **Scope:** private executor history is absent; main contains accepted and
   unaccepted result facts, distinguished by existing root-owned metadata.
6. **Runtime:** code validates typed identity and shape; it does not infer semantic
   completion from announce prose.

The system message owns decision policy. Tool descriptions state tool effect and
eligibility concisely; argument descriptions state serialized data semantics.
Static audit is a reasoning aid, not a prose snapshot test. Validate changes with
behavior tests and targeted model evals.

## Successive Boundaries

Assume Entry submits `[T1, T2, T3]`.

At the first Boundary:

```text
active = T1
main includes unaccepted A1 for T1
remaining = [T2, T3]
```

If Supervisor proposes acceptance and execution of `[T2, T3]` in one decision,
root records acceptance for A1 already in main, creates T2, and keeps `[T3]` as the future
tail in one transition. Acceptance with a reply instead dispatches nothing.
The second Boundary receives:

```text
clean main conversation includes accepted A1
active = T2
main also includes unaccepted A2 for T2
remaining = [T3]
```

This consumes the existing plan in order. Replacing `[T2, T3]` with different
tasks, dropping T3, or reordering the tail requires asking the user first; a
normal continuation or a new result alone does not authorize it.

If Supervisor chooses `continue_current`, root preserves the exact delegation id,
task, and private execution history. Omitted `remainingPlan` preserves the future
plan; a supplied array updates it to the user's confirmed revision, excluding
the current task. `[]` clears only future tasks after user confirmation, without
accepting or cancelling the active delegation. Root commits the plan update and
continuation feedback together. The optional plan argument is pending implementation;
the current tool accepts only feedback. The next normal result is
appended to main under that delegation's existing identity. Supervisor reads all
attempts in chronology and does not assume the latest is cumulative.

Root checks compaction only at new-run entry, using the existing 75% watermark
after generation reserves. No root compaction or per-Announce clipping occurs
inside the execution loop. Compaction retains recent messages and all original
Announces for the current unfinished delegation, including attempts outside the
recent suffix. Match them through existing Announce identity metadata and active
task state; other old history can compact normally, including on continuation.
There is no need to defer the entire compaction step or add protection state or a
second result store. Current protection depends on private lane tags and must
follow Announce identity after publication moves to main. Subagent-private context
maintenance remains separate.

## Commands and idempotency

The [Supervisor–Root Interaction Protocol](delegation-boundary-protocol.md#one-return-boundary-two-successful-outputs)
owns the single-proposal interaction and natural-text terminal interface. Root
awaits the runner's return; no inner tool jumps directly into parent graph nodes.
Exploration can involve multiple tool calls. A control tool records the proposal
in invocation-local `supervisorCommand` and ends through `returnDirect`; natural
text ends through ordinary model routing. Both return through the same runner
interface. The adapter validates the full response before tools execute, and root
validates the returned proposal before applying its effects.

`supervisorCommand` is a single invocation's output slot, not session memory or
an acceptance fact. Its acknowledgement ToolMessage stays private and is never
parsed as command transport. The pending implementation removes middleware exit
controls and the JSON round trip; it adds no new persistent state.

The root graph commits the complete transition before routing to execution or
terminal cleanup. Resuming a completed checkpoint does not rerun Supervisor or
repeat dispatch. A fresh invocation makes a fresh decision; external tool effects
remain subject to their existing replay and idempotency rules.

A natural final reply is passed to the terminal node without implying acceptance
or dispatch. A proposal that both accepts and replies must carry both effects in
one transition; `accept_result` carries the reply and remaining plan. The terminal
node emits supplied text once and saves unfinished work through the existing
continuation snapshot. This ends the root run, not a suspended inner invocation;
it does not create an `interrupt`. Intermediate provider messages remain private.
When the text asks the user a question, the work's continuation entry must route
the answer back to the same goal and saved work, using existing resume semantics.
The answer becomes root main context; no Supervisor wait state or approval tool
is added. A unified Finalizer node will replace the current finalization exit
after Supervisor optimization; that design is deferred.
The old missing-command terminal category is removed; empty or invalid
output uses the existing node-error cleanup and rethrow path.

## Capability disclosure

Capability disclosure is run-scoped semantic state, not prompt history. Entry
prepares the Capability information needed for the plan; successful searches may
add documents before execution begins. Search calls use the existing local
reducers and limits, with automatic tool choice and the existing closed-discovery
result when the limit is reached.

During execution, Boundary reuses the prepared disclosure. If the established
Capabilities cannot support the goal, Supervisor asks about changing the plan
instead of extending its execution scope autonomously. The user's answer enters
main with the current delegation retained. On that new run's first decision,
Supervisor may prepare information needed for the user's explicit adjustment,
even in Boundary mode, before execution resumes and disclosure becomes stable
again. There is no separate replanning stage or requirement to close the active
delegation. Registry validation or session creation alone does not authorize a
change.

The current implementation still accumulates disclosure and empty-search counts
across Entry and Boundary and exposes discovery tools to both. Freezing disclosure
during execution is a target change, not an already verified runtime property.

## Observability and recovery

LangSmith or equivalent tracing owns raw Supervisor prompts, model outputs, search
calls, and command tool calls. Root conversation checkpointing must not double
as the audit log.

Checkpoint recovery persists semantic session state only for the active run.
Recovery of the same run can replay a structured command or continue from typed
state. Starting another run resets the private Supervisor session even when the
user goal retains the same `traceId`.

## Non-goals

- Moving plan ownership back to Answer or Capability subagents.
- Redesigning Answer as the Run Finalizer in the same migration.
- Removing `entry | boundary` modes.
- Letting code infer task completion from announce prose.
- Treating Capability stop reasons as Supervisor input or acceptance policy.
- Exposing private Capability Human/AI/Tool messages to Supervisor.
- Giving Supervisor direct authority to mutate root messages or delegation state.
- Persisting Supervisor raw provider messages across runs.

## Migration

1. Add a run-scoped Supervisor session state and reset it with `runId`.
2. Make its plan the single authoritative replacement for `runCapabilityPlan`;
   use a separate continuation snapshot only when a later run may resume work.
3. Keep disclosure in the session and verify runtime replay for a single proposal.
4. Publish normal result Announces into main before Boundary; remove separate
   result extraction and acceptance-time movement, retaining existing identities.
5. Stop returning Supervisor message updates to root `messages`.
6. Remove Supervisor-lane selection, stale-lane cleanup, and ToolMessage command
   parsing from the agent boundary.
7. Keep raw invocation details in tracing only.
8. Delete the transitional Supervisor-lane implementation after lifecycle and
   recovery evals pass.
9. Apply the Boundary Protocol's native `returnDirect` simplification without
   changing the session schema or introducing another reply/finish command.

## Acceptance criteria

- Entry and Boundary remain the only Supervisor modes.
- One root run owns exactly one Supervisor session.
- Supervisor plan state has exactly one authoritative storage location.
- Plan tasks and prepared disclosure stay stable during execution; normal
  progression changes only the remaining tail, and revisions require user consent.
- Supervisor asks the user directly; answering through continuation retains the
  goal and unfinished work without manufacturing an interrupt.
- Without a plan or delegation, answers use ordinary `entryAnswer`; with an
  active delegation, new user input enters main and reaches Supervisor before
  execution, retaining task ownership and forbidding acceptance without evidence.
- A new run cannot observe the previous run's Supervisor working history or search
  counters.
- Main conversation contains no raw Supervisor transcript; only its final reply
  is projected through the terminal node.
- Boundary identifies current task results from main using existing identities,
  without private result extraction, duplicate result input, or state mutation.
- First and successive Boundaries preserve active task and remaining-plan
  identity according to the selected command.
- Recovery of a committed proposal does not repeat acceptance or dispatch.
- `continue_current` retains prior result messages in main and appends the next
  attempt without assuming cumulative output.
- Its optional future-plan update commits with continuation: omission retains
  existing tasks, while a user-confirmed empty array clears only future tasks.
- Root compaction runs only at new-run entry and retains recent messages plus all
  original Announces for the current unfinished delegation, even outside the
  recent suffix; other old history remains eligible for compaction.
- Boundary Announces expose result evidence without Capability stop reasons.
- Supervisor tracing remains complete after raw provider messages are removed from root
  checkpoint messages.

Tool responsibilities (2026-09-07): `submit_plan` is Entry-only and has no acceptance flag. `accept_result` alone accepts the current task: omit reply to dispatch the established next task, or supply reply to end the run and retain unfinished future work. With no remaining tasks a final reply is required. Both continuation and acceptance may carry an optional user-confirmed future-plan update. Root applies these effects inside its existing `runSupervisor` node.
