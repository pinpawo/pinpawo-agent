# Model Profile Configuration

**Audience:** operators who need to configure a model or change the model for a
TUI session. The [Model profile contract](../reference/runtime/model-profiles.md)
owns stored fields, selection rules, and credential handling.

## Configure the default profile

1. Run `pinpawo init` if local configuration does not exist.
2. Open `~/.pinpawo/config.json`.
3. In `models.profiles`, configure the profile's endpoint, API key, and model.
4. Set `models.defaultProfileId` to that profile's ID.
5. Run `pinpawo setup` to diagnose missing configuration.

Use the [stored-format example](../reference/runtime/model-profiles.md#stored-contract).
The record key must match the profile's `id`. Keep the API key in local
configuration; do not commit it or copy it into reports.

Model credentials and endpoints come from stored profiles. Use
`~/.pinpawo/.env` for runtime settings.

## Native Anthropic

Set `protocol` explicitly to `anthropic-compatible` to use the Anthropic Messages API through
LangChain ChatAnthropic. This selects the Messages API transport for compatible
endpoints; compatibility does not imply support for every Anthropic extension or
for every model. Add a profile such as this under `models.profiles`:

```json
"claude-native": {
  "id": "claude-native",
  "label": "Claude native",
  "provider": "anthropic",
  "protocol": "anthropic-compatible",
  "model": "claude-sonnet-4-5",
  "baseUrl": "https://api.anthropic.com",
  "apiKey": "replace-with-a-local-secret",
  "contextWindowTokens": 200000,
  "maxOutputTokens": 8192,
  "structuredOutputMethod": "functionCalling",
  "inputModalities": ["text", "image"]
}
```

Use the API root as `baseUrl`; the SDK appends `/v1/messages`. Authentication
uses the SDK's native `x-api-key` header. Configure limits and modalities for
the actual model and endpoint you use. A provider label or Claude model name
never selects the protocol. Omitted `protocol`, or `openai-compatible`, keeps
the existing OpenAI-compatible transport, including Claude through gateways.

The first native integration supports text, image input, tool histories,
streaming/cancellation, and usage via LangChain. Structured output uses
`functionCalling` by default. The pinned LangChain integration also supports
`jsonSchema` through Anthropic's native JSON schema format. It accepts `strict`
only with function calling; `jsonSchema` callers should omit that option.
An explicit `jsonMode` is passed to LangChain, which currently warns and uses
`jsonSchema` instead. Prefer `jsonSchema` when native JSON schema output is
intended. Provider
extensions such as extended thinking, prompt-cache controls, server tools,
Bedrock and Vertex authentication are not exposed in this profile contract.

Function calling uses forced tool choice. Support for forced tool choice and
native JSON schema output depends on the actual model and endpoint. Profiles
are not rejected by model name, and configuration validation does not probe the
endpoint. Unsupported capabilities produce an SDK or endpoint error when used;
select the structured-output method supported by your endpoint.

### Streaming history limitation

Host chat uses LangChain's v3 event stream. The current Anthropic integration
has a separate limitation for direct legacy model `.stream()` calls without
bound tools: a returned `redacted_thinking` block may be dropped by the SDK.
Do not use that legacy stream to build multi-turn history when such blocks may
be returned; preserve the provider's complete message through a supported path.

### Model profiles and evals

The Host constructs five separate model roles for Agent work; context compaction
reuses the observe role. Profile-based decision and prompt evals use the same
`buildModel` factory and resolved profile. Scripted tests and mock models do not
make provider calls.

The legacy `orchestrator-route`, `orchestrator-flow.mock-subagent`, and
`structured-output-compat` eval scripts read OpenAI-compatible `LLM_*`/legacy
`llm_*` settings, not versioned profiles. The Langfuse route eval reuses the
legacy orchestrator-route entry. Use profile-based evals for Anthropic Messages.

## Select a profile at startup

If the profile already exists, select it for the process:

```sh
PINPAWO_MODEL_PROFILE=primary pinpawo tui
```

Replace `primary` with the stored profile ID. This selection does not change
`models.defaultProfileId`. An invalid selected profile blocks startup.

## Change the current TUI session

1. Wait until the session has no active run or pending human review.
2. Enter `/model` in the TUI.
3. Select an available profile that supports the session's input modalities.
4. Wait for the Host acknowledgement before continuing.

The session retains its selected profile when resumed. If the profile has been
removed or is invalid, select a valid replacement. For image-bearing sessions,
choose a profile that supports both text and image input.

## Look up contract details

The headings below preserve earlier links. Each points to the single current
reference; they do not duplicate the contract.

## Stored contract

See [Stored contract](../reference/runtime/model-profiles.md#stored-contract).

## Resolution

See [Resolution](../reference/runtime/model-profiles.md#resolution).

## Legacy migration

See [Legacy migration](../reference/runtime/model-profiles.md#legacy-migration).

## Safe identity

See [Safe identity](../reference/runtime/model-profiles.md#safe-identity).

## Runtime and session ownership

See [Runtime and session ownership](../reference/runtime/model-profiles.md#runtime-and-session-ownership).

## Local model-selection protocol

See [Local model-selection protocol](../reference/runtime/model-profiles.md#local-model-selection-protocol).

## TUI model selection

See [TUI model selection](../reference/runtime/model-profiles.md#tui-model-selection).

## Session modality ledger

See [Session modality ledger](../reference/runtime/model-profiles.md#session-modality-ledger).

## Canonical local image admission

See [Canonical local image admission](../reference/runtime/model-profiles.md#canonical-local-image-admission).

## Eval profile matrix

See [Eval profile matrix](../reference/runtime/model-profiles.md#eval-profile-matrix).
