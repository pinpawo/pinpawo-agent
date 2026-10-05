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
