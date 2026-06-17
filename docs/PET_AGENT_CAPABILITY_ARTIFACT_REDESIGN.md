# Capability Artifact Redesign

> Date: 2026-06-17
> Status: Implemented (PR #140, on top of PR #134)

## Decision

Capability artifacts are no longer registered through message markers such as
`additional_kwargs.pinpawo.capabilityArtifacts`.

Artifacts are produced **in code by the capability**, not by the model calling a
write tool. A capability writes through the store it receives on its
`CapabilityContext`, and the resulting ref reaches state via the artifact sink:

```text
capability code (afterRun / context-pressure ingest)
  -> CapabilityArtifactStore.writeArtifact(...)   // store from CapabilityContext
  -> CapabilityArtifactRef
  -> recordCapabilityArtifact(ref)  (artifact sink)
  -> SubagentResult.artifacts
  -> state.capabilityArtifacts
```

The orchestrator only consumes `CapabilityArtifactRef[]`. It does not parse
capability-specific messages, inspect private tool artifacts, or scan message
metadata for artifact registration.

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

- under context pressure, ingest inlines the summary back into the model context
  and the summary names its sources, so the subagent re-queries a source with
  `view_file` etc. rather than reading the artifact through a tool;
- cross-turn "has this been explored before" is served by the artifact ref +
  preview that already lands in `state.capabilityArtifacts` and the orchestrator
  prompt, not by a toolkit.

## Contracts

- `SubagentResult.artifacts` carries refs produced during the subagent run.
- `recordCapabilityArtifact(ref)` is the single artifact sink, exposed under that
  name on every layer that can persist: `CapabilityMiddlewareContext` (afterRun),
  `CapabilityArtifactSink` on `ContextPolicyContext` (in-loop context-pressure),
  and `ToolkitContext` (if a toolkit ever needs it). All push into the same
  `artifactRefs` array that becomes `SubagentResult.artifacts`.
- `CapabilityContext.artifactStore` is the store a capability uses to write bytes.
- `state.capabilityArtifacts` is the only cross-turn artifact state channel.
- `capabilityResult` is removed. Structured result consumers read the latest
  `kind: "result"` artifact and parse it with their schema.

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
The capability's own persistence code validates the payload before writing: the
shared `recordLatestToolResultArtifact` helper runs `schema.safeParse` on the
candidate tool artifact and only writes a `kind: "result"` artifact when it
matches. There is no write tool, so validation lives at the single deterministic
write site rather than at a model-facing boundary.

## Capability Migration

Capabilities persist their result deterministically in code (issue #137), not by
instructing the model to call a write tool inside the loop:

- `daily_post` persists its result in an `afterRun` middleware: it takes the
  latest schema-valid `finalize_post` / `skip_post` tool artifact and writes it as
  a `kind: "result"` artifact via `ctx.artifactStore`. No model-facing write tool
  and no write instruction — the persistence is unconditional code.
- `capability_creator` does the same via `afterRun` (uses `['bash']`).
- `explore` does **not** persist a result on finalize. See "Explore ingest" below.

## Explore ingest

Explore's summarization is **context-pressure-driven only**, not a per-run
finalize step.

**Trigger.** Ingest runs only when the subagent loop reaches its context limit
(`contextPolicy.rewriteAsync`). A run that finishes naturally without hitting the
limit produces **no** summary artifact — the raw tool outputs are still in the
model context, and the subagent reports its conclusion through its returned text
/ announce. The orchestrator does not need a persisted artifact for small
explorations.

**What ingest does.** It is a *complete summary of what came before*, not a
lossy in-place compression:

- Summarize the earlier portion of the transcript; **keep the most recent N raw
  tool outputs** verbatim.
- The summarized earlier raw outputs are **removed from the model context**
  (they no longer cost tokens); they survive only as the artifact below.
- The ingest output is **summary + evidence**, persisted as one artifact:
  - `kind: "report"`, `mimeType: "text/markdown"` — the prose summary.
  - structured **evidence** list, where each entry is `{ source, proves, value }`
    — the reference source, what it established, and why it matters to the
    reasoning. (Carried in the artifact's structured content / metadata; the
    markdown body holds the readable summary.)

This removes the prior `finalize`-time ingest, the `buildFinalEvidence` final
pass, and the per-run result/report write. `ExploreResult` (`status`, `summary`,
`nextSteps`) is no longer persisted as a `kind: "result"` artifact on finalize.

**Implemented shape.** `ingestExploreKnowledge` returns
`{ summary, evidence: { source, proves, value }[] }`. `rewriteUnderContextPressure`
is the single place that emits the explore artifact, via
`recordExploreIngestArtifact(ctx.artifactStore, ctx.artifactSink, ingest)`
(summary → markdown content, evidence → metadata).

**Failure-safe.** Ingest runs inside the context-pressure rewrite, which has no
graceful fallback layer above it. The rewrite wraps ingest + persist in
try/catch: on any failure (model rate-limit/timeout, structured-output parse
error, store write error) it logs and returns the messages unchanged — keep the
raw outputs this round rather than aborting the whole explore turn. It records +
evicts before advancing the running summary, and evicts only the tool outputs the
summarizer actually saw (the char-budget-truncated tail is left intact).
