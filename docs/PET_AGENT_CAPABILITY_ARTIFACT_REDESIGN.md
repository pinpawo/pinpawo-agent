# Capability Artifact Redesign

> Date: 2026-06-17
>
> Historical: Capability `afterRun`, `CapabilityContext`, and executable
> `resultSchema` were replaced by the V2 `lifecycle.finalize` boundary.
> Status: Implemented (PR #140, on top of PR #134)

## Decision

Capability artifacts are no longer registered through message markers such as
`additional_kwargs.pinpawo.capabilityArtifacts`.

Artifacts are produced **in code by the capability**, not by the model calling a
write tool. A capability writes through the store it receives on its
`CapabilityContext`, and the resulting ref reaches state via the artifact sink:

```text
capability code (in-loop ingest candidate compute -> afterRun persistence)
  -> CapabilityArtifactStore.writeArtifact(...)   // store from CapabilityContext
  -> CapabilityArtifactRef
  -> recordCapabilityArtifact(ref)  (artifact sink)
  -> SubagentResult.artifacts
  -> state.sessionCapabilityArtifacts
```

The orchestrator only consumes `CapabilityArtifactRef[]`. It does not parse
capability-specific messages, inspect private tool artifacts, or scan message
metadata for artifact registration.

### Announce vs artifacts

The completed subagent announce remains the natural-language result handoff to
the parent agent. The parent / `delegation_outcome` reads the current announce
text to decide whether the user goal is satisfied and how to answer. That current
announce must not be replaced by a bounded preview during handoff.

Artifacts are for payloads that should not live inline in the parent prompt:
large structured JSON, long reports, generated media, PDFs, bundles, and
cross-turn reusable material. The artifact ref carries a short preview for
routing and UI, while the full payload stays in the artifact store.

The two channels are complementary:

- announce: user-facing conclusion, key findings, status, and references to any
  artifacts created in the run;
- artifact: durable by-reference payload, optionally schema-validated when
  `kind: "result"`;
- orchestrator: reads the current announce text and bounded artifact refs by
  default; it does not read artifact full content unless a later delegated
  capability/tool explicitly does so.

If the final user answer depends on details inside a large artifact, the
subagent should either include the needed conclusion in announce or the parent
should delegate an explicit artifact-reading step. The runtime should not expect
artifact previews to reconstruct an omitted announce result.

`CapabilityArtifactStore` is injected through `OrchestratorConfig.capabilityArtifactStore`,
which `capabilityNode` forwards onto each capability's `CapabilityContext.artifactStore`.
The store stays a port — pet-agent core depends only on the interface, never on a
concrete adapter (the host wires the adapter). A surface without a store (e.g.
studio, tests) simply leaves it undefined and capabilities skip writes.

This removes untyped markers and message metadata registration. It does not
remove the ref collection mechanism: the capability calls the sink, the subagent
returns `SubagentResult.artifacts`, and the orchestrator merges those refs into
state.

### No artifact toolkit

There is **no** `capability_artifact` toolkit (no `_write` / `_read` / `_list`
tools handed to the model). It was removed: writes are deterministic in code, and
nothing needs the model to read its own just-written artifact back —

- during long runs, shared subagent summarization keeps a source-aware summary
  in model context, so the subagent can re-query a source with `view_file` etc.;
- cross-turn exploration does not inject a session inventory into entryDecision. After executor
  selection, local-agent may expose the existing current-thread artifact directory plus scoped
  read-only `artifact_list_dir` / `artifact_view_file_chunk` instances. The selected subagent
  decides whether to inspect it; their distinct names let them coexist with ordinary workspace
  `list_dir` / `view_file_chunk` tools without weakening the artifact-root boundary.

## Contracts

- `SubagentResult.artifacts` carries refs produced during the subagent run.
- `recordCapabilityArtifact(ref)` is the artifact-ref sink exposed by
  `CapabilityMiddlewareContext` (`afterRun`) and `ToolkitContext` (when a toolkit
  owns a durable result). Both push into the same
  `artifactRefs` array that becomes `SubagentResult.artifacts`.
- `CapabilityContext.artifactStore` is the store a capability uses to write bytes.
- `state.sessionCapabilityArtifacts` is the only cross-turn artifact state channel.
- `capabilityResult` is removed. Structured result consumers select a matching
  `kind: "result"` artifact ref by scope/schema and parse it with their schema.

### Multiple result artifacts

`state.sessionCapabilityArtifacts` is an index of refs, not a singleton result slot. A
single graph run may contain several `kind: "result"` artifacts because multiple
capabilities ran, one capability ran more than once, or one run intentionally
produced several structured outputs.

Consumers must select a result with explicit scope:

- `capabilityId` for "the result from this capability";
- `delegationId` / `turnId` for "the result from this specific run";
- `schema.name` + `schema.version` for "the result with this contract";
- `metadata.role` or another small metadata field when one capability writes
  several result artifacts with different meanings.

"Latest" is only meaningful after applying such a selector. There is no global
"latest result" contract across all capabilities.

When one capability execution has one logical structured outcome, prefer writing
one aggregate `kind: "result"` artifact whose JSON may contain arrays or nested
objects. Write multiple `kind: "result"` artifacts only when the outputs have
different contracts or independent consumers; tag them with distinct schema or
metadata so host code can select deterministically.

`CapabilityArtifactStore` is a single replaceable service port. A runtime uses
one adapter at a time, such as the local file adapter or a future S3/OSS
adapter. The port methods are intentionally async so cloud adapters can satisfy
the same contract:

```ts
type CapabilityArtifactStore = {
  writeArtifact(input): Promise<CapabilityArtifactRef>;
  readArtifact(params): Promise<{ ref: CapabilityArtifactRef; content: string | null }>;
  listArtifacts(params): Promise<CapabilityArtifactRef[]>;
  deleteThreadArtifacts(threadId): Promise<void>;
  getDownloadUri(uri): Promise<string>;
  writeArtifacts?(inputs): Promise<CapabilityArtifactRef[]>;
};
```

`readArtifact` is the LLM-facing text path and returns `content: null` for
binary artifacts. `getDownloadUri` is the UI/download path; the file adapter
returns a `file://` URL for local content, while cloud adapters should return a
signed URL.

## Source Fields

Artifact writes support two source forms:

- `content`: inline JSON, text, or `Uint8Array` bytes. Binary content is written
  as bytes and is not returned to the LLM by `readArtifact`.
- `externalUri`: remote URL reference for backend-owned media/object storage.
  The store records the URL and does not download or copy bytes.

`sourceUri` and `existingUri` are intentionally removed. Local file paths are not
accepted as artifact sources.

## Media Producers

Image and video generation tools should be self-contained producer tools.

- OpenAI-compatible image generation should normalize outputs to in-memory
  bytes before writing an artifact. `gpt-image-1` returns `b64_json`; DALL-E or
  compatible gateways should request `response_format: "b64_json"` when
  available. If a gateway only returns a temporary URL, download it immediately
  and write the resulting bytes as `content`.
- Backend-owned asynchronous media, such as daily post image processing that
  returns a CDN/object-storage URL, should write `externalUri` and should not
  copy bytes into the local store.
- Tools return refs, not base64 payloads, so large binary data does not enter
  the model context.
- `requireThreadId` checks must run inside each tool callback, not in the
  `tools(ctx)` factory body. Toolkit construction must not throw before the
  subagent decides whether it will use the tool.

## Schema Validation

`AgentCapability.resultSchema` remains the schema for `kind: "result"` artifacts.
The capability's own persistence code validates and writes payloads at its `afterRun`
boundary. There is no write tool, so validation lives at the single deterministic write
site in code rather than at a model-facing boundary.

## Capability Migration

Capabilities persist their result deterministically in code (issue #137), not by
instructing the model to call a write tool inside the loop:

- `daily_post` persists its result in an `afterRun` middleware: it takes the
  latest schema-valid `finalize_post` / `skip_post` tool artifact and writes it as
  a `kind: "result"` artifact via `ctx.artifactStore`. No model-facing write tool
  and no write instruction — the persistence is unconditional code.
- `capability_creator` does the same via `afterRun` (uses `['bash']`).
- `explore` persists through `afterRun` only. It performs one structured ingest
  from the shared LangChain context summary, recent tool results and final answer,
  then writes a `kind: "report"` artifact.

## Explore ingest

Explore consumes the shared subagent summary and owns only the **finalize** path
for durable run summaries.

**Trigger.**

- Shared LangChain `summarizationMiddleware` runs before subagent model calls when
  the token trigger derived from `contextWindowTokens` is reached. It persistently
  replaces older execution context and marks the summary with
  `lc_source: summarization`; it does not write artifacts.
- **Finalize persistence** runs once in `afterRun`, re-ingests the latest context
  summary, recent tool results and final answer, and writes one `kind: "report"`
  artifact with evidence metadata.

**What final ingest does.** It normalizes the compacted execution record into
**summary + evidence**, persisted as one artifact:
  - `kind: "report"`, `mimeType: "text/markdown"` — the prose summary.
  - structured **evidence** list, where each entry is `{ source, proves, value }`
    — the reference source, what it established, and why it matters to the
    reasoning. (Carried in the artifact's structured content / metadata; the
    markdown body holds the readable summary.)

(`status`, `summary`, `nextSteps`) is still not persisted as a `kind: "result"`
artifact; it is persisted as a `kind: "report"` artifact body (`content`) with
optional evidence metadata.

**Implemented shape.** `ingestExploreKnowledge` returns
`{ summary, evidence: { source, proves, value }[] }`. `afterRun` writes the
latest ingest payload via
`recordExploreIngestArtifact(artifactStore, middlewareContext, ingest)`
(summary → markdown content, evidence → metadata).

**Failure-safe.** If final structured ingest fails, Explore falls back to an
existing Explore/LangChain summary when available. `afterRun` catches store errors;
failed writes are non-fatal and the run keeps returning normal completion state.
