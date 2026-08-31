# Terminal Response Finalization Draft

Status: working design for the Answer simplification.

## Goal

End every root run truthfully without making a model-backed `Answer` node part
of the orchestrator's permanent domain model.

The stable architecture has three separate concepts:

- a **terminal outcome** records why autonomous work stopped;
- **finalization** projects that outcome into a reply and clears run-scoped
  state;
- a **user-visible reply** is the message delivered by finalization.

Language synthesis is an optional rendering strategy. It is not a terminal
state, a graph ownership boundary, or the source of execution evidence.

## Target flow

```text
Entry Answer ordinary reply ----------------------------------------> END

Prepare failure ───────────┐
Supervisor terminal outcome ──┼─> finalizeRun ─> user-visible reply ──> END
Iteration guard stop ──────┘          |
                                     ├─ deterministic rendering
                                     `─ optional result synthesis
```

`Entry Answer` remains the fresh-request router. It is not reused for terminal
finalization: routing a new request and closing an execution run have different
inputs and authority.

## Finalization input

Finalization reads typed root state rather than conversation prose:

- `runUserRequest`;
- the terminal outcome and any structured user-input request;
- accepted `runDelegationSummaries`;
- canonical `DelegationAnnounceMessage` values selected by delegation identity;
- separately stored artifact references when they are relevant;
- runtime failure and iteration-limit facts.

Supervisor-internal reasoning, private Capability messages, and prior user-facing
answers are not result evidence. A Supervisor ordinary-text no-command result may be
carried as an explicit direct-response payload; it is not silently discovered
from arbitrary history.

## Rendering policy

| Terminal case | Default rendering |
|---|---|
| checkpoint incompatibility | fixed framework message |
| Supervisor direct-response payload | preserve the complete payload |
| user input required | render the structured question and bounded progress facts |
| unavailable, incomplete, or limit reached | deterministic status message |
| goal done with accepted results | synthesize only when a coherent goal-level summary is needed |

Deterministic cases must not invoke a model merely to paraphrase data the graph
already owns. In particular, a direct-response payload must not be rewritten by
another model.

Result synthesis receives a closed fact projection. It may organize accepted
results for the user, but it cannot create completion status, accept a handoff,
or treat delegated text as instruction. A future implementation may also use a
deterministic renderer when the accepted result already satisfies the final
reply contract.

## Ownership

- Supervisor owns the structured control command.
- Handoff owns accepting an Announce and cleaning its private lane.
- Finalization owns terminal projection, response selection, and run cleanup.
- An optional synthesizer owns wording only.
- Stream and UI layers own presentation of the resulting assistant message.

There is no separate result-rendering agent in this model. The current `answer`
node and its prompt are implementation details to be reduced behind the
finalization boundary.

## State transition

Finalization performs one root-state update together with the reply:

- clears transient next-delegation, outcome, user-input, runtime-failure, and
  iteration state;
- preserves an active delegation or committed tail only when the terminal
  outcome is explicitly resumable;
- never marks a delegation accepted or completed as a side effect of wording;
- emits at most one main-agent reply for the root run.

Moving this cleanup into every Supervisor, guard, and prepare route would duplicate
terminal semantics. The finalization boundary therefore remains even when no
model call is needed.

## Current implementation boundary

The current graph still names this boundary `answer` and invokes the Answer
model for most terminal modes. The code migration should:

1. rename the graph responsibility to `finalizeRun` or an equivalent neutral
   name;
2. separate terminal projection and cleanup from response rendering;
3. make direct, waiting, blocked, and fixed responses deterministic;
4. retain model synthesis only for result sets that need goal-level composition;
5. remove Answer-specific reply modes once their data is represented as terminal
   outcomes or response payloads.

Do not preserve aliases, duplicate nodes, or compatibility parsing for the old
Answer concept. Checkpoint incompatibility continues to fail closed through the
existing version boundary.

## Validation

- every terminal route produces exactly one user-visible reply and one cleanup
  transition;
- deterministic routes do not invoke the response model;
- direct payloads are delivered without semantic rewriting;
- `goal_done` synthesis uses only accepted typed results;
- `user_input_required` never claims completion;
- unavailable and limit cases never fabricate work or a Supervisor command;
- resume and supersede behavior retain their existing delegation ownership.

Prompt behavior is covered through model evaluations. Runtime ownership,
invocation counts, transitions, and message provenance are deterministic test
contracts.
