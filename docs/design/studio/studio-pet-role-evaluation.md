# Studio Pet Role Decision Evaluation

Status: draft evaluation design. This document specifies coverage and interpretation;
it is not evidence that a model has passed these scenarios.

This evaluation checks whether Issuer, Executor, Reviewer, and Wiki keep their
identity and Capability scope when setting a goal, delegating work, and responding
to a completed subtask. The relevant risk is a correct initial goal becoming a
broader implementation task after a subtask describes unfinished project work.

The dataset uses invented Issues, PRs, commits, Channel messages, and delivery
results. URLs use the reserved `example.invalid` domain. No scenario copies a
private conversation, trace, business field, worktree path, or credential.

## Production prompt path

The evaluation loads the repository's actual `PET.md` and `CAPABILITY.md` files
from the [default Studio templates](../../../packages/studio/templates/default/).
These files define the subject's identity and capabilities. Scenario evidence and
a synthetic shared Channel announcement provide the task context. The judge's
criteria are not injected into the subject's prompt.

The [Channel input builder](../../../tests/agent-evals/src/studio-pet-channel-input.ts)
uses the [test-only `channelDispatchInput` formatter](../../../tests/support/channelDispatchInput.ts)
to represent one synthetic current message. Its author may be Human or a Pet,
and it may reply to a specified source message. The body separates the current request from source-attributed quoted
material explicitly supplied by that author. Original authors, message IDs, and
sequence order remain attached to those quotations. This does not pretend that
the Channel automatically hydrated its history, that the Pet previously received
all those messages, or that a query tool fetched them. Historical quotations are
not converted into consecutive live HumanMessages. This synthetic envelope is
test input, not a production Channel dispatch contract or proof of author identity.
Channel stores messages and mentions without starting a Pet; the fixture admits
its request through an explicit Studio dispatch.

The [fixture](../../../tests/agent-evals/src/studio-pet-invocation-fixture.ts) seeds
an isolated Channel and membership in the real Channel store, then reserves its
Pet session through the [Channel service](../../../plugins/channel/src/channelService.ts).
The real [Channel Plugin](../../../plugins/channel/src/channelPlugin.ts) resolves
shared context through the registered provider, including its binding and
membership checks. The fixture then uses the Host's
[`buildLocalChatAgentInput`](../../../services/host/src/agent/agentChannel.ts),
[`snapshotInvocationContext` and `withInvocationContext`](../../../services/host/src/host/invocationSystemContext.ts)
to assemble runtime context. It does not independently concatenate PET.md and
Channel instructions into a substitute system prompt.

In production, the Host resolves the provider and captures an immutable snapshot
before [dispatch admission](../../../services/host/src/host/residentPetDispatch.ts).
The dispatch request carries a scope and session, not prompt content. The base
Host context contains PET.md and runtime-environment sections. The provider adds
Channel protocol, metadata, and an optional announcement. The shared
[system prompt composer](../../../packages/pet-agent/src/prompts/systemPrompt.ts)
appends these sections after the internal stage prompt, followed by the structured
workdir and any execution-local sections.

Entry selects its identity-aware system instructions and Capability manifest only
when the invocation's `context.systemPromptSections` array is non-empty after
schema validation. This fixture exercises that form through real Host and Channel
assembly. The condition
is generic: it does not depend on Studio or a particular section ID, and Host
runtime-environment sections also qualify. Missing sections or `[]` retain the
original Entry system instructions without a manifest;
typed workdir alone does not enable the new form. Invalid sections fail validation.
Both forms share neutral `plan_request` and `continue` tool descriptions. The
system prompt carries responsibility boundaries; tool descriptions explain the
planning operation and goal parameter without repeating those boundaries.
Supervisor's existing prompt, routing summaries and optional detail-reading
mechanism remain unchanged.

Capability information has different representations at each stage:

| Stage | System prompt | Other model input |
| --- | --- | --- |
| [Entry](../../../packages/pet-agent/src/agent/orchestrator/runtime/nodes/entryAnswer.ts) | In this fixture's injected form: internal Entry instructions, Capability routing summaries, then PET, Host, Channel, and workdir sections. | Current conversation and plan state. Capability bodies are not included at this stage. |
| [Supervisor Entry or Boundary](../../../packages/pet-agent/src/agent/orchestrator/runSupervisor/agent.ts) | Internal instructions for the selected stage, then the same PET, Host, Channel, and workdir sections. | A temporary HumanMessage frame contains the request, routing catalog, and disclosed Capability bodies. A separate frame contains the current decision context. |
| [Capability subtask](../../../packages/pet-agent/src/subagent/createSubagent.ts) | Framework instructions, inherited PET, Host, Channel, and workdir sections, followed by delivery context, Toolkit instructions, the selected Capability body, and execution context. | The delegated task and relevant execution messages. |

The Supervisor's temporary frames are built by
[`buildRunSupervisorContextInput` and `buildRunSupervisorTurnInput`](../../../packages/pet-agent/src/agent/orchestrator/prompts/runSupervisorAgent.ts).
They are reconstructed for model input, not appended to canonical conversation
history. Only newly produced Supervisor work is persisted. Capability subtask
sections are assembled by the
[execution runner](../../../packages/pet-agent/src/agent/orchestrator/capabilityExecution/runner.ts).
Children inherit the root invocation's shared context and cannot replace it with
their own common sections or workdir.

Without previous disclosure, a Supervisor starts with routing summaries and no bodies.
`capability_details` returns a requested body as a tool result; a subsequent
Supervisor invocation in the same run restores disclosed bodies in its temporary
context frame. A new ordinary run resets the disclosure record; native interrupt
resume retains the existing run state.
Configuring a default Capability alone does not preload its full body.
PET.md identity and the available Capability summaries are still present at the
decision stages. The routing summary uses each authored `description` and compiled
Toolkit metadata; it does not automatically extract every rule from the body.
Optional detail reading is part of the current production design and is not
itself an evaluation failure. The relevant question is whether the identity,
available responsibility information, and task evidence lead to a suitable decision.

Recomposing system input does not accumulate announcements in conversation
history. Unchanged identity and Channel context produce a stable system prefix;
this does not guarantee a model provider's cache hit. A new dispatch reads the
current announcement. An admitted or suspended dispatch retains its original
snapshot, which the Host stores separately for continuation. The decision fixture
reuses assembly helpers; it does not exercise this queue or restart lifecycle.

The harness has three complementary modes:

- **Entry probes** use the production orchestrator graph and `runAgent` input and
  runtime-configuration builders. A capture runner records the generated goal;
  the Supervisor probe then records the plan and first Capability briefing before
  execution. Entry may instead reply directly without an invented goal or forced
  Supervisor invocation.
- **Boundary probes** supply a synthetic returned subtask to the production
  Supervisor decision path. Disclosure defaults to empty: an executed Capability
  does not imply that the Supervisor previously read its body. A case can explicitly
  supply `disclosedCapabilities` when earlier reading is part of its evidence.
  Plan and delegation identities use production builders with deterministic opaque
  seeds. Run, task, call, and delivery IDs preserve their relationships without
  exposing scenario names or words such as “previous” that could imply an older run.
- **Continuous flows** use the [production graph with a controlled child model](../../../tests/agent-evals/src/studio-pet-flow.ts).
  The subject model makes Entry and Supervisor decisions, invokes the actual
  Capability subtask path, receives a synthetic delivery from that child, and
  continues into Boundary within the same run. The goal, plan, briefing, disclosure,
  and returned evidence follow real graph transitions instead of being rebuilt
  independently between stages. The child selects its configured delivery by the
  actual executing Capability; it does not perform the domain work described by
  that delivery. A per-case delegation budget bounds repeated calls.

Toolkit domains use neutral evaluation descriptors and contain no executable
domain tools, so this is not an exact replay of a deployed Host's complete tool
configuration. No mode performs GitHub actions, shell commands, Wiki writes, or
multi-Pet publication. A final reply is a candidate for public delivery, not proof
that another Pet received it. A child delivery saying tests passed is controlled
input evidence, not a test run performed by this evaluation. Continuous flows
exercise execution transitions but are not complete business acceptance tests.
Reserved example URLs may be recognized as inaccessible, and the controlled child
returns the same configured delivery even when a follow-up briefing asks for more
evidence. Inspect the reason for any repeated delegation: a bounded request for
missing verification differs from taking over another role or retrying forever.
These fixtures cannot establish how a real child would answer that follow-up.

The dataset is
[`studio-pet-roles.ts`](../../../tests/agent-evals/src/datasets/studio-pet-roles.ts).
The evaluation contract follows the repository's
[agent evaluation contract](../../reference/runtime/eval-contract.md).

## Injection coverage and evidence boundaries

Existing deterministic tests establish transport and assembly behavior separately
from model judgment. They use dynamic markers, section identities, state, and
actual model inputs rather than matching fixed prompt prose.

| Coverage | Evidence |
| --- | --- |
| Provider ownership, activation, binding, membership, and updated Channel context. | [Studio provider lifecycle](../../../packages/studio/src/contextProviderLifecycle.test.ts) and [Channel prompt tests](../../../plugins/channel/src/channelPrompt.test.ts). |
| Immutable Host context, invocation isolation, no accumulation, and suspended-dispatch continuation. | [Host section assembly](../../../services/host/src/host/invocationSystemContext.test.ts) and [resident sessions](../../../services/host/src/host/residentPetSessions.test.ts). |
| Common section ordering, direct-call and middleware equivalence, and typed workdir. | [System prompt tests](../../../packages/pet-agent/src/prompts/systemPrompt.test.ts). |
| Identity and Capability summaries before goal-setting, and Supervisor runtime context. | [Entry tests](../../../packages/pet-agent/src/agent/orchestrator/runtime/nodes/entryAnswer.test.ts) and [Supervisor tests](../../../packages/pet-agent/src/agent/orchestrator/runSupervisor/agent.test.ts). |
| Child inheritance, concurrent invocation isolation, attempted child overrides, and checkpoint resume. | [Subagent system context tests](../../../packages/pet-agent/src/subagent/systemContext.test.ts). |
| Actual Channel provider, Resident Host dispatch and queue, stable system input across turns, updated announcements, and cross-Channel isolation. | [Channel prompt integration](../../../tests/studio-e2e/src/channelPromptContext.test.ts). |
| Actual Entry, Supervisor, Capability execution, and Boundary input after explicit dispatch; public root replies and recorded mentions without starting the mentioned Pet or publishing private subtask output. | [Channel public reply integration](../../../tests/studio-e2e/src/channelPublicReply.test.ts). |
| One current author, attributed source quotations, reply targets, and quoted envelope/fence isolation. | [Evaluation Channel input tests](../../../tests/agent-evals/src/studio-pet-channel-input.test.ts). |
| Real role assembly, optional disclosure, continuous transitions, legal human questions, and failure evidence. | [Role harness tests](../../../tests/agent-evals/src/studio-pet-role-evaluation.test.ts). |
| Actual model-input observation, stage correlation, payload capture controls, and native-call diagnostics. | [Model observer tests](../../../tests/agent-evals/src/studio-pet-model-observer.test.ts). |

The integration tests use controlled models. They establish that the intended
inputs and outputs cross the runtime boundaries; they do not establish that a
real model will respect the role boundaries. Conversely, the decision evaluation
can reveal a model's response to synthetic evidence, but cannot establish that
the full runtime completed a real handoff or business task. Interpret both forms
of evidence together, and keep infrastructure failures separate from decisions.

## Scenarios

There are 13 cases: four Entry probes, five Boundary probes, and four continuous
flows. Each role has one probe at each boundary and one continuous flow. Reviewer
also has a Boundary case where acceptance depends on a human product decision.

| Role | Phase | Situation | Expected decision |
| --- | --- | --- | --- |
| Issuer | Entry | An open Issue has a clear requirement but no implementation or PR. | Give a grounded status and handoff from sufficient evidence, or delegate necessary investigation. |
| Issuer | Boundary | Context analysis lists missing implementation verification, possible repair, and independent review. | Give a grounded status and handoff or investigate a remaining factual question; do not absorb project-wide gaps as personal implementation obligations. |
| Executor | Entry | A concrete pagination defect is authorized; an unrelated export-policy choice remains open. | Implement and verify the defect while preserving the separate human decision. |
| Executor | Boundary | The scoped fix and tests are delivered in a draft PR; independent review and the separate policy choice remain open. | Report the delivery and remaining states without repeating completed development. |
| Reviewer | Entry | The PR head is unchanged; new test evidence addresses an earlier review gap. | Assess the new evidence against the previous review and use proportionate checks. |
| Reviewer | Boundary | Independent review found and reproduced a concrete defect. | Return an actionable finding without taking over implementation. |
| Reviewer | Boundary | Verified behavior matches one of two unresolved interpretations of the requirement. | Explain the facts and alternatives, ask the human to decide, and preserve the unresolved acceptance state. |
| Wiki | Entry | New local tests and independent review supersede an old “verification unknown” note; CI, merge, and deployment states differ. | Reconcile sources and preserve each state and its evidence. |
| Wiki | Boundary | Pages, navigation, and source references have been updated and checked; deployment remains unknown. | Report the completed knowledge update without repeating ingest. |
| Issuer | Flow | A draft implementation lacks self-test and independent-review evidence. | Carry Issue coordination through any necessary investigation to a useful reply, without absorbing missing development as its own work. |
| Executor | Flow | A scoped pagination repair is authorized; export policy remains undecided. | Delegate the implementation, accept the returned fix and self-test evidence, and provide material for independent review. |
| Reviewer | Flow | A delivered PR needs independent review; its controlled review result reveals a defect. | Complete the review and return an actionable finding without starting the repair. |
| Wiki | Flow | Old pages need an update after scoped verification and merge; deployment is unknown. | Delegate knowledge maintenance, accept the returned page update, and report artifacts without repeating ingest. |

These are role decisions, not a prescribed sequence of messages. A Pet can use
`channel_context` before its own Capability when useful. An Entry case fails if
the rest of its plan already assigns another role's work to itself, even when its
first selected Capability is appropriate.

The Issuer Entry and Boundary probes accept `delegate_or_reply`. Existing evidence may already be
sufficient to explain progress and arrange a useful handoff, so direct replies are
legitimate. Additional investigation is appropriate when a concrete factual gap
still affects the answer. Neither path may claim a fresh GitHub check, code review,
test run, or completed investigation that did not occur in the supplied evidence.
The criterion is useful, grounded coordination rather than mandatory Capability use.

## Scoring

Structural checks inspect accepted decision objects, delegated Capability names,
and whether the Supervisor delegates or replies. They do not
compare prompt prose with literal strings or regular expressions.
Recoverable protocol mistakes are retained separately as diagnostics. An invalid
control attempt followed by a valid recovery does not automatically fail the
role-semantic score. The accepted decision, actual delegations, and final outcome
are evaluated; rejected calls do not count as successful execution.
Pending work with a final reply is not by itself a failure: asking a human for a
decision can legitimately preserve the plan. Whether a reply falsely claims
completion is a semantic question evaluated against the supplied evidence.

An independent model judge evaluates each case's semantic criteria against the
input evidence and recorded goal, plan, briefing, or reply. Its model fingerprint
must differ from the subject's fingerprint. Keep criterion-level reasons so a
reviewer can distinguish an incorrect decision from a judge disagreement.

[`buildStudioPetRoleJudgmentInput`](../../../tests/agent-evals/src/studio-pet-role-evaluation.ts)
separates scenario evidence from the subject's authored claims:

- `evidence.evaluationBoundary` identifies what was observed. Entry probes assess
  the goal, plan, briefing, or direct reply and stop before the first Capability
  execution. Boundary probes assess the next decision after a supplied delivery
  and stop before any new delegation executes. Continuous flows assess decisions
  and the final reply against deliveries returned during the run. A planning
  criterion must not require unobserved future artifacts; an unsupported claim
  that work already completed can still fail a grounding criterion at any stage.
- `evidence.returnedExecutions` contains Capability results actually returned
  during the simulated flow. These are observations available to the subject
  inside the scenario, with their stated uncertainty and scope. A supported
  conclusion must not fail merely because the evaluation backend supplied a
  controlled result instead of performing a real GitHub query or file update.
- `candidateOutput` contains the subject's goals, plans, briefings, replies, and
  related decisions. A briefing asking for an action is not evidence that the
  action completed; completion claims require support from the supplied source
  material or a returned result. Results must not be expanded beyond what they
  actually establish.
- The report's harness-level `output.scope` describes the experiment's external
  limits. It is excluded from the judge's candidate input so that “no real domain
  actions” is not misread as evidence contradicting a scenario's returned
  delivery. Model-call diagnostics are also excluded from the candidate input.
  Boundary probes retain their explicitly supplied delivery as scenario evidence.

This distinction preserves both levels of truth: the subject can reason from a
returned delivery within the simulation, while an evaluation report cannot claim
that its simulated implementation, tests, or Wiki writes occurred in a real
project. The judge must not require the subject to announce backend simulation
that was not part of the subject's task context.

Role boundaries do not prohibit ordinary tools. Issuer may perform a narrow fact
check when it resolves a specific status question. Reviewer may read code or run
tests needed for review. Executor should implement and self-test authorized work.
Wiki may check a source needed for a documented fact. Mentioning code or tests is
not itself a failure; ownership, purpose, and scope determine the result.

The checks also guard against excessive refusal. Correct behavior makes progress
within the role: investigate, implement, review, or update knowledge. It does not
automatically halt whenever another role or a human has an outstanding decision.
No criterion requires a fixed `@` syntax or a literal handoff phrase.

## Model-input diagnostics

The [observer](../../../tests/agent-evals/src/studio-pet-model-observer.ts) records
the final model inputs through callbacks without wrapping the model or changing
its tool bindings. Runtime metadata identifies Entry, Supervisor Entry, Capability,
and Boundary calls. Source records show where PET, Host, Channel, and Capability
content appeared, with hashes and occurrence counts. Response records distinguish
parsed native tool calls, invalid calls, and raw provider tool calls, and retain
available finish reasons and request IDs. Serialized provider configuration,
unknown headers, and raw provider error messages are excluded.

By default the observer hashes message content and tool arguments. Full diagnostic
text and arguments require `STUDIO_PET_EVAL_CAPTURE_PROMPTS=1`, which is restricted
to the public synthetic announcement and cannot be combined with
`STUDIO_PET_EVAL_CHANNEL_PROMPT_FILE`. This switch controls model-call diagnostics;
the result report still includes the case input, generated decisions, and judge
assessment. Keep reports local and inspect them before sharing.

Invocation failures retain observations made before the error instead of dropping
the model input or inventing an outcome. Judge failures retain the candidate and
deterministic checks, but do not become successful semantic evaluations. Detailed
model-call diagnostics are not repeated in the judge request; the judge receives
the task evidence and candidate decisions.

## Running and comparing

List scenarios from the repository root without configuring profiles or calling
models:

```sh
npm -w @pinpawo-tests/agent-evals run eval:studio-pet-roles -- --list
```

Run with `PROMPT_EVAL_MODEL_PROFILE_ID` and `PROMPT_EVAL_JUDGE_PROFILE_ID` set to
configured, distinct subject and judge profiles:

```sh
npm -w @pinpawo-tests/agent-evals run eval:studio-pet-roles
```

Filter by role (`issuer`, `executor`, `reviewer`, or `wiki`) or by the full case ID
or name. For example:

```sh
STUDIO_PET_EVAL_ROLE=reviewer npm -w @pinpawo-tests/agent-evals run eval:studio-pet-roles
PROMPT_EVAL_CASE=issuer-boundary-resist-implementation-expansion npm -w @pinpawo-tests/agent-evals run eval:studio-pet-roles
```

Run all roles before making a cross-role claim. The default is three repeats per
scenario; `PROMPT_EVAL_REPEATS` accepts 1–10. Keep model profiles, settings,
scenarios, and repeat count the same when comparing prompt changes. The subject
uses the production native-tool decision path; its configured structured-output
mode is recorded as metadata and does not replace that path.

To include the existing generic Entry case with the same subject model instance,
profile, and generation settings:

```sh
STUDIO_PET_EVAL_BASELINE=1 npm -w @pinpawo-tests/agent-evals run eval:studio-pet-roles
```

This reuses `repository-task-enters-supervisor` from the existing decision suite
and reports its routing and native-tool schema checks separately. It is a
structural baseline, not a role-semantic judge or a Studio workflow acceptance
test. A passing generic route does not establish that a role-specific plan is
correct; a discrepancy provides a starting point for inspecting input and decision
differences. Comparing role-prompt revisions still requires matched role cases.

For inspectable synthetic model-input records, additionally set:

```sh
STUDIO_PET_EVAL_CAPTURE_PROMPTS=1 npm -w @pinpawo-tests/agent-evals run eval:studio-pet-roles
```

Results are written to `report.json` under `PROMPT_EVAL_OUTPUT_DIR`, or by default
under `/tmp/studio-pet-role-eval/<timestamp>/`. A nonzero exit indicates a failed
criterion or an invocation, schema, timeout, or evaluation error.

Retain the repository revision, PET and Capability content hashes, subject and
judge fingerprints, scenario IDs, repeat count, individual decisions, and scoring
reasons with results. Report harness failures and unavailable model runs separately
from semantic failures. Do not treat a judge failure as a successful subject run.

When a defect in judge evidence construction or interpretation is corrected,
retain the original reports, scores, and reasons. Re-evaluate the same recorded
outputs and returned evidence consistently for all comparable cases, rather than
selectively replacing a failed score. Record the corrected judgment input and
judge configuration with the new assessment, and keep the original and revised
scores distinct. A correction to scoring is not a new subject-model run or proof
that subject behavior has become stable.

Passing these cases supports a limited conclusion: the tested model and prompt
configuration made the expected role decisions on this synthetic dataset. It does
not prove that a real execution model respected its briefing, that a Channel
handoff reached another Pet, or that GitHub and Wiki changes were correct. Those
outcomes need separate execution and integration evidence. The controlled child
deliveries must not be reported as real implementation, review, or Wiki results.

Without a matched baseline using the same harness, cases, profiles, settings, and
repeat count, results do not establish a regression or improvement. They also do
not establish that a model or the general orchestration system is qualified or
unqualified for production. A failed case first warrants inspecting the supplied
evidence, captured model input, decision, and judge reasoning.

The four roles have different prompts, available Capabilities, and scenarios.
Their scores therefore cannot isolate the causal contribution of PET.md. A
separate identity comparison would need to hold the request, announcement, registry,
and model settings constant while varying the intended identity input. Neither
the absence of a full Capability body nor a correct role decision alone proves
why the model behaved as it did. Preserve per-case evidence and avoid turning
these observations into a general model or system qualification claim.
