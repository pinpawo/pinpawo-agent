# EntryDecision Result-Boundary Draft

Status: experimental. This document is outside the wiki and is not an accepted
runtime contract. Ingest only after the production prompt passes the agreed eval
profile.

## Problem

`entryDecision` must choose `answer`, `direct_task`, or `needs_plan` without
depending on a fixed list of operations. Natural questions about a repository,
an issue, or a deployment can require execution even when the user does not say
“query” or “check.”

Two earlier abstractions were not useful enough for the model:

- “sufficient context” leaves the decision criterion undefined;
- “current cognition” can include model knowledge, inference, and guesses, while
  the runtime needs to distinguish an observed or completed result from an
  intention.

The working distinction is therefore expressed with ordinary run concepts:
user purpose, main-conversation result, task, and plan.

## Current candidate

The decision order is:

1. If ambiguity would materially change the result or consequence, use
   `answer` to ask the user.
2. Decide whether completing the purpose first requires a result that is not yet
   in the main conversation.
   - A result about actual content or current state must match the requested
     object, scope, and time.
   - A requested real-world change requires a corresponding completion result.
   - Intentions, plans, and in-progress descriptions identify an action stage,
     not a completed result.
3. If another result is required, choose one directly executable task or prior
   planning. Otherwise use `answer`.

The production wording remains intentionally shorter than this explanation.
The schema describes only the three output choices.

## Eval controls

The entry profile uses natural user wording rather than verbs that reveal the
expected route. Its paired controls include:

- a commit-status answer backed by an explicit completion result versus a
  request grounded in the repository's current state after only an intention;
- stable conceptual knowledge versus a current remote state;
- current local state, stale deployment state, artifact calculation, and a
  completed conversational result;
- one task versus result-dependent or independent multi-task work.

## Experiment log

1. Purpose/commitment wording: full GLM-5.2 profile achieved 31/36 goals. The
   intention case achieved 0/3 with one evaluator timeout; the remote-state case
   achieved 1/3.
2. Language-result versus reality-result explanation: both failed cases remained
   0/3.
3. “Current cognition” boundary: stable conceptual knowledge achieved 3/3, but
   the intention and remote-state cases remained 0/3. The term was removed
   because it can diverge from the supplied conversation and runtime results.
4. Missing-result wording with generic action descriptions: stable knowledge
   achieved 3/3; the intention and remote-state cases remained 0/3.
5. Result-based schema descriptions: stable knowledge achieved 3/3, intention
   remained 0/3, and remote state achieved 1/3.
6. Executable-first enum order: stable knowledge remained 3/3 and remote state
   improved to 3/3; the intention case remained 0/3.
7. The original intention question also admitted a conversational answer:
   “not yet; the preceding message only states a plan.” The paired completion
   and intention cases now use the same reality-grounded wording without naming
   an operation. Completion achieved 2/3 and intention achieved 2/3; stable
   knowledge and remote state each achieved 3/3.
8. Current candidate: explicitly identifies a matching observation or completion
   in the main conversation as an existing reply result. Completion and stable
   knowledge achieved 3/3, intention remained 0/3, and remote state achieved
   1/3. The earlier improvement was not stable.
9. Function calling routed intention 3/3 and produced direct tasks on all three
   remote-state runs, but over-verified completion 3/3; one remote judge call
   failed independently.
10. Current candidate: remove the artificially identical wording from the
    completion/intention pair. Completion asks about the explicit result already
    shown; intention and remote state explicitly ask for current reality without
    naming an operation. The four-case profile achieved 11/12; an additional
    remote-state run achieved 3/5, confirming a remaining stability gap.
11. Current candidate: state directly that actual content and current state use
    only matching results in the main conversation. The four-case profile fell
    to 8/12, so this wording was rejected and removed.
12. Current candidate: return to the best result wording and test whether three
    explicit structured-output branches are more stable than one enum plus
    optional task fields. The profile achieved 9/12, so the union was rejected
    and removed.
13. The clarified four-case profile achieved 12/12 with `functionCalling`,
    while `jsonMode` remained unstable on the same boundaries. The earlier
    function-calling run used the ambiguous reality-grounded completion
    question, so it is not evidence for the clarified profile.
14. The full 13-case entry profile then achieved 37/39 with `functionCalling`.
    All result-availability controls achieved 3/3, including stable knowledge,
    explicit completion, intention without completion, current local and remote
    state, stale state, and calculation. There were no schema, invocation, or
    evaluator errors.
15. The only unstable case was explore-before-implementation: one run selected
    `needs_plan`, while two selected a directly executable exploration task.
    This is a planning-boundary edge rather than a regression in the
    result-availability distinction targeted by this draft. It remains visible
    in the eval instead of being reclassified solely to make the profile pass.

## Current conclusion

The GLM-5.2 result supports the candidate's core boundary:

- stable knowledge and matching completion evidence route to `answer`;
- current-state questions without a matching result form a task;
- intentions are not treated as completion results;
- the prompt does not introduce operation inventories or case-specific nouns.

The 37/39 profile is sufficient evidence for this result-boundary iteration.
It is not evidence that every planning boundary is settled. The
explore-before-implementation case remains a known edge: `needs_plan` preserves
the later implementation objective, while `direct_task` treats exploration as
the only currently materializable task.

## Before wiki ingestion

- Decide how the production runtime selects the structured-output method;
  `functionCalling` and `jsonMode` are not behaviorally interchangeable on the
  tested GLM-5.2 profile.
- Keep the planning-boundary edge explicit or evaluate it separately; do not
  silently redefine its expected result.
- Run the agreed complete prompt profile after the production inference path is
  aligned.
- Confirm local type checks, contract tests, and the full pet-agent test suite.

Until those steps are complete, this file remains the experiment record and the
wiki is unchanged.
