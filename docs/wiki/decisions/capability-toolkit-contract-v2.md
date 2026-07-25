---
title: Capability and Toolkit Contract V2
page_type: decision
status: validated
updated: 2026-07-25
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
  a static list of required Toolkit names and one Markdown instruction document.
  It may expose one narrow `lifecycle.finalize` hook for deterministic result
  ingest and artifact finalization. It does not own tools, broad middleware,
  availability checks, dynamic instructions, or executable result schemas.
- A Capability never owns or creates a tool. Every tool visible to its subagent
  comes from a Toolkit named in its static `uses` contract.

All `uses` entries are required dependencies and permission boundaries. The target
contract does not support optional Toolkit dependencies or runtime filtering of
Toolkit names.

## Instruction ownership

`CAPABILITY.md` is the canonical directory authoring surface for Capability
metadata and instructions. Its frontmatter declares name, routing description,
Toolkit uses, display metadata, and an optional finalize-only code entry. Its
Markdown body is injected only after the Capability is selected.

Built-in or host-registered Capabilities may define the same immutable Markdown
`InstructionDocument` in code during registry construction. They do not use the
legacy manifest/index plugin protocol, and instructions cannot be generated from
per-run messages.

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

An optional Capability code entry may export only `lifecycle.finalize`. The hook
receives a read-only execution result and narrow finalization services; it cannot
access or mutate tools, Toolkit dependencies, review policy, authorizations,
system instructions, or `SubagentRunInput`. Model-invoked actions and external
business side effects remain Toolkit responsibilities.

## Registry semantics

Toolkit registration means that a Toolkit is present in the current environment;
it does not grant tool access. Capability `uses` and an explicit general-executor
Toolkit list grant access.

Dependency resolution, availability derivation, duplicate tool detection, policy
binding, and operation metadata binding happen before capability execution. The
orchestrator executes a compiled Capability and does not mutate its Toolkit set.
An invalid Capability executor is isolated in `unavailableCapabilities`; it does
not prevent healthy Capability executors or thread state reads from working.
Invalid general-executor authorization and invalid registered Toolkit definitions
remain fail-fast host configuration errors.

The host assembles run-scoped Toolkits and compiles the registry once for an
agent run setup. Routing, execution, thread-state reads, and diagnostics consume
that same compiled value. Host availability projections use the same preparation
and compiler for their explicitly declared scope instead of reimplementing
dependency checks. Core registry compilation remains pure: the host reports
`unavailableCapabilities` once per stable diagnostics fingerprint instead of
logging during compilation.

Run-scoped Toolkit registration is independent from whether that Toolkit
currently has data. In particular, Artifact Discovery is registered from an
artifact store plus thread scope. An empty thread is an empty discovery result,
not Toolkit unavailability. Capabilities that need it declare the required
`artifact_discovery` dependency statically.

A host projection without complete run scope reports `requires_scope`; it must
not guess that the Capability is available or reinterpret a missing run-scoped
Toolkit as an optional dependency. With complete scope, the projection is
derived directly from `CompiledAgentRegistry`, including duplicate-tool and
unknown-Toolkit issues.

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
- The migration branch implements the complete V2 cutover: static V2 types,
  breaking Toolset removal, `CAPABILITY.md`, immutable prompt sections,
  host-compiled registries, pre-route dependency filtering, run-scoped Toolkit
  registration, explicit general-executor authorization, and the final removal
  of the legacy runtime/loader contract.
- V2 ships as one breaking cutover. It does not retain a legacy loader, deprecated
  runtime fields, Toolset adapters, dual authoring protocols, or automatic
  conversion of old Capability plugins.

GitHub Issue #447 is the single umbrella issue and design source for this
Capability/Toolkit cutover. Implementation work may be split into linked child
issues, but those issues do not redefine the contract.

The canonical target contract, workstreams, and acceptance criteria are in
[`PET_AGENT_CAPABILITY_TOOLKIT_V2_DESIGN.md`](../../PET_AGENT_CAPABILITY_TOOLKIT_V2_DESIGN.md).
