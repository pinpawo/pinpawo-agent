# Planner Non-Commit Routing Draft

Status: draft

## Problem

`general` is a default fallback candidate exposed to the Capability Planner. It is
not an authorization for the runtime to invent a task or claim that the
Planner selected it. Likewise, `unavailable` is a model commit meaning that no
available Capability can form an executable plan; it must not stand in for a
malformed or missing Planner commit.

Treating a missing terminal tool call as either action creates three false
facts:

1. the graph executes work that the Planner never committed;
2. the Planner transcript contains a ToolMessage without its corresponding AI
   tool call; and
3. Answer receives `capability_unavailable` when the actual failure was a
   Planner protocol non-commit.

## Decision

The Planner runner reports one of two typed results:

```ts
type CapabilityPlannerResult =
  | PlannerCommit
  | {
      plannerStatus: 'incomplete';
      reason: 'terminal_commit_missing';
      messageUpdates?: BaseMessage[];
    };
```

`PlannerCommit` remains the sole model-to-graph control protocol. The runner
does not retry an ordinary-text completion. If the model does not commit it
returns `plannerStatus: 'incomplete'`; it does not synthesize a terminal tool
message or choose a Capability.

Capability disclosure is a bounded phase policy rather than a retry
middleware or tool-call counter. The default maximum is two model rounds and
is configurable through `capabilityPlannerMaxSearchRounds`:

```text
exploration=open, rounds_used=0, remaining_rounds=2
  -> optional capability_search batch
  -> result declares exploration=open, rounds_used=1, remaining_rounds=1
  -> choose a terminal action now, or issue one more search batch
  -> result declares exploration=closed, rounds_used=2, remaining_rounds=0
  -> next model call binds terminal tools only with tool_choice=required
```

Parallel search calls in one model response form one disclosure batch and count
as one round. The result supplies the disclosed candidates, the verified
default fallback (when present), its lower selection priority, and explicit
remaining-round state. An applicable disclosed specific Capability takes
precedence over General; General becomes eligible only after the Planner judges
every disclosed specific candidate unsuitable. A literal match is not proof of
applicability: the complete document must positively authorize the unfinished
task, and a term appearing only in negative or limiting text does not increase
the candidate's priority. When the first literal search misses, the
result discloses a bounded catalog of exact specific Capability
names and defers General while another search round remains; the next round can
use one of those names to retrieve the complete document. Boundary mode excludes
the active Capability from this catalog, so completed work is not reintroduced
merely by name while a newly required executor remains discoverable. The
Planner never has to consume all rounds: it should commit as soon as the
candidates are sufficient.

The root Capability Planner node owns the recovery route:

```text
Planner incomplete
  -> preserve authentic Planner transcript
  -> do not materialize a delegation
  -> Entry clears the empty plan; Boundary preserves the committed remaining plan
  -> set planner_incomplete route outcome
  -> Answer
```

Answer renders this as a distinct blocked reason. It can truthfully explain
that the requested execution did not start because planning did not complete,
without asserting that no Capability exists or that work was done. Its cleanup
preserves the remaining plan only when `planner_incomplete` still has an active
delegation; all other Answer routes continue to clear transient plan state.

## Invariants

- `general` is selectable only through a real `submit_plan` or `advance_plan`
  commit validated against the current workspace.
- A persisted terminal ToolMessage always corresponds to an AI tool call that
  appeared in the Planner lane.
- `unavailable` remains a real Planner action, not generic error handling.
- A non-commit never accepts an active delegation or marks it complete.
- A Boundary non-commit never discards the committed remaining plan.
- Planner limits and timeouts remain operational errors until they receive
  their own typed recovery contract; this change narrows only the successful
  model completion-without-commit path.

## Validation

- Entry: two successful search rounds, ordinary text -> typed incomplete -> Answer;
  no Capability execution and no repair model call.
- Boundary: ordinary text after a delegation -> typed incomplete -> Answer;
  active delegation is not accepted as completed and its remaining plan survives.
- Genuine `submit_plan`, `advance_plan`, and `report_unavailable` retain their
  existing graph behavior and transcript replay semantics.
