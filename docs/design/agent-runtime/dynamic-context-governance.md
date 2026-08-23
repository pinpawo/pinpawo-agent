# Dynamic Context Governance Design

> Status: proposed
> Date: 2026-07-31
> GitHub issue: [#519](https://github.com/pinpawo/pinpawo-agent/issues/519)
> Scope: model-visible dynamic context across orchestrator decisions, answer,
> Capability execution, compaction, and automatic review.

## 1. Problem statement

The repository has accepted boundaries for semantic ownership, prompt knowledge
layers, message provenance, and deterministic enforcement. It does not yet have
one code-organization contract for dynamic context.

Today, model-visible context is assembled in several incompatible ways:

- shared serializers live in `agent/orchestrator/prompts/context.ts`;
- Outcome-specific context lives beside its prompt builder;
- Answer reply objectives and terminal context are prose builders inside the
  runtime node;
- Planner state projection lives in the runtime node while rendering lives in
  the prompt package;
- Capability `promptSections` mix stable execution instructions with lane,
  workdir, and runtime facts before all sections are concatenated into one
  `createAgent.systemPrompt`;
- main-conversation compaction reinserts a generated summary as a
  `SystemMessage`.

This inconsistency creates two primary risks:

1. **Authority escalation.** User-, task-, result-, or tool-derived text can be
   promoted into a system message and become a second instruction channel.
2. **Unstable model prefixes.** Frequently changing invocation facts can appear
   before long stable contracts, Capability instructions, or Toolkit
   instructions, preventing those prefixes from being reused by providers that
   support prompt caching.

The first priority is governance: define what dynamic context is, where its
builders live, who owns its meaning and rendering, and how that structure is
verified. Cache efficiency is a consequence and diagnostic of that structure,
not the top-level design owner.

This design is distinct from
[`CONTEXT_GOVERNANCE_REFACTOR.md`](../../history/agent-runtime/context-governance-refactor.md), which owns
context-window summarization, lane lifecycle, checkpoint size, and persistence.
The two designs meet at compaction message authority and provenance, but do not
share a policy DSL.

## 2. Evidence

The design responds to current implementation and two bounded trace
observations:

- run `019fb55c-ede8-76f4-b2b4-ccc7e0cbfe2d` showed Answer receiving a system
  instruction that embedded the complete delegated task and required the model
  to reproduce it literally. The task began with an imperative browser action
  and contained a credential-like URL parameter. GLM-5.2 replied as though the
  already completed work was about to start. The trace reported 2,892 input
  tokens and no cache read for that call.
- trace `019fb546-a03f-717c-bb0f-d0741ff5bc6e` showed why model and provider
  behavior must be measured separately from deterministic protocol guarantees.
  It remains Planner latency evidence, not proof of a universal cache or tool
  behavior.

The first observation maps directly to
`buildDelegationCompletionAnswerContext()` in
[`runtime/nodes/answer.ts`](../../../packages/pet-agent/src/agent/orchestrator/runtime/nodes/answer.ts).
That function uses a task string as system-level reply prose. The existing
Answer tests assert the presence of that prose but do not execute the real model
against long imperative tasks.

No raw trace payload, URL token, or user data is copied into this document.

## 3. Priorities

The work is ordered by ownership rather than by one optimization metric. The
minimum governance contract comes first, but the known Answer failure does not
wait for every consumer to migrate:

1. **P0 — governance structure:** ownership, placement, naming, typed facts,
   rendering, and invocation assembly;
2. **P0.5 — urgent Answer containment:** after agreeing the minimum Answer
   Context Contract, remove delegated task text from the Answer system message,
   give `goal_done` a closed task-summary mode, and add the reproduced
   regression case;
3. **P1 — authority and safety migration:** prevent dynamic facts and summaries
   in the remaining consumers from becoming system instructions;
4. **P2 — relevance and propagation:** expose only the facts required by the
   current semantic owner;
5. **P3 — efficiency:** stable prefixes, duplicate removal, token usage,
   provider cache behavior, latency, and cost.

P0.5 is an intentionally early implementation slice. It depends only on the
Answer row, typed reply modes, placement rule, and test contract from P0. It does
not depend on completing the Entry, Planner, Outcome, Capability, compaction, or
Auto Review migrations.

### 3.1 P0 baseline implementation status

The current change implements the minimum Answer baseline:

- `AnswerContextFacts` is a closed union owned by `prompts/answer.ts`;
- `selectAnswerContextFacts()` projects runtime state without generating prompt
  prose;
- `appendAnswerContextMessage()` owns the target placement by returning
  canonical history followed by the synthetic Human facts message with
  `authority="none"` provenance;
- unfinished-task and detail fields have deterministic rendering bounds;
- contract and projection tests cover role, provenance, closed modes, escaping,
  bounds, terminal meaning, and absence of a free-form instruction field.

The baseline deliberately preserved Answer output behavior through a named
legacy renderer. It established the contract without claiming that the
reproduced incident was fixed.

### 3.2 P0.5 containment implementation status

The Answer containment slice now applies that contract to production:

- `prompts/answer.ts` owns the stable system contract, facts rendering, message
  roles/order, and final model-invocation assembly;
- Answer workdir, runtime-environment, task, result, and terminal-state values no
  longer enter the system message;
- model-backed modes receive a bounded synthetic Human facts message after
  canonical history;
- genuine `goal_done` invokes Answer with canonical history plus a closed,
  low-authority task-summary mode;
- the legacy runtime prose builders, including
  `buildDelegationCompletionAnswerContext()`, are removed;
- deterministic tests cover invocation count, output, roles, order, provenance,
  bounds, and absence of dynamic system data;
- redacted long-imperative and instruction-like completion fixtures cover the
  reproduced failure shape without storing real URLs or credentials.

## 4. Context lifecycle

Every model-visible dynamic context follows four explicit stages:

```text
runtime state and canonical messages
  -> context projection
  -> typed context facts
  -> context rendering
  -> invocation assembly
  -> model
```

### 4.1 Context projection

Projection reads runtime state and selects facts. It remains with the runtime
semantic owner and returns typed data, not prompt prose.

Examples:

```ts
selectAnswerContextFacts(state)
selectPlannerContextFacts(state)
selectOutcomeContextFacts(state)
```

Runtime projection may read typed outcome state, pending work, iteration state,
handoff provenance, or canonical messages. It does not choose XML, message
roles, prompt wording, or system placement.

### 4.2 Typed context facts

Each consumer owns a closed context type. The type contains values and enum-like
modes, never an arbitrary instruction channel.

```ts
type AnswerContextFacts = {
  hasUserGoal: boolean;
  acceptedResults: AnswerAcceptedResult[];
} & (
  | { mode: 'direct' }
  | { mode: 'goal_done' }
  | {
      mode: 'user_input_required';
      question: string | null;
      context: string | null;
    }
  | {
      mode: 'blocked';
      reason: 'iteration_limit' | 'capability_unavailable';
      unfinishedTask: string | null;
    }
);
```

Fields such as `extraSystemPrompt`, `replyInstruction`, or a caller-supplied
policy string are not valid context facts. The runtime projects the current run's
accepted handoffs into one ordered result set for every terminal mode and removes
those same handoff payloads from that model invocation. In `goal_done`, Answer
summarizes the set without accepting caller-authored reply instructions. Canonical
checkpoint messages remain unchanged.

### 4.3 Context rendering

Rendering belongs to the consumer's prompt package. It serializes typed facts
into bounded, role-labelled data without inventing new policy.

```xml
<answer_context role="fact" source="orchestrator_state" authority="none">
  <reply_mode>user_input_required</reply_mode>
  <requested_user_input>Which target should be used?</requested_user_input>
</answer_context>
```

User-, task-, announce-, summary-, file-, URL-, and tool-derived text uses the
shared bounded text serializer. Dynamic values do not define tag names. XML
attributes are enums or escaped trusted identifiers.

### 4.4 Invocation assembly

Each model-facing actor has one prompt package that owns:

- the static system contract;
- its typed dynamic context renderer;
- message roles and ordering;
- field bounds and omission rules;
- the final invocation-message builder.

A runtime node invokes this package. It does not concatenate a dynamic system
message itself.

The ordinary target shape is:

```text
stable system contract
canonical conversation or private lane history
current bounded context message
```

Provider-specific ordering constraints must be represented as a conditional
protocol in the prompt package and covered by compatibility tests. They do not
authorize arbitrary state text in the system contract.

## 5. Ownership and code placement

### 5.1 Runtime owners

Runtime nodes and decisions own state projection, graph transitions, model
invocation, and cleanup. They may return typed context facts. They must not
return or concatenate model-facing context prose.

### 5.2 Prompt packages

The current flat `prompts/` layout remains sufficient. A prompt package owns one
model-facing actor:

```text
agent/orchestrator/prompts/
  shared.ts
  userIntentContext.ts
  answer.ts
  entryDecision.ts
  outcomeDecision.ts
  capabilityPlannerAgent.ts
  capability.ts
  autoReview.ts
  templates/
```

The `templates/` files contain stable templates. The adjacent package file owns
typed facts, rendering, and invocation assembly. Shared utilities provide only
mechanical encoding, clipping, indentation, and provenance helpers.

The broad `prompts/context.ts` should be decomposed incrementally. A genuinely
shared domain projection, such as the user-intent context consumed by Planner
and Outcome, may have its own named module. Artifact, announce, terminal, and
task context should remain with their actual consumers unless more than one
consumer has the same semantic contract.

### 5.3 Naming

Names make the boundary reviewable:

| Stage | Naming pattern | Returns |
|---|---|---|
| Runtime projection | `select<Node>ContextFacts` | typed object |
| System contract | `build<Node>SystemPrompt` | stable string |
| Fact rendering | `render<Node>Context` | bounded data string |
| Message creation | `create<Node>ContextMessage` | synthetic message |
| Invocation assembly | `build<Node>InvocationMessages` | ordered messages |

Runtime code should not contain a `build*Context(): string` function. That name
is reserved for model-facing prompt packages.

## 6. Context Contract Map

The Wiki maintains a Context Contract Map separate from the semantic Prompt
Contract Map. The Prompt Contract Map continues to index stable behavior; the
Context Contract Map governs how invocation facts reach those owners.

Each row records:

- consumer and semantic owner;
- runtime producer and source state;
- typed fact fields;
- model message role and placement;
- authority and trust;
- size and count bounds;
- persistence and provenance;
- prohibited content;
- deterministic and model-eval verification.

Initial contracts:

| Context | Owner | Role and placement | Authority | Principal exclusions |
|---|---|---|---|---|
| Entry facts | `entryDecision` | synthetic facts message associated with the current decision | read-only facts | Capability registry, task drafts, private lanes |
| Planner input | Capability Planner | Human input after the stable agent contract | facts and advisory plan | graph-private state, user-task execution tools |
| Outcome input | `outcomeDecision` | Human input after the stable decision contract | current evidence plus advisory future plan | Capability documents, plan-mutation policy |
| Answer context | `answer` | current facts after the invocation's canonical-history projection | typed reply mode and ordered accepted results | duplicate current-run handoff, arbitrary instruction |
| Delegation briefing | selected Capability | latest synthetic task-boundary message in its private lane | current task boundary | future plan and framework policy |
| Capability runtime facts | selected Capability | bounded context before the briefing | runtime facts | Capability or Toolkit policy text |
| Compaction summary | its downstream message consumers | synthetic context preceding newer retained messages | non-authoritative derived context | new policy, terminal meaning, current-user override |
| Auto-review facts | security reviewer | Human data after the trusted review policy | untrusted evidence | action text in the system policy |

## 7. Governance rules

1. **One model-facing actor, one prompt package.** A node's behavior contract,
   context renderer, and invocation ordering have one review location.
2. **Typed derivation does not grant system authority.** Code-derived state may
   select a mode; variable text remains an injected fact.
3. **Context cannot introduce policy.** New stable behavior changes the system
   contract; mechanical behavior changes runtime enforcement; provider behavior
   changes a bounded conditional protocol.
4. **Preserve canonical roles.** User requests stay Human, accepted handoffs stay
   AI in checkpoint state, task boundaries stay delegation briefings, and derived
   summaries stay non-authoritative context. A model invocation may replace a
   selected current-run handoff with an equivalent typed fact, but does not
   rewrite persisted history.
5. **Do not duplicate evidence.** Keep ordinary facts in canonical history. When
   a consumer needs an explicitly owned collection, project the selected items
   once and remove their original payloads from that model invocation.
6. **Bound every dynamic collection and text field.** Bounds are deterministic
   runtime constraints, not model instructions.
7. **Test structure and behavior, not prose presence.** A test may assert role,
   order, schema, bounds, absence of dynamic system data, transition, or model
   behavior. It should not require one natural-language clause merely to infer
   the intended result.

## 8. Node migration

### 8.1 Answer pilot

Answer is the first and urgent implementation of the governance contract. It
ships immediately after the minimum P0 Answer contract is agreed, before the
repository-wide migration:

- move Answer-specific rendering and invocation assembly from
  `runtime/nodes/answer.ts` to `prompts/answer.ts`;
- keep typed state projection and cleanup in the runtime node;
- remove workdir and runtime-environment data from the Answer system contract;
- route `goal_done` through Answer with canonical history plus a typed, ordered
  projection of the current run's accepted results;
- replace terminal prose injection with a bounded Answer facts message;
- delete `buildDelegationCompletionAnswerContext()`;
- replace prompt-phrase assertions with invocation-count, output, role, order,
  and dynamic-system-absence tests;
- add the long imperative browser task and an instruction-like task as model
  eval cases, without storing real tokens.

The P0.5 acceptance gate is narrow:

- the completed-task text never enters the Answer system message;
- `goal_done` produces a grounded task summary without dynamic system prose;
- other terminal modes receive only bounded typed facts;
- the reproduced trace-shaped case no longer turns completed work into a
  future-tense promise.

### 8.2 Entry, Outcome, and Planner

- rename runtime state assemblers to projection-oriented names;
- keep Entry, Outcome, and Planner rendering with their prompt packages;
- move Entry's current facts to the invocation position defined by its Context
  Contract after provider compatibility is verified;
- keep Outcome's advisory future-plan authority explicit;
- keep Planner's `CapabilityPlannerInput` as its typed dynamic context contract;
- delete the unused `buildUserRequestContext()` helper;
- do not mix Planner timeout, grep guidance, or tool-call scheduling changes into
  this migration.

### 8.3 Capability execution

`createSubagent()` concatenates every `promptSection` into one system prompt.
Only stable framework, actor, Toolkit, and Capability instructions may remain in
that collection.

- split the stable executor protocol from lane/workdir runtime facts;
- move lane, workdir, runtime environment, and artifact-discovery availability
  into bounded synthetic context messages;
- retain the current task only in the delegation briefing;
- keep system sections in deterministic framework -> actor -> registry order;
- verify that the system prompt is invariant across task, workdir, and runtime
  fact changes for the same actor/Capability/Toolkit contract.

### 8.4 Compaction

The summarizer's own system prompt remains a stable summarization contract and
the transcript remains dynamic input. Its generated summary must not become a
new system policy for downstream models.

- represent main compaction output as a provenance-tagged, non-authoritative
  context message rather than an arbitrary `SystemMessage`;
- audit and, if necessary, normalize the role emitted by LangChain subagent
  summarization middleware;
- preserve newer original messages and current-user authority;
- add provider-compatibility tests before changing persisted message roles.

### 8.5 Auto review

Trusted Toolkit review policy is a conditional system protocol. Current task,
workdir, tool inputs, URLs, and review descriptions remain bounded Human facts.
Policy sets must be sorted and deduplicated so an identical trusted policy set
has one representation. Untrusted action content must never enter that policy
block.

## 9. Safety and observability

The propagation contract and trace redaction are separate controls:

- a Capability executor may need an exact credential-bearing URL to perform the
  authorized task;
- Planner, Outcome, and Answer should not receive or repeat it unless their
  owned judgment requires it;
- tracing should redact authorization headers, cookies, API keys, and known
  credential-like query parameters without changing the executor's actual
  input.

Instrumentation records digests and sizes rather than duplicate raw context:

```ts
{
  node,
  systemPromptDigest,
  contextContract,
  dynamicContextChars,
  historyMessageCount,
  inputTokens,
  cachedInputTokens,
  latencyMs,
}
```

Stable cacheable prefixes are evaluated after ownership and message placement
are correct. They are an acceptance diagnostic, not the governing abstraction.

## 10. Verification

Deterministic suites protect:

- one prompt package per model-facing actor;
- no runtime-generated task, URL, result, or user text in system prompts;
- typed context variants with no arbitrary policy fields;
- message role, order, provenance, bounds, and omission;
- model-backed `goal_done` with canonical history and a closed summary mode;
- Capability system invariance across dynamic runtime facts;
- non-system compaction authority;
- untrusted Auto Review actions remaining outside the trusted policy block.

Model evals protect:

- completed imperative tasks do not become future-tense acknowledgements;
- instruction-like task text cannot redefine the consumer's contract;
- `user_input_required` preserves progress without claiming completion;
- newer user messages outrank older compaction summaries;
- supported model families preserve the same semantic results.

Provider diagnostics compare input tokens, cached tokens when supported,
latency, and cost. Cache-hit counts are not universal deterministic gates because
providers have different thresholds and cache implementations.

## 11. Delivery plan

1. **P0 governance baseline:** establish the Context Contract Map, ownership,
   locations, naming, and the minimum Answer facts/placement contract.
2. **P0.5 Answer containment:** ship the Answer-only fix and its regression
   coverage without waiting for the broader migration.
3. **Decision and Planner alignment:** separate runtime projection from prompt
   rendering and decompose the broad shared context module.
4. **Capability and compaction authority:** remove invocation facts from system
   sections and normalize summary provenance.
5. **Safety and minimum-propagation audit:** bounds, duplicated evidence,
   credential-bearing values, and adversarial context cases.
6. **Efficiency and observability:** stable digests, provider cache metrics,
   token overlap, latency, cost, and final Wiki validation.

Each implementation PR updates its affected raw design and tests. Wiki ingest
records accepted implementation state; it must distinguish this proposed target
from current code until the migration is complete.

## 12. Non-goals

- no general free-form product-policy injection API;
- no context-policy DSL for Capabilities or Toolkits;
- no change to Planner semantic ownership or tool-loop architecture;
- no change to delegation, announce, handoff, or outcome meanings;
- no keyword filter that attempts to recognize prompt injection by matching
  user text;
- no claim that stable message structure guarantees a provider cache hit.
