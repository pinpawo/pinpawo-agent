# Entry Answer routing draft

Status: working design for issue #662.

## Goal

The root orchestrator should decide whether a fresh user request can be answered
from the existing conversation before starting planning. It must not ask a model
to rewrite the request into a second, potentially divergent goal.

The exact latest textual `HumanMessage` seeds the run boundary stored as
`runUserRequest`. Entry Answer may resolve a continuation utterance against the
conversation when it calls `plan_request`. The resulting value remains available
to Supervisor, Capability execution, terminal finalization, interruption, resume,
and boundary decisions for the lifetime of the run.

## Flow

```text
prepare -> compactContext -> captureUserRequest -> Entry Answer
                                                  | normal AI text -> END
                                                  ` plan_request -> Supervisor
Supervisor -> Capability / terminal finalization
```

`captureUserRequest` is deterministic. It reads the latest main-conversation
`HumanMessage`, preserves its text exactly, and initializes the fresh-run plan
state.

Entry Answer is a small `StateGraph` built from a model node and LangGraph's
standard `ToolNode`. The model receives the normal main conversation with one
control tool bound:

```ts
plan_request({ goal })
```

A normal model response is the user-visible reply and ends the run. Calling
`plan_request` returns `Command.PARENT` with a `Send` to the root
`runSupervisor` node. `goal` resolves references such as “继续” against the
conversation; it does not contain a plan, execution steps, or framework policy.

## Ownership boundaries

Entry Answer owns only:

- replying from information already present in the conversation;
- asking the user for missing information;
- deciding that execution requires Supervisor.

Supervisor owns Capability discovery, task formation, execution ordering, and
terminal planning outcomes. Terminal finalization turns those outcomes into a
user-visible reply and clears run-scoped state. It does not bind `plan_request`.

The routing transition lives in the tool's returned `Command`, not in
`wrapToolCall`, response-text parsing, or a separate `isPlanRequest` predicate.

## Message and stream invariants

- `runUserRequest` is the user's request, not generated model text.
- The Supervisor receives `runUserRequest` plus the canonical main conversation.
- The Entry Answer model's `plan_request` AI message and matching `ToolMessage`
  remain private to the child graph and are not persisted in root messages.
- Entry Answer text is buffered by the stream adapter and projected as the main
  assistant reply only after root state accepts that message. Text attached to
  a `plan_request` response is discarded.
- Entry Answer control-tool lifecycle events are not projected as user-visible
  Toolkit operations.
- Existing active-delegation resume and supersede paths bypass fresh Entry
  Answer routing and retain their established lifecycle semantics.

## Checkpoint compatibility

This is an intentional state-contract change. Old checkpoints containing the
previous generated-goal state are not migrated. Current checkpoint validation
fails closed rather than reconstructing an approximate request.

## Validation

Behavior tests cover direct reply, Supervisor routing, exact request preservation,
and absence of control messages in canonical root state. Model evals cover a
conversation follow-up that should be answered directly, clarification, and a
repository task that must call `plan_request`.
