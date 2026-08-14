# Error Handling and Observability

> **Status: current integration guidance.** The runtime and Studio expose
> typed results and events where available; human-readable error messages are
> diagnostics, not a versioned machine protocol.

## Handle failures at their owning boundary

| Boundary | What to handle | Recommended response |
|---|---|---|
| Pet runtime | `invoke()` rejects, often because the pet is not dispatchable, execution is cancelled, or a review bridge is unavailable. | Show the user a bounded error, retain the session/run context, and offer a retry only when the caller can safely repeat the task. |
| Studio | `dispatch()` rejects only for a stopped Studio, unknown pet, or disabled pet. A runtime failure closes that pet's gate but is not a terminal dispatch result. | Show configuration / dispatch errors directly; let the owning plugin retain task state and decide human recovery or retry. |
| Capability loading | Validation or installation can reject an invalid `CAPABILITY.md`. | Run `pinpawo capability validate <dir>` and surface the structured validation errors. |
| Toolkit operation | Tool policy can require review, block an action, or let execution fail. | Render review separately from an operation failure; consume root events for diagnostics. |

## Capability compatibility

Capabilities use `CAPABILITY.md`. The removed `manifest.json` plus `index.js`
format is skipped by the loader with a migration diagnostic; it is not a valid
extension contract. See [Capability directory](../extensions/capability-directory.md).

## Observability

- Use Studio run events for queue and lifecycle state.
- Use normalized root tool lifecycle events for operation progress and errors.
- Use [Session projection](../runtime/session-projection.md) for recovery and
  client state, rather than replaying a transient event stream.
- Record safe identifiers such as run ID, thread ID, review ID, operation name,
  and high-level outcome. Do not put tool input, credentials, private artifact
  content, or full model context into telemetry by default.

## Do not parse prose errors

Messages can change as implementation detail. Prefer return types, run status,
validation output, and structured events. If a host must present an error,
retain the original error as operator diagnostic while presenting a clear
next action to the user.
