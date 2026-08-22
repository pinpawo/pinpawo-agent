# Documentation Wiki Log

Append-only record of source ingests, queries that produced durable synthesis,
lint passes, and documentation migrations.

## [2026-07-20] ingest | System prompt design knowledge

- Registered the Karpathy LLM Wiki method as an external source.
- Ingested current orchestrator prompt implementation, schemas, tests, core design
  documents, and the accepted PR/issue history from #338 through #404.
- Created the first system prompt knowledge map, core concept pages, an explicit
  completion-acknowledgement decision page, the entryDecision routing
  investigation, and open questions.

## [2026-07-20] migration | Documentation wiki foundation

- Added the documentation schema in `docs/AGENTS.md`.
- Added the master catalog in `docs/index.md`.
- Added a staged plan for managing all existing documents through ingest, query,
  lint, and migration workflows without bulk-moving current files.

## [2026-07-20] ingest | System prompt authoring principles

- Reviewed current official OpenAI, Anthropic, and Google model prompting
  guidance plus primary agent-computer-interface evidence.
- Added a positive-first authoring contract that distinguishes weak anti-only
  steering from necessary semantic, authority, and safety boundaries.
- Connected prompt clauses to harness ownership, deterministic enforcement,
  model-specific tuning, representative evals, and design traceability.
- Preserved the accepted fixed delegation-completion acknowledgement and scoped
  the entryDecision regression to the general existing-evidence/new-execution
  boundary.

## [2026-07-20] decision tracking | System prompt evolution issues

- Created #418 as the umbrella for evidence-based, owner-traceable system prompt
  evolution.
- Split delivery into #416 for the entryDecision evidence/execution correction,
  #417 for the positive-first V1 refactor, and #415 for the Prompt Contract Map.
- Kept the fixed completion acknowledgement, message provenance, graph ownership,
  and deterministic prompt/harness boundary as program invariants.

## [2026-07-20] simplify | Prompt Contract Map

- Replaced the proposed clause-level manifest with a five-column Markdown map in
  the system prompt overview.
- Made stable behavior contracts, rather than prompt sentences, the unit of
  traceability.
- Deferred dedicated lifecycle, model-scope, manifest, and lint concepts until a
  concrete missing relationship proves they are needed.

## [2026-07-21] implementation candidate | EntryDecision evidence boundary

- Replaced the broad recent-status-to-`answer` rule with a domain-independent
  sufficient-evidence versus new-execution boundary.
- Aligned the structured-output action description without changing the enum or
  graph transitions.
- Added cross-domain cases for explicit, absent, and stale evidence; replay;
  clarification; calculation; and one versus multiple execution boundaries.
- Recorded the prompt-size measurement and kept real-model route, latency, and cost
  validation open before promoting the investigation to `validated`.
- Preserved answer ownership, message provenance, and the fixed delegation
  completion acknowledgement.

## [2026-07-21] pilot | CapabilityDecision positive-first authoring

- Replaced the node anti-list with one capability-selection task and three short
  positive selection rules.
- Kept single-lane and available-candidate enforcement in schema and runtime
  validation instead of repeating those mechanics in prompt text.
- Added an eval case for a matching capability with missing execution parameters.
- Recorded the prompt-size measurement without changing the stable Prompt
  Contract Map row or claiming behavior improvement before real-model evaluation.

## [2026-07-21] pilot | CapabilityPlanner positive-first authoring

- Replaced the mixed anti-list and implementation terminology with the direct
  relationship among `next_task`, `remaining_plan`, and `deferred` work.
- Kept output-shape and duplicate enforcement in the schema, current-task
  materialization in runtime code, and executor selection in
  `capabilityDecision`.
- Added an eval case for grouping related actions into one capability execution
  task.
- Recorded the prompt-size measurement without changing the stable Prompt
  Contract Map row or claiming behavior improvement before real-model evaluation.

## [2026-07-21] refinement | CapabilityPlanner schema ownership

- Removed `result` and field-shape explanations from the production system
  prompt.
- Moved those relationships into model-visible schema descriptions and made
  `next_task` required-but-nullable for a stable output shape.
- Retained cross-field validation in runtime and semantic planning judgments in
  the node prompt.

## [2026-07-21] pilot | OutcomeDecision evidence ownership

- Reduced the production prompt to the evidence roles needed to judge the
  current task and overall user goal.
- Moved verdict and `gap_note` meanings into the model-visible schema and made
  `gap_note` required-but-nullable.
- Retained terminal gap normalization and graph transitions in runtime code.
- Added eval cases for sibling-result isolation and required user input.

## [2026-07-21] correction | OutcomeDecision gap compatibility

- Restored optional and nullable provider input for advisory `gap_note` values.
- Normalized missing, blank, and terminal-outcome gap values to `null` so the
  runtime output shape remains stable without rejecting compatible providers.

## [2026-07-21] pilot | Answer positive-first authoring

- Replaced static answer anti-rules with direct, handoff-synthesis, historical
  replay, and user-question reply modes.
- Preserved the provenance-triggered delegation completion acknowledgement as a
  distinct final main message.
- Rephrased completion and terminal contexts around their required content and
  status instead of repeated exclusions.
- Recorded the static prompt-size measurement without claiming behavioral
  improvement before real-model evaluation.

## [2026-07-21] pilot | Shared decision-prefix ownership

- Reduced the shared decision prefix to invocation-context use,
  structured-judgment scope, and graph/answer ownership.
- Removed the duplicated node sequence, verdict definitions, handoff mechanics,
  and glossary from the global production prompt.
- Added a focused prompt test for the retained shared contract and updated the
  accepted prefix reference document.
- Recorded per-node prompt-size measurements without claiming behavioral
  improvement before real-model evaluation.

## [2026-07-22] follow-up | System prompt V1 implementation closure

- Marked the node-by-node V1 ownership refactor as implemented after PRs
  #421, #423, #424, #426, #427, and #428 merged.
- Replaced the stale initial review backlog with the current prompt, schema, and
  runtime ownership split.
- Recorded the entry evidence boundary as an implemented contract while keeping
  its Wiki investigation in draft validation status.
- Moved cross-model accuracy, unnecessary-execution, repetition, token, latency,
  and cost validation to issue #435.

## [2026-07-22] refinement | Objective-derived eval targets

- Kept evaluation guidance inside the existing Prompt Contract Map and system
  prompt authoring principles instead of adding another Wiki concept.
- Defined case objectives as concrete instances of stable behavior contracts and
  made goal achievement the semantic pass/fail result.
- Separated run status, acceptance evidence, error classification, and
  diagnostics so measurable proxies such as length or overlap do not redefine
  task success.
- Mapped entry, planner, capability, outcome, and answer contracts to their
  concrete goal evidence, error taxonomy, and non-gating runtime metrics.

## [2026-07-23] refinement | Answer reply objective

- Kept the fixed post-delegation acknowledgement as a distinct final main
  message.
- Reduced the static answer prompt to its user-visible responsibility and
  canonical conversation evidence.
- Derived the current user goal, reply objective, and terminal status from
  runtime state without exposing orchestration vocabulary or identifiers to the
  answer model.
- Composed static and state-derived answer context into the leading system
  message so compatible chat providers receive one authoritative instruction
  boundary before the role-ordered conversation.
- Improved the comparable GLM-5.2 answer eval from 12/15 to 15/15 goals achieved;
  completion acknowledgement improved from 0/3 to 3/3 without regressing the
  other four answer behaviors.
- Kept the change within the existing `answer.user-visible-close` contract and
  prompt knowledge layers rather than adding another Wiki concept.

## [2026-07-23] ingest | Local-agent session projection

- Registered `LOCAL_AGENT_SESSION_PROJECTION.md` as the canonical topic contract
  and the projection implementation (`localAgentSession.ts`,
  `localAgentSessionReducer.ts`, `localAgentSessionParser.ts`,
  `reviewResolutionLifecycle.ts`, `localServerStdioTransport.ts`) as authoritative
  for runtime behavior.
- Ingested the closed issue history for the refactor line: umbrella #355 and
  sub-issues #377, #385, #386, #390, plus PRs #388/#389/#411/#425.
- Created a system overview page plus concept pages for the checkpoint/snapshot/
  timeline distinction, ownership boundaries, and the transport boundary; decision
  pages for the discriminated run-view union and client-local review resolution;
  and an open-questions page (TUI wire migration, future API projection guardrails,
  deferred snapshot coordinate, overlay cleanup #408).
- Added a current-authority banner to the source contract and updated both the
  root catalog and the wiki index. Did not modify the source's technical content.

## [2026-07-23] eval | GLM-5.2 V1 prompt contract baseline

- Fixed the canonical V1 profile at 34 cases across all five prompt contracts,
  with three repeats per case.
- Recorded evaluator ownership per criterion and kept schema failures, candidate
  recall, plan-shape measurements, output variation, tokens, and latency outside
  semantic goal judgment.
- Used deterministic scoring for exact structured decisions and
  `prompt-goal-v1` for free-form entry tasks, planner artifacts, and answers.
- Ran revision and harness
  `d54c6e38e8a26f5a6c0453112b8017ed0467170a` with GLM-5.2: 92/102 goals
  achieved, with no schema, invocation, or evaluator errors.
- Isolated stable failures in entry evidence freshness and planner task grouping,
  plus one variable answer clarification failure, without changing production
  prompts in the eval change.
- Confirmed in a final planner-only rerun that excluding derived plan diagnostics
  from judge input preserved the 15/18 semantic result and the same sole
  capability-grouping failure.

## [2026-07-24] validation | EntryDecision exclusion flow

- Replaced action-by-action routing prose with the ordered questions: new
  execution, unique execution target, then plan requirement.
- Kept schema descriptions at result semantics and left decision conditions in
  the node system prompt.
- Isolated mixed eval objectives so context recency, single-task actions,
  clarification, and planning boundaries are scored independently.
- Validated all 12 entryDecision cases with GLM 5.2 across three repeats
  (`36/36` goals achieved).
- Updated the existing prompt contract, ownership, authoring-principles, and
  state-query investigation pages without introducing a new wiki concept.

## [2026-07-25] maintenance | Prompt test ownership

- Removed deterministic assertions that treated natural-language prompt clauses
  as proof of routing, planning, verdict, or reply behavior.
- Kept unit coverage for prompt assembly, structured input shape, and separation
  of dynamic runtime facts from static system instructions.
- Assigned semantic prompt verification to the existing goal-based model evals.

## [2026-07-25] synthesis | Orchestrator practical-reasoning philosophy

- Added a draft philosophy that starts from the orchestrator's human problem:
  purpose, interpretation, situated knowledge, practical judgment,
  consequential action, distributed responsibility, time, and completion.
- Kept epistemic, causal, and normative boundaries as a compact technical
  projection within the philosophy rather than creating a competing ontology
  from the current capability architecture.
- Derived task, planning, result, handoff, outcome, and answer responsibilities
  from practical reasoning and goal acceptance rather than operation
  inventories.
- Reclassified the entryDecision follow-up as contested: its `36/36` GLM-5.2
  result remains valid for the explicit cases but does not establish
  generalization.
- Reopened the execution-boundary question for natural-language paired evals and
  a first-principles prompt revision.

## [2026-07-26] ingest | CapabilityPlanner result-bounded planning

- Registered the task-horizon design, PR #461 implementation, production prompt,
  schema/runtime mapping, six-case dataset, and shared semantic evaluator.
- Added a decision page that separates immutable completed-task facts from the
  mutable unstarted plan and defines task boundaries by returned results,
  ability continuity, and independently useful acceptance points.
- Removed stale Wiki guidance around `concrete | deferred`; current/future
  position now carries the temporal distinction.
- Updated the Prompt Contract Map and authoring principles so deterministic
  checks own exact result/shape while the goal evaluator owns plan semantics;
  fixed task count remains diagnostic.
- Recorded the accepted GLM-5.2 single-model baseline of three evaluable passes
  for each of six cases (`18/18`) and kept cross-model validation open.

## [2026-07-26] ingest | CapabilityDecision honest executor contract

- Refined the existing `capability.executor-selection` contract without adding
  a new Wiki concept: general and custom capabilities are peer executor forms,
  candidate retrieval is not proof of whole-task ability, and `unavailable`
  explicitly represents the absence of a suitable executor.
- Recorded schema/runtime ownership: only actual general availability and
  current custom candidates enter the selection enum; zero custom candidates
  use a deterministic `general | unavailable` fast path; executor descriptions
  support selection while runtime instructions and tools own execution.
- Updated the Prompt Contract Map, decision ownership, authoring/eval evidence,
  source registry, open questions, and both documentation indexes.
- Recorded the DashScope GLM-5.2 result of `24/24` scenario goals achieved:
  `18/18` model invocations plus `6/6` deterministic fast-path runs, with no
  schema, invocation, or evaluation errors.
- Kept cross-model validation open and did not add generated eval reports or
  private configuration to the Wiki.

## [2026-07-26] ingest | Orchestrator terminal outcome semantics

- Ingested the validated terminal-semantics design and PR #467 implementation
  into existing outcome, provenance, ownership, and answer-close concepts
  without adding a competing Wiki concept.
- Distinguished accepted handoff provenance from terminal meaning:
  `goal_done` is strict user-goal completion, while `user_input_required`
  returns control without claiming task or goal completion.
- Updated the practical-reasoning projection, Prompt Contract Map, graph view,
  completion-acknowledgement decision, decision ownership, message provenance,
  authoring evidence, source registry, and both documentation indexes.
- Recorded the paired GLM-5.2 result: all 32 evaluable outcome/answer runs
  passed; the single provider timeout passed on an isolated rerun. Genuine
  completion and required-user-input answer cases both achieved `3/3`.
- Preserved the fixed completion acknowledgement, kept static production prompt
  templates unchanged, and left cross-model validation open.

## [2026-07-27] ingest | Capability / Toolkit V2 architecture

- Registered the merged Capability / Toolkit V2 implementation from issue #447
  and PR #470 as the current architecture source.
- Added a validated system page covering the two extension concepts, static
  Toolkit composition, registry-generation availability, isolated compilation
  diagnostics, unified Capability execution, ordinary General, artifacts, and
  host responsibilities.
- Rewrote the public Capability / Toolkit contract and aligned the composition,
  local-host, pet-runtime, artifact-pipeline, prompt, and Wiki references with
  current code.
- Deleted the superseded `PET_AGENT_CAPABILITY_RUNTIME_DESIGN.md`; preserved its
  still-valid isolation and orchestration rationale in the synthesized system
  page instead of retaining obsolete `createRuntime / toolset / general
  executor` guidance.
- Updated both documentation indexes and the existing decision, provenance,
  practical-reasoning, authoring, source-registry, and open-question
  relationships.

## [2026-07-28] ingest | Interruption and delegation continuation

- Registered issues #465, #466, and #478; PRs #468, #475, #481, and #485; and
  the current local-server, orchestrator, protocol, TUI, and regression-test
  implementations as the authoritative interruption/continuation evidence.
- Added a validated system page separating interrupt intent, server-observed
  `interrupting`, terminal `interrupted`, checkpoint active-delegation state,
  and the TUI-local continuation affordance.
- Documented both end-to-end paths: ordinary `run.interrupt`, and
  `waiting_review` Esc consuming the review into a persisted canceled tool result
  and guard stop before graph abort and terminal settlement.
- Recorded that incomplete delegation lanes remain private checkpoint evidence
  without announce or handoff; ordinary input explicitly supersedes them, while
  `/continue <指导>` explicitly resumes the same delegation, run, lane, and
  provenance.
- Updated the session-projection, ownership, review-resolution, run-view, and
  checkpoint/snapshot, message-provenance pages, both indexes, and the open
  question around reconstructing continuation availability after a TUI process
  restart; aligned their shared-projection references with the current
  `@pinpawo/agent-session` package.
- Preserved the invariant that no client or timeout fabricates a terminal state:
  the invocation owner emits `interrupted` only after graph output settles.

## [2026-07-29] ingest | Capability Planner Agent ownership and workspace exploration

- Ingested issues #473/#490 and merged PRs #474/#477/#480/#483/#492 as the
  current Capability Planner architecture.
- Replaced the active Wiki graph and Prompt Contract Map with four semantic
  owners: entry result availability, Planner task-and-Capability deliberation,
  outcome verdict, and answer communication.
- Recorded the Capability Document Workspace and private bounded file tools as
  the model-explorable registry map; removed current guidance for coded
  relevance search, an independent Capability Decision, and `direct_task`.
- Made registered `general` the Planner-owned no-specialist path, restricted
  `unavailable` to a registry with no executable Capability, and removed Planner
  `answer` in favor of strict outcome-owned `goal_done`.
- Rewrote the Planner decision, ownership, authoring, source-registry, and open
  question pages; removed the superseded entry-routing investigation and every
  Wiki reference to deleted raw design sources.
- Validated all remaining Wiki frontmatter and local Markdown/source links
  after the ingest.

## [2026-07-31] ingest | Capability Planner standard agent and prompt contract

- Registered merged PR #515 and the current Planner prompt, structured-output
  harness, tests, and raw decision design as authoritative implementation
  evidence.
- Recorded the standard `createAgent` `responseFormat` / `structuredResponse`
  handoff and removed stale Wiki descriptions of a custom submission tool.
- Clarified the model-visible evidence boundary: `user_request` carries the
  current purpose, while recent messages and compaction summaries support
  reference resolution, continuity, and background.
- Derived the allowed terminal result schemas from the current Workspace:
  empty exposes only `unavailable`, registered `general` exposes only
  `next_task`, and another non-empty Workspace exposes both.
- Recorded deterministic Moonshot JSON Schema compatibility coverage while
  keeping cross-model exploration and planning quality open.
- Updated the existing Planner decision, ownership, knowledge-layer,
  authoring-principle, source-registry, open-question, and index pages without
  adding a new Prompt Contract Map row.

## [2026-07-31] ingest | Dynamic context governance proposal

- Added the raw dynamic-context governance design and synthesized its reusable
  ownership model into the Wiki.
- Established governance structure as the first priority: runtime projection,
  closed typed facts, consumer-owned rendering, explicit message authority and
  placement, and prompt-package-owned invocation assembly.
- Added a draft Wiki concept and Context Contract Map while preserving the
  existing Prompt Contract Map as the index of stable semantic behavior.
- Kept the terminal meanings and fixed `goal_done` decision accepted while
  recording the general authority conflict in the current Answer implementation.
- Updated prompt-layer, authoring, provenance, source-registry, open-question,
  overview, and index pages. Every page distinguishes current implementation
  from the proposed target; no production implementation is claimed.
- Kept issue progress, incident evidence, trace identifiers, and delivery stages
  outside the Wiki; those remain in the raw design and external tracker.

## [2026-08-07] ingest | Agent boundary contracts

- Registered accepted issue #570 and merged PR #572 with the current
  `agent-contracts`, pet-agent projection, agent-session, and local-agent
  implementations as the authoritative contract-layer evidence.
- Added a validated system page for the four transport-neutral boundary ports:
  Configuration, Invocation, Interaction, and State. Recorded the leaf-package
  dependency direction and the distinction between the shared port surface and
  Chat/Studio envelopes, graph construction, session reduction, and transport.
- Documented the public Human Review V2 boundary: presentation/input and
  `batchSubmission` leave the runtime; decisions/effects stay in the
  checkpointed internal `ReviewSpec`; client responses cannot supply them.
- Documented snapshot V4's valid V3 review migration, explicit public schema
  versioning, and the server-local `registerHumanReviewResolutionRoute` index as
  recoverable control state rather than a second durable review store.
- Updated the session projection, ownership, review-resolution, open-question,
  and documentation index pages. Raw historical review design documents were
  retained as sources rather than rewritten during ingest.

## [2026-08-08] ingest | Minimal generative prompt contracts

- Registered Anthropic's Claude Code quality postmortem as external prompting
  evidence. It records a bounded quality regression from global output-length
  constraints and separate failures involving reasoning effort and context
  continuity.
- Refined the system-prompt authoring principles around the minimum generative
  contract: purpose, relevant evidence, and successful outcome; positive
  judgment cues; and narrow negative boundaries only where safety, authority,
  or semantics require them.
- Rewrote the current Entry and Capability Planner prompt templates to express
  their existing contracts with concise, positive direction while preserving
  their structured-output and runtime ownership.

## [2026-08-09] ingest | Entry and Planner dispatch contracts

- Aligned the Wiki with the current Planner tool loop: `grep_search` returns
  complete Capability documents, while `submit_plan` and `return_to_answer`
  provide the two terminal planning outcomes.
- Recorded Entry's bounded, ephemeral Planner briefing and the typed boundary
  dispatch containing the completed task, accepted result, and remaining plan.
- Kept goal completion solely with Outcome: Planner may return planning-blocked
  or user-input facts to Answer, but cannot reinterpret `task_done` as an
  already-complete user goal.
- Replaced stale source paths and removed current guidance for the superseded
  `next_task` / `unavailable` result contract and multi-file exploration flow.

## [2026-08-13] ingest | Goal-to-delegation context completeness

- Registered draft PR #632, its Goal Creation design, and current working-tree
  implementation as implementation-candidate evidence rather than merged
  architecture.
- Recorded canonical main messages as the cross-delegation shared evidence
  ledger: accepted handoffs remain visible to later Capability subagents while
  raw transcripts from other private lanes remain excluded.
- Distinguished User Goal as a stable objective and attention index, delegation
  briefing as the current execution boundary, and the selected lane as private
  continuation memory.
- Adopted completeness before token deduplication at the Capability boundary.
  The target context is canonical main evidence plus User Goal, delegation
  briefing, and the current lane; Goal Creation must not replace source evidence.
- Recorded the current implementation gap: PR #632 requires `runUserGoal` to
  exist for Capability execution but does not yet project it into the subagent
  message context.
- Kept the ingest scoped to message context and provenance; the broader PR #632
  ownership and Prompt Contract Map migration remains a separate Wiki ingest.

## [2026-08-18] ingest | Context Injection Map as the context authority

- Registered `concepts/context-injection-map.md` as the authoritative per-node
  account of what enters each model's context window, validated against merged
  `main` after PR #664 and the PR #666 branch. Every claim was read from source
  rather than carried over from prior design documents.
- Adopted two orthogonal axes for classifying injected context: static /
  run-stable / dynamic, and instruction / boundary / fact / history. The second
  axis is what the existing `role=` / `source=` / `authority=` XML attributes
  already encode; the page makes that contract explicit.
- Recorded that one `<run_user_request>` string reaches three consumers with
  three different roles — Planner input body, Capability background, Answer
  target — and that the capability lane's `role="task_boundary"` attribute
  overstates its authority while message ordering carries the real layering.
- Recorded the three-writer run-goal lifecycle (provisional capture, the single
  authoritative `plan_request(goal)` write, snapshot replay on resume) and why
  the goal cannot drift within a delegation.
- Removed superseded context assembly from `concepts/message-context-and-provenance.md`:
  Goal Creation, `runUserGoal`, the `Gₜ = GoalCreation(...)` flow,
  completeness-first Capability context, and the PR #632 implementation gap. The
  page is now scoped to provenance/identity and interruption evidence, both of
  which remain valid, and is promoted from draft to validated.
- Removed the stale current-assembly survey from
  `concepts/dynamic-context-governance.md`. Answer's production path uses the
  typed `<answer_input>` message, not a legacy system-prose renderer, and the
  compaction summary is an `AIMessage` with `authority="none"`, not a
  `SystemMessage`. That page now keeps only the governance contract.
- Recorded two dead helpers as unverified surface rather than working behavior:
  `ORCHESTRATOR_DECISION_SHARED_PREFIX` is exported but unreferenced, and
  `buildDecisionConfig`'s `workdir` / `runtimeEnvironment` parameters are never
  passed; `workdir` reaches the model through capability `promptSections`.
- Left routing-architecture drift out of scope: `overview.md` still describes
  `entryDecision`, `outcomeDecision`, `return_to_answer` and `grep_search`, none
  of which exist in code. That is decision-node ownership rather than context
  assembly and needs its own ingest.

## [2026-08-18] ingest | Answer is a closer with no conversation history

- Updated `concepts/context-injection-map.md` and its maintained reference for
  the Answer node: its invocation is now exactly the system prompt plus one
  `<answer_input>` message, with no conversation history at all.
- Recorded the cause rather than only the new shape. Each completed turn left a
  near-duplicate pair in the main conversation — the subagent handoff and the
  reply Answer wrote about that handoff — so Answer was shown its own
  restatements and restated again. Measured 68% / 71% / 100% similarity across
  three pairs in one session, history at 5269 chars against 539 chars of
  accepted results.
- Recorded that the Planner action `answer_directly` was removed. Its contract
  was "answerable from the canonical main conversation", which made it the only
  route into Answer that required history; since #663 Entry Answer owns
  conversational replies, so it was already unreachable in production.
- Recorded the consequence: the compaction summary no longer reaches Answer.
  Re-showing an older result is a conversational request Entry Answer owns, and
  the summary still survives in canonical history for it.
- Framed the two extremes as deliberate opposites: Entry Answer gets
  conversation and no fact block because it decides what the goal is; Answer
  gets facts and no conversation because it only closes a decided run.

## [2026-08-22] ingest | Studio Pet thread and dispatch invocation identity

- Registered a draft Studio lifecycle in which each resident Pet owns one
  durable thread and every dispatch call is a distinct serialized invocation on
  that thread.
- Recorded review processing as a later dispatch invocation to the same Pet:
  the preceding invocation ends at a durable interrupt, while the Pet thread and
  checkpoint survive for resume.
- Consolidated identity roles: `threadId` for Pet continuity, `invocationId` for
  one Studio dispatch, `interruptId` for one checkpoint wait, and
  `interactionId` for one human-review item. Chat `requestId` remains transport
  correlation; Studio core defines no generic `correlationId`.
- Recorded explicit conflicts with current `createStudio()` behavior, the
  current Studio API reference, and issue #561 rather than rewriting them as if
  the proposal were already implemented.
- Fixed `PendingInterrupt` as the shared checkpoint fact. Human review is a
  payload and projection of that interrupt, not a parallel `ReviewAction`
  lifecycle.
- Scoped PR #682 and the client-local submission decision to Chat/TUI. Chat has
  an implicit active thread and neither `petId` nor Studio dispatch. Studio
  later reuses only the interrupt contract through its own dispatch envelope.
- Completed the Chat-side contract cleanup: emitted review events now carry one
  `PendingInterrupt`, responses name `interruptId` and ordered `responses`, and
  checkpoint recovery rejects interrupts without a real runtime ID instead of
  synthesizing identity from review content.
- Kept `requestId` outside `PendingInterrupt`: it is optional transport
  ownership on the active-run envelope and is rebound only when a response or
  cancel command is accepted, so resumed events can be correlated without
  creating a second review identity.
- Removed the server-side review lifecycle/result enum and reject-option
  shortcut. Every attempt reloads checkpoint authority, validates it, and
  resumes or cancels that exact interrupt.
- Created issue [#684](https://github.com/pinpawo/pinpawo-agent/issues/684) as
  the dedicated implementation and identity-consolidation tracker, related to
  but intentionally separate from the broader #561 host refactor.
