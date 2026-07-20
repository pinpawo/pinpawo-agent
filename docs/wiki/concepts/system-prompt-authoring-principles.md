---
title: System Prompt Authoring Principles
page_type: concept
status: draft
updated: 2026-07-21
sources:
  - ../sources/model-prompting-and-harness-references.md
  - ../../PET_AGENT_DECISION_SYSTEM_PROMPT_DESIGN.md
  - https://github.com/pinpawo/pinpawo-agent/issues/417
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

## Initial repository review targets

This is a classification backlog, not an instruction to delete every matching
clause.

| Area | Observation | Review direction |
|---|---|---|
| [`sharedPrefix.prompt.ts`](../../../packages/pet-agent/src/agent/orchestrator/prompts/templates/sharedPrefix.prompt.ts) | The common decision-node contract combines a positive output rule with several global prohibitions | Keep the shared positive invariant; verify which exclusions are already guaranteed by schema, graph routing, and tool availability |
| [`entryDecision.prompt.ts`](../../../packages/pet-agent/src/agent/orchestrator/prompts/templates/entryDecision.prompt.ts) | Node ownership and action meanings are mixed with repeated “do not answer / choose capability / execute” wording | Make the existing-evidence versus new-execution boundary primary; express non-ownership as a compact handoff to the owning node |
| [`capabilityPlanner.prompt.ts`](../../../packages/pet-agent/src/agent/orchestrator/prompts/templates/capabilityPlanner.prompt.ts) | Several useful planning invariants are phrased only as prohibitions | Define the valid relationship among `next_task`, `remaining_plan`, and an execution boundary first; retain narrow non-duplication constraints if evals need them |
| [`capabilityDecision.prompt.ts`](../../../packages/pet-agent/src/agent/orchestrator/prompts/templates/capabilityDecision.prompt.ts) | The node boundary is mostly an anti-list even though the schema has one positive responsibility | Lead with selecting exactly one available executor for the immutable current task; let schema and graph ownership carry the mechanical exclusions |
| [`outcomeDecision.prompt.ts`](../../../packages/pet-agent/src/agent/orchestrator/prompts/templates/outcomeDecision.prompt.ts) | The densest anti-list repeats what several other nodes own | Define verdict evidence and the transition owned by each outcome, then remove exclusions already made impossible by the schema or runtime |
| [`answer.prompt.ts`](../../../packages/pet-agent/src/agent/orchestrator/prompts/templates/answer.prompt.ts) | The accepted completion shape is partly expressed as “do not repeat” | Preserve the fixed completion acknowledgement, but describe what the close should contain and when historical content should be replayed |

Each item must be evaluated independently. A clause should not be removed merely
because it is negative, and the current entryDecision issue must not become a
reason to rewrite unrelated node semantics.

## CapabilityDecision pilot evidence

The first #417 implementation candidate applies the review lens to
`capabilityDecision` only:

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

This page is a **draft synthesis**, not yet a production prompt change. It should
become `validated` after the team accepts the authoring contract, maps current
prompt clauses to owners, and evaluates the first prompt refactor against at
least two supported model families. Implementation and validation are tracked in
[issue #417](https://github.com/pinpawo/pinpawo-agent/issues/417), with contract
traceability tracked separately in
[issue #415](https://github.com/pinpawo/pinpawo-agent/issues/415).
