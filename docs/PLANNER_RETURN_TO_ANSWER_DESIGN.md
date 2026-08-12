# Planner Return To Answer

> Status: historical. The `return_to_answer` / `runPlannerReturn` path was removed
> by #619. The private Planner now exposes only `PlannerCommit.action + tasks`;
> see [`PERSISTENT_PRIVATE_PLANNER_REFACTOR_ISSUE.md`](./PERSISTENT_PRIVATE_PLANNER_REFACTOR_ISSUE.md).
>
> Scope: the framework-internal Capability Planner, its graph handoff, and
> Answer invocation context. This document supersedes the statement that the
> Planner has no answer-bound result in the current Planner design documents.

## Problem

`entryDecision` intentionally sends requests that may need tools or new
evidence to the Capability Planner. After reading the Capability Workspace,
the Planner can nevertheless discover that it should not materialize an
execution plan. Typical cases are:

- the available evidence is sufficient for Answer to respond;
- the user must choose between valid approaches before any task can begin;
- the scoped Capability Workspace cannot execute the requested work.

Previously the Planner had only `submit_plan` and `report_unavailable` as
structured terminals. A model that reached one of the first two conclusions
often produced natural language instead. That is not a valid Planner result,
so the parent graph surfaced `submission_required` rather than a useful reply.

## Decision

The Planner has exactly three responsibilities:

1. discover potentially relevant Capabilities through `grep_search`;
2. plan executable tasks and finish with `submit_plan`;
3. stop planning or request user interaction by finishing with
   `return_to_answer`.

Capability documents describe future executors. Their Toolkit names and
instructions do not become Planner actions. The Planner may call only its
declared private tools and does not execute the planned work itself.

The Planner has two structured terminal actions:

```text
submit_plan       -> capability
return_to_answer  -> answer -> END
```

`return_to_answer` is not a user-facing response tool. It hands bounded facts
back to the Answer node, which remains the only owner of the final reply.
Every Planner invocation must call exactly one of the two terminal actions.
Ordinary assistant text is not a structured Planner terminal result; the
runtime compatibility boundary described below prevents such text from
crashing the user-facing run.

```ts
type PlannerAnswerDisposition = {
  /** Why the Planner did not submit an executable plan. Free explanatory text. */
  reason: string;
  /** Facts discovered during planning that Answer may use. */
  context: string;
  /** A requested user choice or missing information, when applicable. */
  question: string | null;
};

type CapabilityPlannerResult =
  | { tasks: CapabilityPlanTask[] }
  | { answer: PlannerAnswerDisposition };
```

`reason` deliberately has no enum. The Planner may encounter valid
no-plan conditions that are not known when the runtime is written. Runtime
validation is limited to type and size bounds; it does not classify the reason.

## Runtime flow

1. The Planner uses its private `grep_search` tool to discover potentially
   relevant Capabilities. Each match contains the complete immutable
   `CAPABILITY.md`, so discovery and reading are one operation.
2. If one exploration returns no candidates, the Planner has enough evidence
   to decide between planning with the available general Capability and
   stopping execution through `return_to_answer`.
3. It calls `submit_plan` if an execution task should begin, otherwise it calls
   `return_to_answer` with `reason`, `context`, and an optional `question`.
4. If the internal Agent loop settles without a valid terminal call but does
   contain new non-empty assistant text, the Planner boundary converts the
   latest such text into `return_to_answer` context with
   `reason="plan direct text"`. The Planner model is invoked only once.
5. `capabilityPlanner` records that disposition in run-scoped state and routes
   directly to `answer`. No lane, active delegation, or continuation is
   created.
6. `answer` receives the disposition as low-authority dynamic facts with
   `reply_mode=planner_return`, then writes the normal canonical assistant
   reply.
7. Answer cleanup clears the transient disposition. The next user message is a
   new request; Entry may use the preceding Answer reply as conversation
   context and decide whether planning is now appropriate.

This is intentionally distinct from a delegated Capability reporting
`user_input_required`: that outcome preserves an existing active delegation
and can later be resumed. A Planner return has no delegated work to resume.

## Safety and failure boundary

A validated terminal tool call remains authoritative. When the model omits the
tool protocol and ends with ordinary text, that text is not emitted directly
to the user: it becomes bounded context for the Answer node, which still owns
the final reply. Historical assistant messages are excluded from this
fallback; only text newly produced by the current Planner invocation is used.

If the invocation has neither a valid terminal result nor new assistant text,
planning fails with `submission_required`. Timeouts remain failures. The
fallback does not force provider `tool_choice` and does not invoke the Planner
model a second time.

The disposition is rendered as dynamic Answer context, not inserted into the
Answer system prompt. It cannot change Answer policy or authorize work.

## Consequences

- `report_unavailable` is folded into `return_to_answer`; Answer explains the
  limitation in its normal voice.
- `runPendingTask` is removed because it represented only the old Planner
  unavailable result. `runPlannerReturn` owns every deliberate no-plan return.
- Planner prompts describe the two terminal actions and never ask the Planner
  to write a final user reply itself.
- `grep_search` returns complete matched Capability documents. The Planner has
  no separate file-view tool or second discovery phase.
- Tests cover plan submission, generic return-to-Answer, and the distinction
  between a Planner return and a resumable delegated `user_input_required`
  outcome.
