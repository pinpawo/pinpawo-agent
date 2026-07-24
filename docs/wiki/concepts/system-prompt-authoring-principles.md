---
title: System Prompt Authoring Principles
page_type: concept
status: draft
updated: 2026-07-24
sources:
  - ../sources/model-prompting-and-harness-references.md
  - ../../PET_AGENT_DECISION_SYSTEM_PROMPT_DESIGN.md
  - https://github.com/pinpawo/pinpawo-agent/issues/417
  - https://github.com/pinpawo/pinpawo-agent/issues/435
related:
  - ../overview.md
  - prompt-knowledge-layers.md
  - decision-node-ownership.md
  - ../questions/system-prompts-open-questions.md
---

# System Prompt Authoring Principles

## Purpose

This page defines review principles for production system prompts. It does not
change the semantics of an existing node, action, schema, message lane, or
handoff. Those changes still require their own design decision and evals.

The target is not the prompt that sounds most forceful. The target is the
smallest model-visible contract that makes the desired behavior understandable,
while the harness deterministically owns what it can derive or enforce.

## Evidence-backed position

Current model guidance converges on direct, structured, outcome-focused prompts:

- OpenAI recommends leaner prompts, stating each instruction once, retaining only
  measured product requirements, and defining goals, context, constraints,
  evidence, success criteria, and output shape. It also says newer models often
  do not need every reasoning step prescribed.
- Anthropic explicitly reports that positive examples are generally more
  effective than negative examples or instructions for controlling Claude's
  response style. Its current guidance also warns that scaffolding tuned for an
  older model can over-trigger or suppress a newer model.
- Google recommends precise, direct, consistently structured prompts with
  explicit goals, parameters, constraints, and output requirements.
- Agent engineering evidence treats prompts, tools, observation, memory, control
  flow, schemas, and programmatic checks as one harness. A prompt cannot repair
  an ambiguous tool interface or replace a reliable state transition.

The source evidence is summarized in
[Model Prompting and Harness References](../sources/model-prompting-and-harness-references.md).

## Authoring contract

### 1. State the desired behavior before exclusions

Describe the judgment or action the model should perform, the evidence it should
use, and the result it should produce. A prohibition may then narrow a real edge
of that behavior.

Prefer:

> Choose `answer` when the main conversation already contains sufficient evidence
> for a user-visible response. Choose an execution route when answering requires a
> new observation, search, calculation, tool result, or state change.

Over:

> Do not answer questions that need tools. Do not guess. Do not repeat work.

The first form provides a classification boundary. The second leaves the normal
route and the meaning of “need” implicit.

### 2. Distinguish anti-only rules from real boundaries

Negative wording is not categorically invalid. Classify it before rewriting it:

| Kind | Treatment | Example |
|---|---|---|
| Anti-only steering | Rewrite as a positive behavior, selection rule, or fallback | Replace “do not be verbose” with required content and an omission priority |
| Semantic boundary | Keep it short and pair it with the owned positive behavior | “Select one capability for the current task; task rewriting belongs to the planner” |
| Safety or authority boundary | Keep it explicit; enforce outside the prompt where possible | Require approval before an external write |
| Mechanical invariant | Move enforcement to schema, code, permissions, or guards | Reject an action that is unavailable in the current graph state |
| Measured exception | Keep only with an eval that demonstrates the failure and the improvement | A narrow clause for a recurring model-specific regression |

The review question is therefore not “does this sentence contain `不要`?” It is
“does the model learn the valid behavior, and is prompt text the correct owner of
this constraint?”

### 3. Express outcomes and ownership, not hand-written reasoning

For current reasoning models, specify:

- the node's mission and semantic owner;
- the evidence it may rely on;
- the available decisions and their meaning;
- success, stopping, and escalation conditions;
- the required output schema.

Avoid prescribing an internal step sequence unless order itself is a product or
safety requirement. A long checklist can constrain a newer model to an obsolete
reasoning path while duplicating logic already owned by the graph.

### 4. Give each rule one semantic owner

State an instruction once, at the narrowest layer that owns it. Do not repeat the
same rule in the shared prefix, node prompt, dynamic context, tool description,
and schema description.

This extends [Prompt Knowledge Layers](prompt-knowledge-layers.md):

- stable model judgment belongs in the static node contract;
- invocation-specific values are injected facts;
- configurable policy needs a typed owner and conflict model;
- derivable state and hard invariants belong to deterministic enforcement.

Duplication is not harmless emphasis. It increases token load, creates drift, and
can make broad cautions dominate the actual task.

### 5. Use structure to separate roles, not decoration

Use a small, consistent structure when a prompt mixes different semantic kinds,
for example: mission, decision rules, evidence, boundaries, and output. Tags or
headings should make those roles unambiguous. They should not repeat prose or
serve as routing identity; message provenance remains a harness responsibility.

### 6. Make hard constraints operational

A critical rule should have at least one enforcement or detection mechanism
outside prose when feasible:

- schema/type constraints for output shape;
- graph guards for action availability and stopping conditions;
- permissions and approval gates for side effects;
- tool contracts for inputs, outputs, and errors;
- validators for deterministic correctness properties;
- evals for semantic behavior that cannot be mechanically checked.

The stronger the consequence of failure, the less acceptable it is for the
system prompt to be the only control.

### 7. Treat tools and observations as part of prompting

Tool names, descriptions, parameters, return shapes, error semantics, and the
observations returned to the model form an agent-computer interface. If a model
cannot tell which tool produces the needed evidence, or cannot interpret its
result, adding more behavioral warnings is usually the wrong repair.

Before adding prompt text, check whether the failure is caused by:

1. missing or stale evidence;
2. ambiguous action or tool affordances;
3. an output schema that does not encode the intended distinction;
4. a graph transition or message-provenance error;
5. only then, an underspecified semantic judgment in the prompt.

### 8. Keep examples selective and eval-backed

Examples are strong steering signals and can also overfit behavior to the latest
incident. Keep the general rule in the production prompt. Keep diverse normal,
boundary, and adversarial cases in evals. Add a production example only when a
measured failure persists and the example improves representative cases without
regression.

### 9. Tune per model; preserve product semantics

Prompt wording and scaffolding are model-dependent implementation details. Node
semantics, authority boundaries, and user-visible product behavior are not.

For a model upgrade:

1. preserve the existing semantic and eval baseline;
2. remove or weaken legacy scaffolding one group at a time;
3. compare representative tasks at relevant reasoning/effort settings;
4. measure task success, incorrect routes, unnecessary tool calls, omissions,
   tokens, latency, and cost;
5. record model-specific clauses as conditional protocol rather than changing the
   shared meaning of an action.

### 10. Test contracts and behavior, not prompt prose

Deterministic tests should protect template rendering, structured input shape,
message role and order, provenance, boundedness, schema constraints, and the
separation of dynamic facts from static instructions. They should not use the
presence or absence of natural-language clauses as a proxy for model behavior.
Such assertions are brittle under equivalent rewrites and can still pass when
the assembled prompt contains contradictory guidance.

Use goal-based model evals for routing, planning, selection, verdict, and reply
semantics. Keep text-level negative assertions only when they protect an
operational boundary such as sensitive-data leakage, untrusted dynamic content
entering a system prompt, or an input lane that must remain excluded.

## Evaluation targets derived from Prompt Contracts

The repository does not maintain an independent catalog of eval-quality
dimensions. A real-model eval starts from an existing stable behavior in the
[Prompt Contract Map](../overview.md#prompt-contract-map), then turns that
contract into a concrete task objective. This keeps evaluation aligned with the
same semantic owner as the production prompt.

The current contracts produce three evaluation forms; these are applications of
existing node ownership, not new prompt concepts:

| Existing owned behavior | Eval target form | Current prompts |
|---|---|---|
| Choose the correct contract-defined judgment from supplied evidence | Judgment objective | `entryDecision`, `capabilityDecision`, `outcomeDecision` |
| Materialize the contract-defined artifact while preserving its semantic relationships | Materialization objective | `capabilityPlanner` |
| Fulfil the current user-visible communication objective from canonical conversation evidence | User-visible fulfilment objective | `answer` |

The shared decision prefix has no independent task objective. Its structured
judgment and graph/answer ownership are exercised through the decision nodes and
verified mechanically where possible.

### Case and result contract

Every semantic case defines:

1. the Prompt Contract row it instantiates;
2. one concrete objective within that owner's scope;
3. acceptance criteria that explain what completing the objective means for the
   supplied evidence;
4. the evaluator responsible for each criterion.

The result keeps three layers distinct:

- **Run status** records whether invocation and parsing produced an evaluable
  output.
- **Goal judgment** records whether the case objective was achieved; this is the
  semantic pass/fail result.
- **Evidence and diagnostics** record criterion findings, error classifications,
  tokens, latency, cost, output size, variation, overlap, and provider metadata.

A diagnostic does not become a goal criterion merely because it is easy to
measure. For example, response length can reveal verbosity, but a character
threshold cannot fail a clarification task unless a bounded response length is
part of the accepted product behavior. Likewise, overlap can help explain
repetition, but the completion-acknowledgement objective—not a global overlap
threshold—determines whether the lifecycle was closed correctly.

Deterministic evaluators own exact structured decisions and mechanical
invariants. Free-form entry tasks, planner task/tail objectives, and answers are
judged against their objective, canonical evidence, and acceptance criteria;
keyword presence alone is not sufficient evidence of completion. Evaluator
identity and revision are part of the reproducible harness because changing the
judge changes the experiment.
Each criterion result records that evaluator ownership. Candidate recall,
rubber-stamp status, output shape, and similar runtime measurements remain
diagnostics; schema-owned field and enum constraints remain run-status evidence
rather than duplicated prompt-goal criteria.

Validation proceeds in two stages. First, one supported model runs the complete
contract profile until objectives, criteria, evaluator ownership, case
selection, and repetitions are stable. The unchanged profile is then repeated
across additional model families. Cross-model breadth does not precede a
reproducible single-model baseline.

### Current prompt objectives and metrics

The primary metric for every node is goal success across representative cases.
The remaining metrics either classify a failed objective or describe the run:

| Prompt contract | Case objective | Goal-gating evidence | Error classification | Non-gating run diagnostics |
|---|---|---|---|---|
| `entry.execution-shape` | Select `answer`, `direct_task`, or `needs_plan` by whether new execution is required, its target is determined, and prior planning is required | Chosen action matches the evidence and execution requirement; a direct task preserves the complete current-task objective | unsupported answer, unnecessary execution, ambiguous-target execution, wrong task grouping | schema/invocation status, variants, tokens, latency, cost |
| `planner.execution-boundary` | Materialize the next independently executable task and preserve only the valid future tail | Current task, cancellation, grouping, deferral, and tail relationships satisfy the supplied goal and handoff | wrong grouping, obsolete work retained, valid work dropped, premature concretization | schema/invocation status, plan shape, variants, tokens, latency, cost |
| `capability.executor-selection` | Select the best currently available executor for the immutable task | Selected lane fits the task and belongs to the supplied candidate set or valid general fallback | missed custom match, wrong custom match, incorrect general fallback, unavailable lane | schema/invocation status, candidate set, variants, tokens, latency, cost |
| `outcome.announce-verdict` | Judge the current announce against the current task and overall user goal | Verdict reflects current-task sufficiency, remaining work, and required user input without sibling-result substitution | premature completion, missed completion, sibling contamination, missed user-input stop | schema/invocation status, gap-note shape, variants, tokens, latency, cost |
| `answer.user-visible-close` | Fulfil the current reply objective: direct response, handoff synthesis, requested replay, focused user question, or completion acknowledgement | Case-specific criteria establish correctness, evidence fidelity, and the accepted close behavior | missing requested content, unsupported claim, false status, wrong reply mode, unrequested result replay | invocation status, length, overlap, variants, tokens, latency, cost |

Metrics are aggregated only after case-level goal judgments. A combined pass rate
must not be manufactured by treating diagnostic thresholds as interchangeable
proxies for task completion.

## Clause review template

This is a review lens, not a persistent metadata schema. A prompt change should
answer five questions:

| Field | Question |
|---|---|
| Behavior | What should the model do, and what is the fallback? |
| Owner | Which prompt node or harness component owns it? |
| Evidence | What information makes the judgment possible? |
| Enforcement | What belongs in prompt text versus schema, code, or permissions? |
| Verification | Which design source and eval show the change is correct? |

The durable [Prompt Contract Map](../overview.md#prompt-contract-map) records only
stable behavior contracts. It does not store this checklist for every prompt
sentence.

## V1 repository review results

The initial classification backlog has been applied one node at a time. These
rows describe the current ownership split, not another instruction to shorten
the prompts.

| Area | Observation | Review direction |
|---|---|---|
| [`sharedPrefix.prompt.ts`](../../../packages/pet-agent/src/agent/orchestrator/prompts/templates/sharedPrefix.prompt.ts) | The common decision-node contract now contains only invocation-context use, the structured-judgment role, and graph/answer ownership | Keep node flow, field semantics, completion criteria, and runtime transitions with their narrower prompt, schema, or graph owner |
| [`entryDecision.prompt.ts`](../../../packages/pet-agent/src/agent/orchestrator/prompts/templates/entryDecision.prompt.ts) | The prompt applies the ordered new-execution, unique-target, and plan-requirement judgment | Preserve the validated GLM-5.2 profile and extend it across models before changing the production boundary |
| [`capabilityPlanner.prompt.ts`](../../../packages/pet-agent/src/agent/orchestrator/prompts/templates/capabilityPlanner.prompt.ts) | The prompt owns mode-specific planning, task grouping, and deferred-work judgment; the schema owns output relationships | Validate grouping, cancellation, and future-tail preservation across models |
| [`capabilityDecision.prompt.ts`](../../../packages/pet-agent/src/agent/orchestrator/prompts/templates/capabilityDecision.prompt.ts) | The prompt selects the best executor for the current task; schema and runtime own available-lane enforcement | Validate custom/general selection and missing-parameter behavior across models |
| [`outcomeDecision.prompt.ts`](../../../packages/pet-agent/src/agent/orchestrator/prompts/templates/outcomeDecision.prompt.ts) | The prompt identifies verdict evidence; the schema owns verdict meanings and `gap_note`; runtime owns transitions | Validate task acceptance, sibling-result isolation, and stopping behavior across models |
| [`answer.prompt.ts`](../../../packages/pet-agent/src/agent/orchestrator/prompts/templates/answer.prompt.ts) | The prompt defines the user-visible reply boundary and evidence source; runtime supplies the current user goal and reply objective, including the fixed completion acknowledgement | Validate answer quality, replay fidelity, and repetition without changing the accepted close structure |

Future changes still evaluate each node independently. A shorter prompt is not a
standing objective, and one node's measured regression is not authority to
rewrite unrelated node semantics.

## CapabilityDecision pilot evidence

The first merged #417 change applied the review lens to `capabilityDecision`
only:

- the production prompt states one task: choose the lane that best matches the
  already-defined current task;
- the model-visible rules retain custom capability preference, the `general`
  fallback, and the semantic treatment of missing execution parameters;
- the lane schema owns single-choice output and the current candidate enum;
- runtime validation owns rejection of unavailable capabilities and preserves
  the current task when materializing the delegation;
- a dedicated eval case covers a matching capability whose execution parameters
  still need clarification.

For one canonical capability-routing case, prompt preview changed from
approximately 1,328 to 1,283 tokens. This is a size measurement, not a claim of
behavioral improvement. Real-model comparison remains required before this page
can become `validated`.

The stable capability-selection contract, owner, implementation, and verification
links did not change, so the Prompt Contract Map does not gain a wording-only
revision.

## CapabilityPlanner pilot evidence

The second merged #417 change applied the same review lens to
`capabilityPlanner` only:

- the production prompt keeps the entry/boundary planning judgment, task
  grouping, and the condition for keeping work `deferred`;
- the model-visible schema defines `result`, the relationship among
  `next_task` and `remaining_plan`, and a required-but-nullable `next_task`;
- runtime schema validation owns cross-field validity and exact duplicate
  rejection;
- runtime code materializes the current task, while `capabilityDecision` chooses
  its executor;
- a dedicated eval case checks that related actions completed by one capability
  remain one execution task.

For one canonical planning case, prompt preview changed from approximately 1,424
to 1,135 tokens. This is a size measurement, not a claim of behavioral
improvement. Real-model comparison remains required before this page can become
`validated`.

The stable planner contract and its ownership links did not change, so the
Prompt Contract Map does not gain a wording-only revision.

## OutcomeDecision pilot evidence

The third merged #417 change applied the same ownership split to
`outcomeDecision`:

- the production prompt defines which context provides the current-task and
  user-goal evidence;
- the model-visible schema defines the three verdicts and accepts compatible
  optional or nullable `gap_note` input;
- schema normalization produces a stable nullable `gap_note` and removes
  terminal-outcome gap noise, while runtime graph code owns continuation,
  planner handoff, and answer routing;
- eval cases cover a completed sibling task that cannot replace the current
  announce and a run that requires user input before it can continue.

For one canonical outcome case, prompt preview changed from approximately 1,718
to 1,169 tokens. This is a size measurement, not a claim of behavioral
improvement. Real-model comparison remains required before this page can become
`validated`.

The stable verdict contract and ownership links did not change, so the Prompt
Contract Map does not gain a wording-only revision.

## Answer pilot evidence

The fourth merged #417 change applied positive-first wording to the user-visible
answer boundary:

- the static prompt defines four reply modes: direct answer, handoff synthesis,
  faithful historical replay, and a focused user question;
- the provenance-triggered delegation completion acknowledgement remains a
  distinct final main message;
- its dynamic context now states the acknowledgement's bounded content and the
  handoff's ownership of the task-result body;
- terminal contexts positively require an accurate incomplete-status report;
- runtime tests continue to cover full main-history access, compacted historical
  replay, provenance-selected completion mode, and unchanged final model output.

For the rendered static answer prompt, preview changed from approximately 303 to
187 tokens. This is a size measurement, not a claim of behavioral improvement.
Real-model comparison remains required before this page can become `validated`.

The accepted completion lifecycle and the stable answer contract did not change,
so neither the completion decision page nor the Prompt Contract Map requires a
semantic revision.

## Answer reply-objective follow-up

The answer eval isolated a failure in the completion acknowledgement rather than
the general answer boundary: direct replies, existing-result synthesis,
historical replay, and clarification all met their objectives, while completion
repeated the delivered result and exposed internal lifecycle terms.

The follow-up keeps the accepted two-message close and narrows model-visible
knowledge:

- the static prompt states the user-visible responsibility and canonical
  conversation evidence;
- runtime context identifies the current user goal, state, and reply objective;
- provenance still selects completion mode, but internal flow vocabulary and
  identifiers stay in code;
- terminal states use the same current-state and reply-objective structure.

This is an application of the existing static-contract, injected-fact, and
deterministic-runtime split. It does not add a free-form policy channel or a new
Prompt Contract Map entry.

Using GLM-5.2 with the same lifecycle-aligned eval harness revision, three
repeats per case, and the same goal evaluator, the comparable result changed
from 12/15 to 15/15 goals achieved. Completion acknowledgement changed from 0/3
to 3/3, while the other four answer behaviors remained 3/3. The completion
outputs were identical across the three candidate runs. This is evidence for
the current provider and model, not cross-model validation.

## Shared-prefix pilot evidence

The final merged #417 change reduced the common decision prefix to the facts
every decision node needs:

- decisions use the context supplied to the current invocation;
- each node returns only its owned structured judgment;
- the graph advances execution and state, while `answer` owns the user-visible
  reply.

The node sequence, completion criteria, verdict definitions, `gap_note`, handoff
mechanics, and delegation terminology were removed from the shared prefix
because they already have narrower prompt, schema, or runtime owners. Prompt
input tests guard structured context and dynamic-data boundaries; goal-based
evals guard the retained cross-node behavior.

For one canonical case per decision node, prompt preview changed as follows:

| Node | Before | Merged V1 |
|---|---:|---:|
| `entryDecision` | approximately 1,637 tokens | approximately 971 tokens |
| `capabilityPlanner` | approximately 1,135 tokens | approximately 470 tokens |
| `capabilityDecision` | approximately 1,283 tokens | approximately 618 tokens |
| `outcomeDecision` | approximately 1,169 tokens | approximately 504 tokens |

The shared prefix now occupies approximately 8–24% of these system prompts,
down from 52–80%. These are model-independent size measurements, not claims of
behavioral improvement. The stable shared contract did not change, so the Prompt
Contract Map needs only its verification link updated rather than a new row.

## GLM-5.2 V1 contract coverage

The canonical single-model profile ran the merged V1 prompt contracts before
starting cross-model comparison:

- revision and harness: `d54c6e38e8a26f5a6c0453112b8017ed0467170a`;
- provider/model: DashScope `glm-5.2`, temperature `0`,
  provider-default reasoning effort, JSON Mode;
- evaluator: `prompt-goal-v1` using the same configured model;
- selection: 34 canonical cases across all five prompt contracts, three repeats
  per case.

| Target | Goals achieved | Stable evidence |
|---|---:|---|
| `entry` | 30/36 | Existing evidence, local/remote lookup, clarification, calculation, one-boundary work, and planning passed |
| `planner` | 15/18 | Materialization, cancellation, valid concrete work, and future-tail preservation passed |
| `capability` | 18/18 | Custom selection, general fallback, missing parameters, browser, and unavailable capability passed |
| `outcome` | 15/15 | Continue, task completion, goal completion, sibling isolation, and user-input stopping passed |
| `answer` | 14/15 | Direct, synthesis, replay, and completion acknowledgement passed; clarification varied |

Overall, 92/102 goals were achieved. All 102 subject runs reported token usage:
68,151 input tokens and 25,662 output tokens. The 51 semantic-evaluator calls
used 53,101 additional tokens. No schema, invocation, or evaluator errors
occurred. Cost remains unreported because no pricing snapshot was supplied.

The failures are bounded evidence for later prompt work, not authority to add
global clauses in this eval change:

- `entry` treated an intention as completion evidence in 0/3 successful goals;
- `entry` treated stale deployment evidence as current in 0/3 successful goals;
- `planner` split related work for one capability into three tasks in 0/3
  successful goals;
- `answer` asked for missing production-config information in 2/3 runs.

The profile also exposed and removed an evaluator false negative: enriching a
valid concrete task with `/tmp/report.pdf` changed string-level plan diagnostics
but still achieved the materialization objective. Plan-effect and rubber-stamp
measurements therefore remain diagnostics, while free-form task semantics use
the goal evaluator. A planner-only rerun after removing those derived
diagnostics from the judge input preserved the same 15/18 result at
`294fd26b292dda73232cfbbc7410d0c35e5d4e9c`; only the capability-grouping
criterion failed.

## Entry exclusion-flow validation

The entry follow-up at
`6e10c8a641489889ab8c414e8e371678b5562a3e` applied the authoring principles
without adding domain-specific commit or deployment rules:

- the prompt asks whether new execution is needed, whether its target is
  determined, and whether execution needs prior planning;
- schema descriptions retain only the result semantics instead of duplicating
  the decision conditions;
- runtime-context language is reduced to the read-only fact boundary and the
  role of canonical main messages;
- eval cases isolate evidence, clarification, task grouping, context recency,
  and planning objectives instead of combining them.

With the same DashScope `glm-5.2`, JSON Mode, provider-default reasoning, and
`prompt-goal-v1` evaluator profile, all 12 entry cases passed across three
repeats (`36/36`). This is bounded single-model evidence for the entry contract;
it does not replace the still-pending cross-model profile.

## Application to the current entryDecision issue

The recent `answer` regression should not be repaired with a case-specific
warning such as “do not choose `answer` for questions about commits.” The general
contract should define whether the current conversation already contains enough
evidence or whether a new execution result is required. Commit status, file
existence, deployment state, a remote issue, and current weather then become
instances of the same evidence boundary.

This principle does not remove the fixed post-delegation completion
acknowledgement. That message shape is an accepted product decision with a
separate owner, documented in
[Delegation Completion Acknowledgement](../decisions/delegation-completion-acknowledgement.md).

## Acceptance status

The V1 implementation is complete across the four decision nodes, the shared
decision prefix, and `answer`. The GLM-5.2 baseline identifies bounded failures,
and the entry exclusion-flow rerun establishes per-change evidence for that one
contract. It does not yet establish cross-model behavior. This page therefore
remains a **draft synthesis**. Historical comparisons, additional-model
validation, and priced cost evidence remain tracked by
[issue #435](https://github.com/pinpawo/pinpawo-agent/issues/435). Contract
traceability is maintained by the map established in
[issue #415](https://github.com/pinpawo/pinpawo-agent/issues/415).
