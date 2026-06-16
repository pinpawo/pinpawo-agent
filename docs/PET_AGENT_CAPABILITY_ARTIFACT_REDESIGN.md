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

- `daily_post` uses `capability_artifact` and instructs the subagent to write a
  JSON result artifact after `finalize_post` or `skip_post`.
- `capability_creator` uses `capability_artifact` and writes its final JSON
  result artifact through the same tool.
- `explore` keeps its context-ingest summary behavior, but no longer hand-builds
  artifact markers in message metadata.
