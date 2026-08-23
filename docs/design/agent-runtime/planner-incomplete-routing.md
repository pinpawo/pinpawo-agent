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

`PlannerCommit` remains the sole model-to-graph control protocol. If a provider
returns ordinary text instead of any tool call, the runner keeps that authentic
Planner output, returns `plannerStatus: 'incomplete'`, and routes to Answer.
The text is presented to Answer as low-authority blocked-context evidence; it
does not synthesize a terminal tool message or choose a Capability.

Capability disclosure is a bounded phase policy rather than a retry middleware
or dynamic tool-binding policy. Search observations are written by the tool
with `Command.update` and merged by a dedicated graph-state reducer; middleware
does not scan messages to count searches. The default maximum is two wholly
empty model rounds and is configurable through `capabilityPlannerMaxSearchRounds`:

```text
exploration=open, empty_rounds_used=0, remaining_empty_rounds=2
  -> optional capability_search batch
  -> if the whole batch misses: result declares exploration=open,
     empty_rounds_used=1, remaining_empty_rounds=1
  -> choose a terminal action now, or issue one more search batch
  -> if the next whole batch also misses: result declares exploration=closed,
     empty_rounds_used=2, remaining_empty_rounds=0
  -> later capability_search attempts remain callable with tool_choice=auto
  -> the tool returns a stable limit result without disclosing more documents
```

Parallel search calls in one model response form one disclosure batch. A match
in any call means that batch does not consume an empty-search round; repeated
calls after closure do not change the state.

General is loaded once as the verified default Capability and is excluded from
the `capability_search` index. Search therefore discloses only specific
Capability documents and never spends the document budget redisclosing General.
The final tool result is assembled once inside the state-aware search tool from
a typed registry result; middleware does not parse and rewrite a JSON tool
message after execution.

The result supplies disclosed specific candidates, explicit remaining-round
state, and mode-specific planning guidance. An applicable disclosed specific
Capability takes precedence over General. A literal match is not proof of
applicability: the complete document must positively authorize the unfinished
task, and a term appearing only in negative or limiting text does not increase
the candidate's priority. When the first literal search misses, the result
discloses a bounded catalog of exact specific Capability names and defers
General while another search round remains; the next round can use one of those
names to retrieve the complete document. Boundary mode excludes the active
Capability from this catalog, so completed work is not reintroduced merely by
name while a newly required executor remains discoverable. The Planner never
has to consume all rounds: it should commit as soon as the candidates are
sufficient.

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
