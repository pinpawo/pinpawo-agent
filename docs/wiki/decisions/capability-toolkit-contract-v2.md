---
title: Capability and Toolkit Contract V2
page_type: decision
status: validated
updated: 2026-07-24
sources:
  - ../../PET_AGENT_CAPABILITY_TOOLKIT_V2_DESIGN.md
  - ../../../packages/pet-agent/src/types/capability.ts
  - ../../../packages/pet-agent/src/types/toolkit.ts
  - ../../../packages/pet-agent/src/agent/orchestrator/subagentDispatch.ts
related:
  - ../concepts/prompt-knowledge-layers.md
  - ../concepts/system-prompt-authoring-principles.md
---

# Capability and Toolkit Contract V2

## Decision

The accepted target extension model exposes two author-facing concepts:
Capability and Toolkit.

- A Toolkit is implemented in code and is the only owner of tools, tool schemas,
  operation metadata, review policy, and Toolkit availability.
- Each Toolkit tool is represented by one framework-level `ToolDefinition` that
  binds its executable tool, operation metadata, and review policy.
- A Capability is a Skill-style behavior definition. It owns routing metadata,
  a static list of required Toolkit names, one Markdown instruction document,
  an optional result contract, and narrowly scoped lifecycle hooks.
- A Capability never owns or creates a tool. Every tool visible to its subagent
  comes from a Toolkit named in its static `uses` contract.

All `uses` entries are required dependencies and permission boundaries. The target
contract does not support optional Toolkit dependencies or runtime filtering of
Toolkit names.

## Instruction ownership

`CAPABILITY.md` is the canonical authoring surface for Capability metadata and
instructions. Its frontmatter declares name, routing description, Toolkit uses,
and display metadata; its Markdown body is injected only after the Capability is
selected.

Toolkit definitions remain code-owned. They may include concise code-defined
usage instructions, but do not participate in the `CAPABILITY.md` file protocol.
Toolkit instructions are one optional static string. Toolkit tools and
instructions are not runtime resources resolved from a general-purpose
`ToolkitContext`.

Host code may use ordinary factories such as `createStudioPlanToolkit(options)`
to capture application, session, or run dependencies. The returned
`AgentToolkit` is complete and immutable within its registry generation.

Static instructions and dynamic runtime facts remain separate prompt-knowledge
layers. A system-prompt compiler combines framework, runtime, Toolkit, and selected
Capability sections in a deterministic order.

## Registry semantics

Toolkit registration means that a Toolkit is present in the current environment;
it does not grant tool access. Capability `uses` and an explicit general-executor
Toolkit list grant access.

Dependency resolution, availability derivation, duplicate tool detection, policy
binding, and operation metadata binding happen before capability execution. The
orchestrator executes a compiled Capability and does not mutate its Toolkit set.

Toolkit registration and tool authorization remain separate. The V2 Toolkit
contract therefore removes Toolkit `exposure`; only Capability `uses` and the
explicit general-executor Toolkit list grant tool access.

## Consequences

- `AgentToolset`, `defineToolset()`, and `CapabilityRuntime.toolsets` are removed
  in the V2 cutover.
- `CapabilityRuntime.uses` moves to the static `AgentCapability` definition.
- `ToolkitResource` and the public `ToolkitContext` are removed. Runtime review,
  authorization, event, artifact, model, actor, and message infrastructure does
  not leak into Toolkit construction.
- Parallel tool, operation metadata, and per-tool review maps become one
  `ToolDefinition[]`.
- Toolkit availability uses a dedicated check whose lifecycle is owned by the
  registry, rather than reusing Capability availability and exposing cache
  policy.
- Existing private Toolsets become named Toolkits, including Daily Post,
  Capability Creator, Studio Plan, and Artifact Discovery.
- Explore-style environment-dependent tool filtering becomes explicit Capability
  scenarios with deterministic `uses`.
- Workstream 1 is implemented on the migration branch: the static V2 types and
  breaking Toolset removal are in place. Registry compilation,
  `CAPABILITY.md`, prompt sections, and the final cutover remain pending and
  must not be described as complete.
- V2 ships as one breaking cutover. It does not retain a legacy loader, deprecated
  runtime fields, Toolset adapters, dual authoring protocols, or automatic
  conversion of old Capability plugins.

GitHub Issue #447 is the single umbrella issue and design source for this
Capability/Toolkit cutover. Implementation work may be split into linked child
issues, but those issues do not redefine the contract.

The canonical target contract, workstreams, and acceptance criteria are in
[`PET_AGENT_CAPABILITY_TOOLKIT_V2_DESIGN.md`](../../PET_AGENT_CAPABILITY_TOOLKIT_V2_DESIGN.md).
