# Error Handling and Observability

> **Status: current integration guidance.** The runtime and Studio expose
> typed admission and runtime events where available; human-readable error messages are
> diagnostics, not a versioned machine protocol.

## Handle failures at their owning boundary

| Boundary | What to handle | Recommended response |
|---|---|---|
| Pet dispatch port | `dispatch()` rejects only when it cannot accept the input. Later execution failures and waiting state do not return to the caller. | Observe Agent Session runtime events and the resident gate; keep checkpoint recovery in Agent Session. |
| Studio | `dispatch()` rejects for a stopped Studio, unknown Pet, invalid request, or Pet admission failure. | Show admission errors directly; after a receipt, let Agent Session or the owning Plugin's domain state decide recovery. |
| Capability loading | Validation or installation can reject an invalid `CAPABILITY.md`. | Run `pinpawo capability validate <dir>` and surface the structured validation errors. |
| Toolkit operation | Tool policy can require review, block an action, or let execution fail. | Render review separately from an operation failure; consume root events for diagnostics. |

## Capability compatibility

Capabilities use `CAPABILITY.md`. The removed `manifest.json` plus `index.js`
format is skipped by the loader with a migration diagnostic; it is not a valid
extension contract. See [Capability directory](../extensions/capability-directory.md).

## Observability

- Use the resident gate for dispatch admission state and Agent Session events for Agent execution.
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
