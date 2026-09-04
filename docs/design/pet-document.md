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
input order, then execution-local sections in input order. Empty IDs/content
and duplicate IDs (after trimming) are errors, never silently skipped.

Role builders still own role content. Supervisor and subagent assembly register
the same reusable prompt middleware. Direct Entry/Answer model calls use the
same accessor and composer. Business nodes do not extract or forward common
sections. Every model call composes from its role message without mutating graph
history or accumulating common content over model turns. SystemMessage content
blocks and metadata are preserved via the framework message composition API.

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
