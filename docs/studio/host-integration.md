# Studio Local-Host Integration

[简体中文](../zh-CN/studio/host-integration.md)

> **Status: current local-host behavior.** This page documents the shipped
> local adapter, not a transport-independent Studio API.

The Studio core contract is filesystem- and transport-independent. The
`@pinpawo/studio` package also exports the concrete local Host adapter that owns
file loading, runtime construction, and the Studio wire protocol; local-agent
supplies only protocol-neutral loopback WebSocket/stdio framing:

```text
<workdir>/.pinpawo/{studio.json,pets/*.json,pets/<petId>/capabilities/*/CAPABILITY.md}
      ↓ resolveStudioHostConfig() + Host Toolkit inventory + buildStudio()
Studio + PetAgentRuntime[] + configured plugins
      ↓ StudioRequestHandler
studio.dispatch → typed dispatch(petId) → studio.accepted
                                      ↘ studio.invocation / studio.event
```

This is the Studio form of the same `Host -> Agent Runtime -> Capability ->
Toolkit` ownership model used by Chat. Studio changes how one Host configures,
retains, and invokes several Pet runtimes; it does not introduce a separate
Toolkit or Toolkit Runtime system. See the accepted
[domain constraints](../design/host-agent-capability-toolkit.md).

## Assembly and lifetime

`resolveStudioHostConfig()` reads Studio and pet files and resolves configured
Plugins. `StudioHost` then supplies every Plugin-defined Toolkit to the shared
Host inventory. Only after availability, provenance, and Toolkit Runtime startup
does `buildStudio()` create one `PetAgentRuntime` per configured pet and install
the configured Plugins. Before construction, the Host strictly loads each Pet's
conventional `pets/<petId>/capabilities/` collection. Directory membership is that
Pet's Capability selection; Plugins never contribute Capability definitions.
`StudioHost.init()` builds and holds the Studio before any transport
begins listening; requests only dispatch to this resident instance and do not
trigger assembly. The Studio lifecycle is owned by the Host, not created or
cached per request.

The host supplies a Studio-owned checkpointer when available. Chat and Studio
use separate checkpoint roots because they can run as independent processes.
At startup, each Host claims a lifetime writer lease for its checkpoint root and
fails fast if another Host owns it. `FileSaver` also serializes individual store
mutations with a filesystem writer lock. The Pet runtime uses the checkpointer
to validate whether a typed request or resume is legal for the current
continuation. Studio itself never reads or interprets checkpoint contents. The
Pet runtime keeps human review enabled, so LangGraph may persist an interrupt
and return a public pending projection. This state does not depend on Chat Host
memory and may remain pending until an external interaction adapter dispatches
a resume to the same stable Pet thread.

The built-in Studio transport does not accept Chat review/session messages. It
does accept Studio's own typed `resume_interrupt` dispatch. An independent
Studio Plugin or Host adapter can consume pending invocation events, interact
with a user, and submit that typed resume. The Pet runtime remains the component
that validates the checkpoint and constructs the graph command.

## Wire behavior

The Studio-owned `studio.dispatch` message carries `petId` plus a typed
request/resume input, opaque metadata, and an optional idempotency key. Once
accepted, the handler sends `studio.accepted` with `petId`, stable `threadId`,
and current `invocationId`. This is an acknowledgement, not a final answer.
The historical Chat `studio_request` shape is not accepted.

The handler forwards invocation changes as `studio.invocation`, including
completed, pending interrupt, failure, and cancellation, and correlated Plugin
events as `studio.event`. Plugin events are forwarded only when they carry the
internal route metadata of an accepted request; uncorrelated global events are
not broadcast across peers. Consumers must treat this stream as best-effort
process-local notification, not a durable audit. The checkpoint remains
authoritative for a pending interrupt.

Each accepted request receives an unguessable transport route ID that is passed
inside opaque metadata and removed before public forwarding. This prevents
simultaneous workflows or peers from being projected under another delivery ID.
A Plugin event without that internal route remains domain-global and is not
attached to a request.

## Shutdown

Server shutdown stops the resident Studio via `StudioHost.shutdown()`.
Studio then rejects new dispatches, cancels active invocations, settles queued
invocations as cancelled, stops Plugins in reverse order, and clears
subscriptions. Durable pending interrupts occupy no active queue slot and do not
block shutdown. Queued dispatches that have not started cannot invoke a Pet
after shutdown.
Plugin startup failure rolls back the started prefix in reverse order. A host that owns
Toolkit runtime managers is responsible for their wider lifecycle.

The implementation contract and pluggable HITL control boundary are recorded in the
[independent Host runtime draft](../design/studio/independent-host-runtime.md).

See [Studio configuration](configuration.md) for workdir files and
[Studio API](../reference/api/studio.md) for the transport-independent contract.
