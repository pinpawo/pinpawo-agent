# Model Profile Configuration

PinPawo separates built-in model defaults from runnable user configuration:

- A **ModelPreset** is a code-defined template with model defaults and declared input modalities.
- A **ModelProfile** is a runnable identity with a stable ID, endpoint, credential, model, context limits, and input modalities.

Model names are not identities. Two profiles may use the same model name with different endpoints or accounts.

## Stored contract

`~/.pinpawo/config.json` stores model profiles in a versioned section:

```json
{
  "models": {
    "version": 1,
    "defaultProfileId": "primary",
    "profiles": {
      "primary": {
        "id": "primary",
        "label": "Primary",
        "provider": "aliyun",
        "sourcePreset": "qwen",
        "model": "qwen3.7-max",
        "baseUrl": "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "apiKey": "replace-with-a-local-secret",
        "contextWindowTokens": 1000000,
        "structuredOutputMethod": "jsonMode",
        "inputModalities": ["text"]
      }
    }
  }
}
```

The API key is host-private. It must never be included in client protocol payloads, logs, reports, or telemetry.

Profile IDs use 1–64 lowercase letters, digits, dots, underscores, or hyphens. The record key must match the profile's `id`.

`inputModalities` is authoritative. Custom profiles with no modality metadata are treated as text-only. Runtime code must not infer image support from a model name.

`provider` is display/provenance metadata. When omitted, it is derived from a known `sourcePreset` or the endpoint host.

## Resolution

- The configured default profile is used unless a host or session supplies another profile ID.
- `PINPAWO_MODEL_PROFILE` selects a stored profile without changing the configured default.
- A complete `LLM_API_KEY`, `LLM_BASE_URL`, and `LLM_MODEL` environment tuple creates an ephemeral `env` profile.
- The three environment values are atomic. Partial values are ignored and never overlaid onto a stored profile.
- An invalid non-default profile is isolated with diagnostics.
- An invalid or missing default/selected profile blocks startup; no other profile is selected silently.

## Legacy migration

When the versioned section is absent, the legacy `llm_*` fields are read as a synthesized `legacy-default` profile. The next successful interactive model configuration write persists the versioned section and removes those legacy fields. The two formats are not maintained as parallel writable sources.

Known presets carry explicit input-modality metadata into the synthesized profile. Unknown legacy/custom models remain text-only.

## Safe identity

Runtime consumers may use:

- the stable profile ID; and
- a SHA-256 fingerprint of the resolved, non-secret behavior configuration.

The fingerprint covers provider, model, sanitized endpoint, context/output limits, structured-output behavior, and input modalities. It excludes API keys, URL credentials, query parameters, and fragments.
