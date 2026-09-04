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

Studio Host reads each document once during initialization and passes the
immutable content and digest into the resident Pet graph. A changed document
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

## Refactor handoff: shared system context

Status: PET.md loading is implemented; configuration propagation and common
prompt composition still need structural consolidation. PR #757 contains this
intermediate implementation. The following work is an agreed direction, not a
description of already-completed framework integration.

### Current implementation

- `services/local-agent/src/agentChannel.ts` converts the Host-loaded
  `PetDocument` into `OrchestratorConfig.systemPromptSections` and includes the
  document digest in the graph cache key.
- Entry Answer and final Answer explicitly pass these sections to
  `invokeOrchestratorModel` on each call.
- Run Supervisor passes sections through its node and Agent factory into
  `createOrchestratorModelInvocationMiddleware`'s closure.
- Capability copies the same sections into `createSubagent`'s `promptSections`.

### Open structural problems

1. **Three separate injection paths.** Generic naming removed PetDocument from
   role prompt builders, but each execution path still wires the sections
   explicitly. Adding common context can still require edits across nodes.
2. **Configuration lifetime and precedence are inconsistent.** Actor can come
   from graph construction or invocation `configurable`; sections come only
   from graph construction. Define which data belongs to the Pet definition,
   invocation context, and persisted state before moving fields. Loading a
   document once at startup does not require passing it through every factory.
   Reassess graph cache identity together with this change.
3. **Unrelated responsibilities share a middleware.**
   `modelInvocation.ts` combines delegation announce projection/tool protocol
   repair with system-prompt injection. They need independent ownership even
   when composed at the same model-call boundary.
4. **Composition has inconsistent contracts.** `createSubagent` validates
   section IDs, non-empty content, and duplicates; main model calls only join
   strings. The shared contract should define validation, ordering, and
   duplicate handling consistently.
5. **SystemMessage is flattened.** `withSystemPromptSections` rebuilds it from
   `.text`, discarding content-block attributes and message metadata. Preserve
   the original representation when composing common context.
6. **Framework propagation has not been verified.** The existing child Agent
   code forwards RunnableConfig and merges a separate runtime context, but the
   proposed shared middleware has not been proven across those boundaries.
   Earlier failed dependency-source searches are not evidence that automatic
   inheritance works.

### Intended implementation boundary

The Host supplies one typed Pet context at the root invocation. Reuse the
installed framework's supported runtime-context/config propagation mechanism,
with one shared accessor. Verify the installed LangChain/LangGraph APIs before
choosing between the existing `configurable` route and `contextSchema` route;
avoid introducing parallel sources or a process-global mutable Pet object.

A reusable system-prompt middleware reads that invocation's common sections.
Its definition can be shared across Agents; its data must remain scoped to the
current Pet. Register it at the relevant common Agent assembly points. Direct
model calls reuse the same context accessor and SystemMessage composer.
Message projection remains separately owned. Role builders own their role
prompts; business nodes should not extract and forward individual common fields.

Keep this follow-up focused on common prompt context. Model dependencies,
checkpointers, run state, and filesystem loading retain their own lifetimes.

### Acceptance evidence for the next session

- Adding another common system section requires no changes to Answer,
  Supervisor, or Capability node plumbing.
- Chat and Studio resolve their existing PET.md paths and reach every intended
  model role, including direct replies and resumed runs.
- Concurrent invocations for different Pets cannot see each other's context;
  dynamic child invocation preserves parent callbacks, cancellation, streaming,
  and its existing tool runtime context.
- Common sections appear once with consistent ordering and validation;
  SystemMessage content blocks and metadata survive composition.
- Delegation projection and tool protocol behavior remain independently tested.
- Test observable model inputs/context boundaries, not exact prompt wording.

Previous verification: the pre-consolidation implementation passed targeted
tests and Studio's 90-test suite. During consolidation the pet-agent suite had
472 passing tests and one new composition-test failure; that failure was fixed
and the targeted test rerun passed. Typechecks passed for pet-agent, local-agent,
and Studio. A full post-fix pet-agent run and the new propagation/isolation tests
are still required for the next structural change; these results are not model
eval evidence.
