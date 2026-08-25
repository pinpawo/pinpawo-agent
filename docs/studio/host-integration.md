# Studio Local-Host Integration

[简体中文](../zh-CN/studio/host-integration.md)

> **Status: current local-host behavior.** This page documents the shipped
> local adapter, not a transport-independent Studio API.
>
> **Accepted target:** the built-in Studio WebSocket/stdio transport, fixed
> per-Pet thread, and dispatch resume below are transitional. See
> [Resident Pet Host ports](../design/agent-runtime/resident-pet-host-ports.md).

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
                                      ↘ studio.invocation
```

`PetAgentRuntime` is the current transitional dispatch adapter. The accepted
target assembly is a local-agent-owned `ResidentPetHost` with separate
`dispatch` and `conversation` surfaces. Studio receives only `dispatch`; the
Agent Session/TUI path remains outside Studio. See
[Resident Pet Host ports](../design/agent-runtime/resident-pet-host-ports.md).

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

This direct construction is the current implementation, not the final ownership
boundary. During the accepted migration, local-agent exposes resident-runtime
and Agent Session interaction builders separately. Studio Host composition uses
both for each configured Pet, but supplies only the dispatch surface to Studio
core. The interaction adapter exposes its own Agent Session WebSocket inside the
same process. Studio must not gain a conversation registry or an Agent Session
dependency.

The host supplies a Studio-owned checkpointer when available. Chat and Studio
use separate checkpoint roots because they can run as independent processes.
At startup, each Host claims a lifetime writer lease for its checkpoint root and
fails fast if another Host owns it. `FileSaver` also serializes individual store
mutations with a filesystem writer lock. The Pet runtime uses the checkpointer
to execute against the Agent Session active thread and preserve pending
continuation state. Studio itself never reads or interprets checkpoint contents.
The Pet runtime keeps human review enabled, so LangGraph may persist an
interrupt and return a public pending projection. This state does not depend on
Chat Host memory.

Dispatch is one-way and has no resume input in the accepted target. The paired
local-agent Agent Session interaction presents and resolves pending interrupts
through its existing typed review/interrupt contract. Studio core and Plugins
do not construct graph resume commands.

The TUI conversation does not travel over the Studio wire. It connects to the
paired local-agent Agent Session WebSocket, may switch the resident Pet's active
thread, and has priority over dispatches that have not started. Active work is
non-preemptive. Later dispatches use the active thread selected by conversation.

## Current wire behavior (transitional)

The Studio-owned `studio.dispatch` message carries `petId` plus a typed
request/resume input, opaque metadata, and an optional idempotency key. Once
accepted, the handler sends `studio.accepted` with `petId`, stable `threadId`,
and current `invocationId`. This is an acknowledgement, not a final answer.
The historical Chat `studio_request` shape is not accepted.

The handler subscribes to the accepted receipt and forwards its invocation
changes as `studio.invocation`, including completed, waiting, failure,
and cancellation. Receipt observation replays the latest state, so progress
that races acknowledgement is still delivered after `studio.accepted`.

Producer metadata remains untouched and contains no transport route state.
Plugin events remain on Studio's independent in-process event bus; the request
transport does not implicitly attach a global Plugin event to one delivery. A
future external Plugin-event feed must define an explicit subscription and
replay contract. Consumers must treat the current invocation stream as
best-effort process-local notification, not a durable audit. The checkpoint
remains authoritative for a pending interrupt.

The target removes typed resume and `threadId` from the Studio dispatch
receipt/event. Studio control-plane dispatch and events move to the HTTP Plugin;
the built-in Studio WebSocket/stdio handler is removed. This section remains
only as an accurate description of code that has not yet migrated.

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
