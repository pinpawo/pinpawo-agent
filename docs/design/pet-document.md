# Pet root document

Status: draft

## Goal

`PET.md` is the canonical root document for one Pet. Its position is the same
as an `AGENTS.md` or `CLAUDE.md` loaded for an agent: authors use it to define
who this Pet is, what it is responsible for, how it should work, and which
durable conventions it should follow.

It is not a Capability supplement or a collection of routing hints. Every
model role acting as this Pet receives the same document before handling a
conversation or task.

## Convention

Each Host resolves the document according to its Pet topology:

```text
Chat:   <workdir>/PET.md
Studio: <workdir>/.pinpawo/pets/<petId>/PET.md
```

The Studio path is derived from the validated Pet id and is not repeated in
`pet.json`. Filesystem resolution belongs to each Host. Both modes produce the
same `PetDocument` contract before constructing the Pet agent.

Each Host reads its document once during initialization. It supplies the
content snapshot through runtime context on every root invocation. A changed document
therefore takes effect after the Host is restarted.

## Prompt scope

The same Pet document snapshot applies to every model role in one resident Pet:

- Entry Answer, including direct Chat replies;
- Run Supervisor entry and boundary decisions;
- Capability executor calls;
- the final Answer node.

`PET.md` is supplied as system-level authored root context, not as a user
message or task attachment. Framework governance still owns routing,
lifecycle, security, and tool protocol. Tool and Capability availability still
comes from the compiled registry rather than from claims made in the document.

## Responsibility boundaries

- `pet.json` contains machine configuration and identity references.
- `PET.md` is the Pet's root document: identity, responsibilities, operating
  principles, boundaries, and durable working conventions.
- `CAPABILITY.md` defines one discoverable execution responsibility and its
  Toolkit dependencies.
- repository `AGENTS.md` files describe rules owned by the project being worked on.

The default Studio template uses `PET.md` to keep Git worktree isolation at
Executor and Reviewer scope rather than duplicating it across their Capability
documents.

## Shared system context

Status: draft; implementation under review.

### Lifetime and ownership

Hosts read PET.md once at startup. Each root invocation (fresh input, stream,
continuation, or interrupt resume) supplies that snapshot as
`AgentInvokeInput.context.systemPromptSections`. Low-level graph callers supply
it through LangGraph's `context` option. This context is not graph state and is
not restored from checkpoints. A restarted Host supplies its newly loaded
snapshot when it resumes an existing thread.

`OrchestratorConfig` owns graph dependencies, not common prompt content. PET.md
no longer participates in graph cache identity: changing the invocation's
sections does not require recompilation. Existing model, Pet identity, registry
backend and other graph dependency cache boundaries remain unchanged.

There is one context source, with no graph-config fallback or mutable global.
Dynamic children preserve the parent's RunnableConfig and extend its runtime
context with execution scope and Toolkit runtime ports. Children cannot override
the root's common sections through their local runtime context.

### Construction

`src/runtime/context.ts` owns the typed framework context schema and accessor.
`src/types/systemPrompt.ts` defines the shared section schema, used by both
root context and execution-local sections. `src/prompts/systemPrompt.ts` owns
SystemMessage composition and its middleware adapter; `src/prompts/petDocument.ts`
formats the Pet document as a section. Order is role/framework instructions, common Host sections in
input order, the structured workdir projection, then execution-local sections in input order. Empty IDs/content
and duplicate IDs (after trimming) are errors, never silently skipped.

Role builders still own role content. Entry and final Answer role templates are
parameterless: they no longer receive an AgentActor or inject its display name.
Pet identity and authored behavior come from PET.md. The legacy decision-config
helper and its unused workdir/runtimeEnvironment arguments have been removed.
Host identity/configuration remains separate. `AgentActor` and its
invocation/review/finalize fields are removed. Display name and optional tracing
user attribution belong to the Host.
`CreateResidentPetRuntimeOptions.petId` supplies Host identity explicitly to
resident session initialization. Session ownership reads that Host Pet id;
Host metadata does not enter Agent configuration or review/finalize callbacks.
The default Pet Profile Toolkit and its cloud profile/memory/history fields have
been removed. PET.md is the authored persona source.

The Host resolves one effective workdir into `AgentRuntimeContext.workdir`.
The shared composer renders it once; Toolkit execution and review read the same
structured value. Host machine/session facts use common system sections, so Entry,
Supervisor, Capability executor and final Answer see the current environment.
There is no `runtimeEnvironment` configurable fallback or separate executor copy.
Supervisor and subagent assembly register the reusable prompt middleware. Direct
Entry/Answer model calls use the same accessor and composer. Business nodes do
not extract or forward common sections. Every model call composes from its role
message without mutating graph history or accumulating common content over turns.
SystemMessage content blocks and metadata are preserved via framework composition.

Delegation announce projection and tool-protocol repair remain separately owned
in `modelInvocation.ts`; prompt composition does not project Agent messages.
Subagent section diagnostics include common context without putting PET.md in
checkpointed message history.

### Verification scope

Acceptance covers direct model calls, actual Supervisor and child Agents,
concurrent Pets, repeated calls, root streams/callbacks/cancellation, and
checkpoint interrupt resume. Tests inspect model inputs and structured context,
not literal prompt prose. Host tests cover Chat and Studio file loading and the
invocation/cache boundary. No live-model behavioral evaluation is implied by
these deterministic checks.


### Review entry points

- [Context schema and root accessor](../../packages/pet-agent/src/runtime/context.ts)
- [Shared SystemMessage composer and middleware](../../packages/pet-agent/src/prompts/systemPrompt.ts)
- [Root context propagation into dynamic children](../../packages/pet-agent/src/subagent/systemContext.test.ts)
- [Host invocation and graph reuse tests](../../services/local-agent/src/agentGraphService.test.ts)

Validation on 2026-09-05: pet-agent 482 tests passed; Studio 90 passed;
local-agent 606 passed with 5 skipped. Local-agent's full suite requires local
port binding and process inspection and passed outside the filesystem/network
sandbox. Typechecks passed for pet-agent (including eval types), local-agent,
and Studio. External tracing was disabled for deterministic unit tests; no live
model evals were run.


The subsequent actor-identity cleanup passed the same 482 pet-agent tests,
90 Studio tests, and 36 targeted local-agent tests. These include executor
workdir injection and isolation of equal actor profiles with different Host Pet
ids. The three package typechecks, including pet-agent eval types, passed.

## Invocation configuration cleanup (draft, issues #760–#763)

All root entry points project invocation options through `buildAgentRunnableConfig`.
The local Host adds only interface metadata and tracing callbacks. The same turn
builder receives the requested trace identity for run, invokeState and stream;
resume commands keep their checkpoint transition semantics.

`AgentRuntimeContext.workdir` is the effective directory resolved once by the
Host. Toolkit execution and review scopes read this same structured value. The
common prompt composer renders it once as `framework:workdir`; executor prompt
assembly no longer repeats it. Host environment sections contain machine/session
facts, without a second workdir or global browser-backend lookup. They travel
through common runtime context together with PET.md, including Entry and Answer.
The previous `runtimeEnvironment` configurable/input text channel is removed.
Low-level graph callers migrate `configurable.workdir` to `context.workdir`;
`runAgent` callers use `input.context.workdir`. This slice preserves the existing
system-level workdir semantics; broader fact-placement governance remains #519.

`AgentActor` and the actor input/configurable/review/finalize chain are removed.
`CreateResidentPetRuntimeOptions` takes explicit `petId`/`petName`; optional
`traceUserId` stays in local Host setup and supplies tracing callbacks directly.
Host Pet identity still owns routing and durable session isolation. The default
Pet Profile Toolkit and personality/species/stage configuration are removed;
old JSON fields report migration to PET.md. serverBinding is rejected because
there is no active cloud synchronization consumer. Cloud memory/history shells,
growth/asset/date fields and the duplicate AgentExecution port are removed.
Checkpointed conversation history, Studio role/serviceSummary routing metadata,
and default Capability selection retain their existing owners.


Validation of #760–#763 and complete AgentActor removal on 2026-09-05:
pet-agent full suite 484 passed; Studio full suite 90 passed; local-agent full
suite 609 passed, 5 skipped. Regression coverage verifies concurrent execution
scope isolation, Host-only tracing attribution, and fresh workdir on checkpoint
resume while preserving the original trace identity. Explicit null continuation
inputs remain unchanged. All three package typechecks passed, including
pet-agent eval types. pet-agent and Studio ESM/declaration builds passed.
No live-model evaluations or suspended macOS companion checks were run.

## Host configuration resolution follow-up (2026-09-06 draft)

Host execution settings have one resolved contract, `HostExecutionConfig`:
`runtimeConfig` owns the effective workdir and durable paths; review mode,
authorization safety level and Capability registry backend are explicit Host
settings. `HostCapabilityAssembly` snapshots process defaults when constructed.
Chat and Studio forward this snapshot; Agent input construction consumes it
without consulting global configuration or resolving directories again.
`AgentLlmConfig` owns model settings only, not authorization policy.

Each resident owns one `LocalServerRuntimeDepsStore`. Conversation, session
projection and background dispatch read this same store. A policy update replaces
mode and safety level together; subsequent runs use the new snapshot while an
already-started run keeps its admitted configuration. Persistence continues to
save startup defaults; it does not mutate other already-running Hosts.

Migration: programmatic Hosts supply resolved settings through
`resolveHostExecutionConfig(runtimeConfig, settings)` (the settings argument may
be omitted only at a process composition boundary). `LocalServerDeps.workdir`
is removed; consumers use `runtimeConfig.workdir`. `createLocalServerHandlers`
accepts the shared store. Session services require runtime paths explicitly;
Host-specific session/checkpoint path overrides remain deliberate storage scopes.
Chat explicitly owns the existing `tuiCheckpointPath` adapter; the default session
service now uses that same adapter rather than constructing a second writer.
Studio retains its separate Host checkpoint root. Resident Hosts may supply their
own policy persistence port; persistence succeeds before the live store changes.
Registry/actor cleanup and graph cache invalidation are separate audit items.

Validation must cover conflicting process defaults versus explicit Host values,
independent Host directories and policies, and a policy change followed by both
conversation and background dispatch on the same resident.

Validation on 2026-09-06: local-agent 611 passed / 5 skipped; Studio 90 passed;
Studio cross-package acceptance 5 passed. The final affected channel/handler
suite passed 38 tests. Local-agent, Studio and acceptance-project typechecks
passed; local-agent runtime and Studio ESM/declaration builds passed. No live
model calls or macOS companion checks were involved.

The model-configuration audit follow-up removes the external `temperature` and
`subagentThinking` overrides, including the stored `subagent_thinking` reader.
Provider temperature defaults and the existing per-role thinking policy determine
model construction. This removes these two mutable inputs from graph cache
identity concerns; other graph dependency/cache concerns remain separate.
Validation for this follow-up: 63 model/config/channel tests and local-agent
TypeScript checking passed; live-model smoke was updated but not executed.

## Graph lifetime and internal iteration guard (2026-09-06 draft)

LocalAgentGraphService builds a graph from the supplied Host configuration for
each execution or checkpoint operation. It no longer caches graphs using a
manually assembled model/session key. This removes stale model credentials,
endpoints, request settings and runtime adapters from graph reuse decisions.
`graphKey` and `sessionContextCacheKey` are removed. Tracing uses the actual thread
id when available; a call without a thread does not invent a durable session id.
Checkpoint adapters remain Host-owned: constructing a graph does not reset state,
and continuation/resume still uses the same checkpoint thread and graph topology.
This trades graph construction work for explicit dependency lifetime; any future
cache must establish its necessity and a complete immutable dependency contract.

The main run iteration guard uses the internal `ORCHESTRATOR_MAX_ITERATIONS = 25`
constant. `maxRunIterations` is removed from graph and invocation contracts and
from their parsers, and the former default constant is no longer a package export.
The guard and Answer context use the same internal value. Tests exercise the
boundary using run state near the limit, not configurable production guardrails.

Resume validation also uncovered a Host boundary bug: every human-review response
installed an interrupt callback after its checkpoint was persisted. Only review
cancellation or an explicit interrupt request now installs that callback; ordinary
approval continues execution. TUI fixtures now use the current Host config store,
invocation context, required planning goal and checkpoint stream lifetime.

Validation: 485 core tests, 608 local-agent tests (5 skipped), 90 Studio tests,
5 Studio acceptance tests and 8 TUI Host tests passed. Core (including evals),
local-agent, Studio and TUI TypeScript checks passed, as did core and local-agent
ESM/declaration builds. Resume coverage includes explicit null continuation,
review approval/cancellation, repeated suspension, model/checkpointer replacement,
and process restart with persisted history.
