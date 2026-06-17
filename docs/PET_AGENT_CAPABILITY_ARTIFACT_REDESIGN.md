# Capability Artifact Redesign

> Date: 2026-06-16
> Status: Implemented in PR #134 follow-up

## Decision

Capability artifacts are no longer registered through message markers such as
`additional_kwargs.pinpawo.capabilityArtifacts`.

Artifacts are created inside the subagent loop:

```text
subagent tool call
  -> capability_artifact_write
  -> toolkit-closed CapabilityArtifactStore.writeArtifact(...)
  -> CapabilityArtifactRef
  -> SubagentResult.artifacts
  -> state.capabilityArtifacts
```

The orchestrator only consumes `CapabilityArtifactRef[]`. It does not parse
capability-specific messages, inspect private tool artifacts, or scan message
metadata for artifact registration.

`CapabilityArtifactStore` is not an orchestrator config dependency. Artifact
tools capture the store through their toolkit factory closure, for example
`createCapabilityArtifactToolkit(store)`. Producer tools can follow the same
shape: generate the output, write it through the closed-over store, return a
short ref to the model, and push the ref into the subagent artifact sink.

This removes untyped markers and message metadata registration. It does not
remove the ref collection mechanism: tools still call the sink, the subagent
returns `SubagentResult.artifacts`, and the orchestrator merges those refs into
state.

## Contracts

- `SubagentResult.artifacts` carries refs produced during the subagent run.
- `ToolkitContext.recordCapabilityArtifact(ref)` is the sink used by artifact
  tools to attach refs to the current subagent result.
- `capability_artifact_write` writes the artifact and records the returned ref.
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
When a capability writes a result artifact through `capability_artifact_write`,
the write tool validates the payload before persisting it.

## Capability Migration

Capabilities persist their result deterministically in code (issue #137), not by
instructing the model to call a write tool inside the loop:

- `daily_post` persists its result in an `afterRun` middleware: it takes the
  latest schema-valid `finalize_post` / `skip_post` tool artifact and writes it as
  a `kind: "result"` artifact via the store it holds by closure. No
  `uses: ['capability_artifact']`, no write-tool instruction.
- `capability_creator` does the same via `afterRun` (keeps `uses: ['bash']`).
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

> Open implementation detail: `ingestExploreKnowledge` currently returns a flat
> `{ summary: string }`. The "summary + evidence" form needs its structured
> output widened to `{ summary, evidence: { source, proves, value }[] }`, and
> the context-pressure writer (`rewriteUnderContextPressure` →
> `replaceCompressedToolOutputs`) becomes the single place that emits the
> explore artifact through the injected store + sink.
