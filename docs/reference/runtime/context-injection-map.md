# Context Injection Map

> **Status: current implementation guide.** This page maps where the runtime
> assembles model context. For exact schemas and behavior, follow the source
> links. The [earlier context map](https://github.com/pinpawo/pinpawo-agent/blob/29f0bec9094a0be57ed48f03778ce2a7ccc6ac3d/docs/reference/runtime/context-injection-map.md)
> describes the retired Announce and active-delegation design; it is historical.

Read this before changing what a node sends to its model. Prompt text lives in
[`prompts/templates/`](../../../packages/pet-agent/src/agent/orchestrator/prompts/templates/).
The [Root, Supervisor and Capability design](../../design/agent-runtime/run-scoped-supervisor-session.md)
explains the current state and handoff; it remains a working design under review.

## 1. The two axes

When reviewing model context, distinguish both **lifetime** (what is stable for a
run and what is rebuilt per invocation) and **authority** (instructions, task
boundary, facts, or conversation history). Tool results and summaries are data;
they are not new user instructions. The model-facing format is assembled at the
relevant call site, so source and tests establish the current details.

### Canonical message ownership

Root state holds the main messages and Supervisor work messages. Capability
internal messages stay in the child graph; with a configured checkpointer, they
use its child namespace. Root receives the paired `delegate_capability` tool result. A new delegation is a new execution;
it does not replay a previous child's internal transcript. See
[execution records](../../../packages/pet-agent/src/agent/orchestrator/executionMessages.ts)
and the [state and handoff design](../../design/agent-runtime/run-scoped-supervisor-session.md).

## 2. Graph shape

```text
prepare -> compactContext -> captureUserRequest -> entryAnswer
  entryAnswer -> direct reply / end, or runSupervisor
  runSupervisor -> end, or capability -> delegationBoundary -> runSupervisor
```

A rejected or cancelled review can terminate after Capability execution. Native
review resume follows its checkpoint rather than starting a fresh Entry run.
See the [graph](../../../packages/pet-agent/src/agent/orchestrator/runtime/graph.ts)
and [Capability route](../../../packages/pet-agent/src/agent/orchestrator/runtime/routes/afterCapability.ts).

## 3. Shared building blocks

The role prompt is composed with Host-provided system sections, structured
workdir when present, and execution-specific sections, in that order. Capability
execution sections include selected Toolkit instructions and Capability
instructions. Host sections can include PET.md. Context is supplied again on
resume; it is not reconstructed from conversation history. See
[system prompt composition](../../../packages/pet-agent/src/prompts/systemPrompt.ts),
[Capability execution](../../../packages/pet-agent/src/agent/orchestrator/capabilityExecution/runner.ts),
and [workdir context](workdir.md).

## 4. Node: entryAnswer

Entry sees the main conversation and a projection of the saved Supervisor plan.
It can reply directly, route a new goal through `plan_request`, or choose
`continue` for an unfinished plan. When validated external system sections are
present, it also receives a Capability routing manifest. These are invocation
projections, not a second conversation store. See
[Entry implementation](../../../packages/pet-agent/src/agent/orchestrator/runtime/nodes/entryAnswer.ts).

## 5. Node: runSupervisor

Supervisor receives selected Root history, run context and the current turn. It
can inspect Capability details, plan or adjust work, review a result, delegate
and respond; control validation enforces the applicable state constraints.
Capability deliveries return as paired tool results, not Announce messages.
The actual call/result and execution record are evidence; accepting a plan item
is a separate decision. Run context and turn messages are invocation-only
projections around the selected history. Supervisor work is retained for its
current run; fresh-run preparation removes earlier Supervisor work lanes. See
the [Supervisor agent](../../../packages/pet-agent/src/agent/orchestrator/runSupervisor/agent.ts),
[control middleware](../../../packages/pet-agent/src/agent/orchestrator/runSupervisor/controlMiddleware.ts)
and [execution records](../../../packages/pet-agent/src/agent/orchestrator/executionMessages.ts).

## 6. Node: capability (subagent execution)

For each delegated call, the executor assembles a task briefing, selected Toolkit
instructions and Capability instructions. It exposes only the tools in the
compiled Capability and forwards the parent runtime context and cancellation.
The selected main history must have stable message IDs. The current delegation
briefing is appended to the child input; earlier deliveries are evidence, not
new instructions. A result can contain a delivery or report `missing_deliverable`;
private child messages are not copied into Root as a transcript. See the
[Capability runner](../../../packages/pet-agent/src/agent/orchestrator/capabilityExecution/runner.ts)
and [subagent construction](../../../packages/pet-agent/src/subagent/createSubagent.ts).

## 7. Current node: answer

The current Root graph has no separate `answer` node. Entry and Supervisor can
produce a natural response through their respective paths; the graph routes a
normal Supervisor return to `END`. See the [graph](../../../packages/pet-agent/src/agent/orchestrator/runtime/graph.ts)
and [Supervisor node](../../../packages/pet-agent/src/agent/orchestrator/runtime/nodes/runSupervisor.ts).
This retained heading supports earlier links; it does not prescribe a future node.

## 8. Run request and plan goal

`captureRunUserRequest` seeds the current user request before Entry. Entry can
resolve a new goal through `plan_request` or adopt an unfinished plan through
`continue`. The current `runUserRequest` can be a continuation utterance, while
`runSupervisorState.goal` carries the plan goal across runs; an explicit goal
change can update it through the continuation path. The model's routing choice
is distinct from the state projection. See
[Entry implementation](../../../packages/pet-agent/src/agent/orchestrator/runtime/nodes/entryAnswer.ts)
and [Supervisor state](../../../packages/pet-agent/src/agent/orchestrator/runSupervisor/state.ts).

## 9. Compaction

Root evaluates the watermark on a fresh run before Entry. The compaction effect
retains recent messages and call/result records for unfinished plan items, and
summarizes eligible older messages. This is based on current execution records,
not Announce identifiers. Capability execution keeps its private transcript
and requests a final handoff when its context or model-call budget is reached;
it does not summarize and replace that transcript. A fresh delegation gets a
new execution context. See [subagent budget middleware](../../../packages/pet-agent/src/subagent/budgetMiddleware.ts),
[prepare and compaction](../../../packages/pet-agent/src/agent/orchestrator/runtime/nodes/prepare.ts)
and [compaction implementation](../../../packages/pet-agent/src/agent/orchestrator/contextCompaction.ts).

## 10. Checklist for adding context

1. Identify the receiving model call and the source, lifetime and authority of
   each section.
2. Keep user or tool data distinct from instructions, and avoid persisting
   invocation-only projections as new canonical messages.
3. Check resume, cancellation and compaction behavior when changing context that
   must survive those boundaries.
4. Validate observable behavior and protocol boundaries with relevant tests;
   follow [repository testing guidance](../../../AGENTS.md#testing).
