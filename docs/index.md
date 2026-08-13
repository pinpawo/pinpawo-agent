# Documentation Index

This is the content-oriented entry point for repository documentation. Start with
the synthesized wiki for cross-document understanding; use the source catalog for
the original design and reference documents. Maintenance rules live in
[`AGENTS.md`](AGENTS.md), and chronological changes are recorded in
[`log.md`](log.md).

## Synthesized wiki

- [Documentation wiki](wiki/index.md)
- [Agent boundary contracts](wiki/agent-boundary-contracts.md) — validated
  transport-neutral Configuration, Invocation, Interaction, and State ports
- [Capability / Toolkit V2 architecture](wiki/capability-toolkit-architecture.md)
- [Interruption and delegation continuation](wiki/interruption-and-delegation-continuation.md)
- [System prompt design knowledge map](wiki/overview.md)
- [Orchestrator as practical reasoning](wiki/concepts/orchestrator-practical-reasoning.md)
- [System prompt authoring and evaluation principles](wiki/concepts/system-prompt-authoring-principles.md) —
  minimum generative contracts, positive judgment cues, and eval-backed changes
- [Dynamic context governance](wiki/concepts/dynamic-context-governance.md) —
  proposed ownership and placement contract
- [Message context and provenance](wiki/concepts/message-context-and-provenance.md) —
  completeness-first flow from canonical main evidence through User Goal,
  delegation briefing, private lane context, and accepted handoff
- [Orchestrator decision node ownership](wiki/concepts/decision-node-ownership.md)
- [Capability Planner task boundaries, structured results, and Capability selection](wiki/decisions/capability-planner-task-boundaries.md)
- [Delegation completion acknowledgement and terminal close](wiki/decisions/delegation-completion-acknowledgement.md)
- [Documentation wiki management plan](wiki/migrations/docs-wiki-management-plan.md)

## Pet Agent API

- [API reference index](PET_AGENT_API_REFERENCE.md)
- [API overview](PET_AGENT_API_OVERVIEW.md)
- [Pet runtime API](PET_AGENT_API_PET_RUNTIME.md)
- [Studio orchestrator API](PET_AGENT_API_STUDIO_ORCHESTRATOR.md)
- [Capability and toolkit API](PET_AGENT_API_CAPABILITY_TOOLKIT.md)
- [Plugin protocol](PET_AGENT_API_PLUGIN_PROTOCOL.md)
- [Events and HITL API](PET_AGENT_API_EVENTS_HITL.md)
- [Error handling and observability](PET_AGENT_API_ERROR_HANDLING.md)
- [CLI reference](PET_AGENT_API_CLI_REFERENCE.md)

## Orchestrator, decisions, and state

- [Pet Agent rewrite requirements](PET_AGENT_REWRITE_DESIGN.md)
- [Decision system prompt design](PET_AGENT_DECISION_SYSTEM_PROMPT_DESIGN.md)
- [Orchestrator terminal-semantics validation](ORCHESTRATOR_TERMINAL_SEMANTICS_DRAFT.md)
- [Orchestrator lifecycle composition eval](ORCHESTRATOR_LIFECYCLE_COMPOSITION_EVAL.md)
- [Decision shared prompt prefix](PET_AGENT_ORCHESTRATOR_DECISION_PROMPT_PREFIX.md)
- [Historical orchestrator route design](PET_AGENT_ORCHESTRATOR_ROUTE_DESIGN.md)
- [Announce judgment and explicit handoff](PET_AGENT_ANNOUNCE_JUDGMENT_REFACTOR.md)
- [Agent timeline refactor](AGENT_TIMELINE_REFACTOR_DESIGN.md)
- [Orchestrator recursion guard diagnosis](ORCHESTRATOR_RECURSION_GUARD_DIAGNOSIS.md)
- [Subagent limit framework](SUBAGENT_LIMIT_FRAMEWORK_DESIGN.md)
- [Subagent stream bridge analysis](SUBAGENT_STREAM_BRIDGE_ANALYSIS.md)

## Context, guards, and review

- [Dynamic context governance design](DYNAMIC_CONTEXT_GOVERNANCE_DESIGN.md) —
  proposed; not yet current implementation
- [Context governance refactor](CONTEXT_GOVERNANCE_REFACTOR.md)
- [Guard design](GUARD_DESIGN.md)
- [Guard registry design](GUARD_REGISTRY_DESIGN.md)
- [Human review approval refactor](HUMAN_REVIEW_APPROVAL_REFACTOR.md)
- [Toolkit HITL policy presets](TOOLKIT_HITL_POLICY_PRESETS_DESIGN.md)

## Capabilities, toolkits, and artifacts

- [Apply Patch tool implementation](apply-patch-tool-implementation.md) — current
  V4A-only single-file update contract, partial-hunk behavior, and compact result schema
- [Toolkit composition design](PET_AGENT_TOOLKIT_COMPOSITION_DESIGN.md)
- [Toolkit optional runtime lifecycle](TOOLKIT_RUNTIME_LIFECYCLE.md)
- [Daily post capability](PET_AGENT_DAILY_POST_CAPABILITY.md)
- [Capability artifact design](PET_AGENT_CAPABILITY_ARTIFACT_DESIGN.md) —
  historical draft
- [Capability artifact redesign](PET_AGENT_CAPABILITY_ARTIFACT_REDESIGN.md) —
  historical pre-V2 decision
- [Capability artifact store](PET_AGENT_CAPABILITY_ARTIFACT_STORE_DESIGN.md)
- [Capability artifact pipeline](capability-artifact-pipeline/index.md)
  - [Architecture](capability-artifact-pipeline/architecture.md)
  - [Store contract](capability-artifact-pipeline/store-contract.md)
  - [Compatibility notes](capability-artifact-pipeline/compatibility-notes.md)

## Studio

- [Studio architecture overview](PET_AGENT_STUDIO_ARCHITECTURE_OVERVIEW.md)
- [Studio interfaces](PET_AGENT_STUDIO_INTERFACES.md)
- [Studio orchestrator design](PET_AGENT_STUDIO_ORCHESTRATOR_DESIGN.md)
- [App Studio agents requirement](APP_STUDIO_AGENTS_REQUIREMENT.md)
- [App chat runtime UI](APP_CHAT_RUNTIME_UI_DESIGN.md)
- [Studio run controller redesign](STUDIO_RUN_CONTROLLER_DESIGN.md)
- [Run controller iteration plan](STUDIO_RUN_CONTROLLER_ITERATION_PLAN.md)
- [Run controller PR adjustments](STUDIO_RUN_CONTROLLER_PR_DESIGN_ADJUSTMENTS.md)
- [Studio due-run scheduler](STUDIO_DUE_RUN_SCHEDULER_DESIGN.md)
- [Local due-run scheduler plan](STUDIO_DUE_RUN_SCHEDULER_LOCAL_PLAN.md)
- [Studio app workdir iteration plan](STUDIO_APP_WORKDIR_RUNTIME_ITERATION_PLAN.md)

## Local agent and runtime configuration

- [Local agent architecture refactor](LOCAL_AGENT_ARCHITECTURE_REFACTOR_PLAN.md)
- [Local agent session projection](LOCAL_AGENT_SESSION_PROJECTION.md) — accepted
  source contract; current implementation is synthesized in the
  [wiki](wiki/local-agent-session-projection.md).
- [Workspace runtime configuration](WORKSPACE_RUNTIME_CONFIG_DESIGN.md)
- [Workdir-scoped runtime configuration](WORKDIR_SCOPED_RUNTIME_CONFIG_DESIGN.md)

## TUI

- [Local agent TUI architecture](LOCAL_AGENT_TUI_ARCHITECTURE.md)
- [TUI overhaul design](TUI_OVERHAUL_DESIGN.md)
- [TUI textarea architecture](TUI_TEXTAREA_ARCHITECTURE_DESIGN.md)
- [TUI textarea refactor status](TUI_TEXTAREA_REFACTOR_STATUS.md)
- [TUI alignment series](tui-overhaul/alignment/README.md)
  - [Snapshot contract](tui-overhaul/alignment/contract-1-snapshot-contract.md)
  - [Core contract tests](tui-overhaul/alignment/core-1-contract-tests.md)
  - [Timeline authority](tui-overhaul/alignment/core-2-timeline-authority.md)
  - [Run registry](tui-overhaul/alignment/core-3-run-registry.md)
  - [Snapshot adapter](tui-overhaul/alignment/core-4-snapshot-adapter.md)
  - [Reconnect reconciliation](tui-overhaul/alignment/core-5-reconnect-reconciliation.md)
  - [Core cleanup](tui-overhaul/alignment/core-6-cleanup.md)
  - [Core closure](tui-overhaul/alignment/core-7-core-closure.md)
  - [Status bar model](tui-overhaul/alignment/ui-1-statusbar-model.md)
  - [Screen model and layout](tui-overhaul/alignment/ui-2-screenmodel-layout.md)
  - [Input owner and Studio mode](tui-overhaul/alignment/ui-3-input-owner-mode.md)
  - [Timeline viewport](tui-overhaul/alignment/ui-4-timeline-viewport.md)
  - [UI alignment closure](tui-overhaul/alignment/ui-alignment-closure.md)

## External references

- [OpenClaw agent loop reference](references/OPENCLAW_AGENT_LOOP_REFERENCE.md)
- [Karpathy LLM Wiki method](wiki/sources/karpathy-llm-wiki.md)
- [Model prompting and harness references](wiki/sources/model-prompting-and-harness-references.md)
