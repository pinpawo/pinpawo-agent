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

## [2026-07-24] decision | Capability and Toolkit Contract V2

- Accepted Capability and Toolkit as the only author-facing extension concepts.
- Made Toolkit the only tool owner and static `AgentCapability.uses` the required
  dependency and permission boundary.
- Rejected optional Toolkit dependencies and runtime Toolkit filtering in favor
  of explicit Capability scenarios.
- Chose Skill-style `CAPABILITY.md` authoring with a single Markdown instruction
  document and optional narrow code hooks.
- Recorded removal targets for AgentToolset, defineToolset, runtime uses/toolsets,
  implicit general-lane Toolkit exposure, and legacy capability scaffolding.
- Fixed delivery as one breaking cutover with no compatibility layer, deprecated
  dual runtime, legacy loader, Toolset adapter, or automatic plugin conversion.
- Kept GitHub Issue #447 as the single umbrella design source; implementation
  work may use linked child issues without creating a parallel contract.
- Defined `ToolDefinition` as the complete tool implementation, operation
  metadata, and review policy unit owned by a Toolkit.
- Removed `ToolkitResource`, public `ToolkitContext`, Toolkit `exposure`, and
  parallel per-tool metadata maps from the V2 target.
- Made Toolkit instances complete and immutable within a registry generation;
  host factories capture application, session, or run dependencies before
  registration.
- Reduced Toolkit instructions to one optional static string and separated
  Toolkit availability and review-time context from Capability/runtime
  infrastructure.

## [2026-07-24] implementation | Capability and Toolkit Registry V2

- Added a deterministic compiled registry for general and Capability executors.
- Moved registry compilation to host run setup; orchestrator routing and executor
  nodes consume the same compiled result.
- Made general executor Toolkit access explicit through `generalUses`; Toolkit
  registration alone no longer grants access.
- Excluded Capabilities with missing Toolkit dependencies or effective tool-name
  conflicts before route selection.
- Included run-scoped Artifact Discovery, Studio Plan, and Wiki Read Toolkits in
  the same dependency-resolution path.
