# Pet Agent state lifecycle refactor

> Status: design draft. Phases 1–4 have landed in code.
> Scope: `packages/pet-agent` orchestrator state naming, lifecycle boundaries, and the delegation handoff loop.
> Update 2026-07: the naming contract in §2 is extended by
> `docs/PET_AGENT_DELEGATION_STATE_AND_TASK_ROUTING.md` (issues #274/#308), which renames
> `runPendingDelegation` → `runNextDelegation` and `runDelegations` → `runDelegationSummaries`,
> deletes `canHandoffActiveDelegation` (derived value, not state) and `runPendingFinalReply`
> (route signal replaced by Command goto + derived answer routing), and adds `runPendingTask`.
> That doc is authoritative for those fields; the lifecycle prefix rules in §1 remain
> canonical here.

## 1. Fixed terminology

Use three product-level lifecycles in code and docs:

| Lifecycle | Meaning | Code prefix |
|---|---|---|
| session | The checkpointed conversation lifetime. It owns transcript, cross-task artifacts, and thread-scoped authorization. | `session*` |
| task | A user goal lifecycle. It may span multiple runs because the agent can ask, interrupt, resume, or wait for more user input. | `task*` |
| run | One execution loop triggered by one user input or resume, until the graph returns, asks, interrupts, or finishes. | `run*` |

Do not use `trace*` for task lifecycle state. `trace` is overloaded with observability terminology. If we need LangSmith trace identity later, call it `observabilityTraceId` or another explicit observability name.

Do not use `turn*` for orchestrator state. A chat turn sounds like a single user/assistant exchange, while our `run` is an execution loop that can contain multiple LLM calls, tool calls, subagent calls, and graph nodes.

### External terminology note

LangGraph persistence centers on a checkpoint `thread_id`, which stores graph state snapshots for resume, interrupt, time travel, and fault tolerance. LangGraph interrupts resume with the same `thread_id` and restart the interrupted node from the beginning.

LangSmith observability uses `thread`, `trace`, and `run` differently: a thread groups traces, a trace is an observed operation, and a run is a span/unit of work. That is not the naming model for our product state.

References:

- https://docs.langchain.com/oss/javascript/langgraph/checkpointers
- https://docs.langchain.com/oss/javascript/langgraph/interrupts
- https://docs.langchain.com/langsmith/observability-concepts

## 2. Naming contract

All orchestrator state channels should carry their lifecycle prefix except the LangGraph message channel:

| Current name | Target name | Lifecycle | Notes |
|---|---|---|---|
| `messages` | `messages` | session | Keep this unprefixed because LangGraph prebuilt message utilities and `ToolNode` expect a `messages` key. Treat it as `sessionMessages` semantically in comments and docs. |
| `capabilityArtifacts` | `sessionCapabilityArtifacts` | session | Cross-run artifact ref index. Never reset at run start. |
| `toolAuthorizations` | `sessionToolAuthorizations` | session | Thread-scoped authorization state. Never reset at run start. |
| none | `taskActiveDelegation` | task | The single source of truth for an unfinished delegation. Not reset at run start. |
| `runPendingDelegation` | `runNextDelegation` | run | Transient route command from decision/route to `general` or `capability`. Reset at run start and cleared after the execution node consumes it. |
| `runPendingFinalReply` | `runPendingFinalReply` | run | Transient route signal from decision to `answer` or end. Reset at run start. |
| `runCapabilitySearchState` | `runCapabilitySearchState` | run | Discovery/search scratchpad for this run. Reset at run start. |
| `runDelegations` | `runDelegationSummaries` | run | Per-run prompt/debug summary only. It must not be used as unfinished task state. |
| `runIterationCount` | `runIterationCount` | run | Loop guard for the current run. Reset at run start. |
| `runId` | `runId` | run | Current execution loop id. Do not use it as the long-lived task transcript id. |
| `canHandoffActiveDelegation` | delete | — | Derived from `taskActiveDelegation` + `messages`; evaluate the guard in decision context instead of storing it in state. |
| none | `runPendingTask` | run | Planned task-first routing command; introduced by the later task → search → route pipeline. |
| `buildRunStateReset` | `buildRunStateReset` | run | Resets only `run*` fields. |
| `buildOrchestratorRunInput` | `buildOrchestratorRunInput` | run | Add a temporary compatibility alias if external callers still import the old name. |

Type names should follow the same rule:

| Current type | Target type |
|---|---|
| `RunDelegation` | `RunDelegationSummary` |
| `RunPendingDelegation` | `RunNextDelegation` |
| `RunFinalReplyRoute` | `RunFinalReplyRoute` |
| `RunCapabilitySearchState` | `RunCapabilitySearchState` |
| none | `TaskActiveDelegation` |

## 3. Current state audit

Current `OrchestratorState` mixes session, task, and run lifecycles:

```ts
messages
runPendingDelegation
runPendingFinalReply
capabilityArtifacts
runCapabilitySearchState
runDelegations
runIterationCount
runId
toolAuthorizations
```

Field-by-field classification:

| Field | Actual lifecycle | Current problem | Refactor action |
|---|---|---|---|
| `messages` | session | It stores main transcript and lane transcript together. Some code also derives control flow from lane announces. | Keep as storage. Do not use lane announce presence as the normal lifecycle control source. |
| `capabilityArtifacts` | session | Correctly not reset today, but name has no lifecycle prefix. | Rename to `sessionCapabilityArtifacts`. |
| `toolAuthorizations` | session | Correctly not reset today, but name has no lifecycle prefix. | Rename to `sessionToolAuthorizations`. |
| `runPendingDelegation` | run | Correct lifecycle, unclear name. | Rename to `runPendingDelegation`. |
| `runPendingFinalReply` | run | Correct lifecycle, unclear name. | Rename to `runPendingFinalReply`. |
| `runCapabilitySearchState` | run | Correct lifecycle, unclear name. | Rename to `runCapabilitySearchState`. |
| `runIterationCount` | run | Correct lifecycle, unclear name. | Rename to `runIterationCount`. |
| `runId` | run | It is currently also used to scope lane transcript and handoff. That breaks task continuation across later runs. | Rename to `runId`; add `taskActiveDelegation.transcriptRunId` for stable delegation transcript scope. |
| `runDelegations` | mixed | It is reset as run state but used as if it represented unfinished delegation lifecycle. This is the root lifecycle bug. | Split responsibilities: `runDelegations` for this run summary; `taskActiveDelegation` for unfinished delegation lifecycle. |

Related derived helpers:

| Helper | Current role | Refactor action |
|---|---|---|
| `readInFlightAnnounceLanes(messages)` | Derives unfinished delegation candidates from lane-tagged announces. | Stop using it for control flow. It can remain as a context recall helper only if needed. |
| `laneMessages(messages, lane, runId, delegationId)` | Reads a delegation transcript using current `runId`. | Use `taskActiveDelegation.transcriptRunId` for an active task, or eventually narrow by `delegationId` if we remove turn/run transcript scoping. |
| `buildSubagentHandoff({ lane, runId, delegationId })` | Handoffs by lane + current run id + delegation id. | Handoff by `taskActiveDelegation.lane`, `taskActiveDelegation.transcriptRunId`, and `taskActiveDelegation.id`. |

## 4. Target state shape

```ts
type TaskActiveDelegation = {
  id: string;
  lane: MessageLane;
  task: string;
  contextSummary: string | null;
  transcriptRunId: string;
  status: 'pending' | 'awaiting_decision';
  resultPreview: string | null;
};

type RunPendingDelegation = {
  id: string;
  lane: MessageLane;
  task: string;
  contextSummary: string | null;
};

type RunDelegation = {
  id: string;
  lane: MessageLane;
  task: string;
  status: DelegationStatus;
  resultPreview: string | null;
};

const OrchestratorState = Annotation.Root({
  // session lifecycle.
  // Kept as `messages` for LangGraph compatibility; semantically this is the
  // session transcript and lane-backed transcript storage.
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),
  sessionCapabilityArtifacts: Annotation<CapabilityArtifactRef[]>({
    reducer: (prev, next) => mergeCapabilityArtifactRefs(prev, next),
    default: () => [],
  }),
  sessionToolAuthorizations: Annotation<ToolAuthorizationRecord[]>({
    reducer: (prev, next) => mergeToolAuthorizations(prev, next),
    default: () => [],
  }),

  // task lifecycle.
  taskActiveDelegation: Annotation<TaskActiveDelegation | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),

  // run lifecycle.
  runPendingDelegation: Annotation<RunPendingDelegation | null>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  runPendingFinalReply: Annotation<RunFinalReplyRoute>({
    reducer: (_prev, next) => next,
    default: () => null,
  }),
  runCapabilitySearchState: Annotation<RunCapabilitySearchState>({
    reducer: (_prev, next) => next,
    default: buildEmptyRunCapabilitySearchState,
  }),
  runDelegations: Annotation<RunDelegation[]>({
    reducer: (_prev, next) => next,
    default: () => [],
  }),
  runIterationCount: Annotation<number>({
    reducer: (_prev, next) => next,
    default: () => 0,
  }),
  runId: Annotation<string>({
    reducer: (_prev, next) => next,
    default: () => '',
  }),
});
```

`buildRunStateReset()` must only return `run*` fields:

```ts
type OrchestratorRunState = Pick<
  OrchestratorStateType,
  | 'runNextDelegation'
  | 'runPendingTask'
  | 'runPendingFinalReply'
  | 'runCapabilitySearchState'
  | 'runDelegationSummaries'
  | 'runIterationCount'
  | 'runId'
>;
```

It must not return or clear:

- `messages`
- `sessionCapabilityArtifacts`
- `sessionToolAuthorizations`
- `taskActiveDelegation`

## 5. Delegation lifecycle

The system supports one active delegation at a time.

### Start delegation

When `routeDecision` chooses `general` or `capability.<name>` for `runPendingTask`:

1. Create `runNextDelegation`.
2. Create or update `taskActiveDelegation`.
3. Set `taskActiveDelegation.transcriptRunId` to the current `runId` when the task starts.

```ts
taskActiveDelegation = {
  id: runNextDelegation.id,
  lane: runNextDelegation.lane,
  task: runNextDelegation.task,
  contextSummary: runNextDelegation.contextSummary,
  transcriptRunId: state.runId,
  status: 'pending',
  resultPreview: null,
};
```

### Subagent returns

When `generalNode` or `capabilityNode` returns:

1. Append lane messages tagged with `taskActiveDelegation.transcriptRunId`.
2. Clear `runNextDelegation`.
3. Set `taskActiveDelegation.status = 'awaiting_decision'`.
4. Store `resultPreview`.
5. Increment `runIterationCount`.

### Outcome decision

When `delegationOutcomeDecision` runs:

- `finish`: handoff the active delegation into the main queue, clear `taskActiveDelegation`, set `runPendingFinalReply = 'answer'`.
- `ask_user`: emit the inline question, keep `taskActiveDelegation`, end the current run.
- `delegate_*` same lane: reuse `taskActiveDelegation.id` and `transcriptRunId`, set `runNextDelegation`, continue the same task.
- `delegate_*` different lane: first handoff or explicitly abandon the current active delegation, then create a new `taskActiveDelegation`. Silent overwrite is not allowed.

## 6. Routing model

The graph entry route should depend on explicit task state, not lane announce storage:

```ts
function afterContextPrep(state: OrchestratorStateType) {
  if (state.taskActiveDelegation?.status === 'awaiting_decision') {
    return 'delegationOutcomeIterationGuard';
  }
  return 'taskDecision';
}
```

Graph shape:

```text
START
  -> prepare
  -> compactContext
  -> afterContextPrep
       -> delegationOutcomeIterationGuard -> delegationOutcomeDecision
       -> taskDecision -> capabilitySearch -> routeDecision
```

This keeps `buildRunStateReset()` simple: run state can be cleared before routing, while task state remains available to decide whether an unfinished delegation must be judged.

## 7. Handoff model

Handoff must use `taskActiveDelegation`, not `runDelegations` and not a scan of lane announces:

```ts
const active = state.taskActiveDelegation;
if (active && decision.action === 'finish') {
  const handoffMessages = buildSubagentHandoff({
    messages: state.messages,
    lane: active.lane,
    runId: active.transcriptRunId,
    delegationId: active.id,
  });
  return {
    messages: handoffMessages ?? [],
    taskActiveDelegation: null,
    runPendingFinalReply: 'answer',
  };
}
```

`buildSubagentHandoff` can keep its `runId` parameter during the first implementation pass, but callers should pass `active.transcriptRunId`. A later cleanup can rename the parameter to `transcriptRunId`.

## 8. Migration plan

### Phase 1: Add lifecycle names and task state

- Add `TaskActiveDelegation`.
- Add `taskActiveDelegation` state channel.
- Rename run fields in code:
  - `runPendingDelegation` -> `runPendingDelegation`
  - `runPendingFinalReply` -> `runPendingFinalReply`
  - `runCapabilitySearchState` -> `runCapabilitySearchState`
  - `runDelegations` -> `runDelegations`
  - `runIterationCount` -> `runIterationCount`
  - `runId` -> `runId`
- Rename reset helpers:
  - `buildRunStateReset` -> `buildRunStateReset`
  - `buildOrchestratorRunInput` -> `buildOrchestratorRunInput`
- Keep temporary compatibility exports for old helper names if downstream packages still import them.

### Phase 2: Make task state authoritative

- On delegate decision, write `taskActiveDelegation`.
- On subagent return, update `taskActiveDelegation.status = 'awaiting_decision'`.
- Route from `compactContext` to `delegationOutcomeDecision` when `taskActiveDelegation` is awaiting decision.
- Stop using `readInFlightAnnounceLanes` to decide whether a delegation is unfinished.

### Phase 3: Move handoff to task state

- Handoff only the current `taskActiveDelegation`.
- Clear `taskActiveDelegation` only on finish, explicit cancel, or explicit replacement.
- Keep `runDelegations` as per-run prompt/debug context, or delete it if prompts can use `taskActiveDelegation` plus recent announces.

### Phase 4: Rename session fields

- Rename `capabilityArtifacts` -> `sessionCapabilityArtifacts`.
- Rename `toolAuthorizations` -> `sessionToolAuthorizations`.
- Update prompts, toolkit contexts, artifact selectors, and tests.
- Add a checkpoint compatibility strategy before merging if existing persisted checkpoints must survive the rename.

## 9. Checkpoint compatibility

Renaming LangGraph state channels changes checkpoint keys. Before merging into a branch that must read existing checkpoints, choose one of these approaches:

1. Compatibility window: keep old and new channels for one release and copy old values into new names in `prepare`.
2. One-shot migration: migrate persisted checkpoint rows/files outside the graph.
3. No migration: acceptable only for WIP branches or local test checkpoints.

Do not rename `messages` in this refactor. LangGraph prebuilt `ToolNode` accepts `BaseMessage[]` or `{ messages: BaseMessage[] }`, so renaming the message channel would require replacing or wrapping prebuilt nodes and stream conventions. Keep the key and document it as session-scoped.

## 10. Tests

Required tests:

- `buildRunStateReset()` clears only `run*` fields and preserves `taskActiveDelegation`.
- A state with `taskActiveDelegation.status === 'awaiting_decision'` enters `delegationOutcomeDecision` on the next run.
- `ask_user` keeps `taskActiveDelegation` and the next user input resumes outcome decision.
- Same-lane continuation reuses `taskActiveDelegation.id` and `transcriptRunId`.
- Different-lane continuation cannot silently overwrite `taskActiveDelegation`.
- `finish` handoffs the active delegation into the main queue, clears lane messages for that delegation, and clears `taskActiveDelegation`.
- The answer node can reproduce the full subagent result from the main queue after handoff.
- `runDelegations` reset does not lose unfinished delegation lifecycle.
- Capability search state is reset per run.
- Session artifacts and session authorizations are not reset per run.

Regression tests for the PR 248 failure mode:

- A lane announce alone is not required to route into `delegationOutcomeDecision`.
- Clearing run state at the beginning of a run does not prevent an unfinished delegation from being judged.
- The test that used to hang under Node 20 should assert handoff/main-queue state instead of expecting stale lane announce state.

## 11. Non-goals

- Do not redesign capability artifact storage.
- Do not change subagent stop reason semantics.
- Do not introduce multiple concurrent delegations.
- Do not rename the LangGraph `messages` channel in this pass.
