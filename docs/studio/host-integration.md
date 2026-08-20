# Studio Local-Host Integration

[简体中文](../zh-CN/studio/host-integration.md)

> **Status: current local-host behavior.** This page documents the shipped
> local adapter, not a transport-independent Studio API.

The Studio core contract is filesystem- and transport-independent. The
`@pinpawo/studio` package also exports the concrete local Host adapter that owns
file loading and runtime construction; local-agent supplies its optional wire
transport adapter:

```text
<workdir>/.pinpawo/{studio.json,pets/*.json}
      ↓ buildStudio()
Studio + PetAgentRuntime[] + configured plugins
      ↓ StudioRequestHandler
studio_request → dispatch(entryPetId) → studio_response acknowledgement
                                      ↘ studio.progress plugin events
```

This is the Studio form of the same `Host -> Agent Runtime -> Capability ->
Toolkit` ownership model used by Chat. Studio changes how one Host configures,
retains, and invokes several Pet runtimes; it does not introduce a separate
Toolkit or Toolkit Runtime system. See the accepted
[domain constraints](../design/host-agent-capability-toolkit.md).

## Assembly and lifetime

`buildStudio()` resolves the active workdir, reads its Studio and pet files,
creates one `PetAgentRuntime` per configured pet, and installs the configured
plugins. `StudioHost.init()` builds and holds the Studio before any transport
begins listening; requests only dispatch to this resident instance and do not
trigger assembly. The Studio lifecycle is owned by the Host, not created or
cached per request.

The host supplies a Studio-owned checkpointer when available. Chat and Studio
use separate checkpoint roots because they can run as independent processes.
At startup, each Host claims a lifetime writer lease for its checkpoint root and
fails fast if another Host owns it. `FileSaver` also serializes individual store
mutations with a filesystem writer lock. The Pet runtime uses the checkpointer
to determine whether `invoke()` has a pending continuation and therefore
whether its gate is `open`, `waiting`, or `blocked`. Studio itself never reads
or interprets a checkpoint. The Pet runtime keeps human review enabled, so
LangGraph may persist an interrupt and leave the gate at `waiting`. This state
does not depend on Chat Host memory and may remain pending until an external
control adapter resumes the same thread.

The built-in Studio transport does not accept Chat review/session messages.
An independent Studio plugin or Host adapter can inspect pending actions, emit
events to a user-facing integration, and resume through the Host-owned graph and
checkpointer. That control adapter is separate from the Studio core contract.

## Wire behavior

On a `studio_request`, the handler dispatches the user text to
`studio.entryPetId`. Once the request is accepted into Studio's per-pet queue,
it sends a `studio_response` with an empty `reply`. This is an acknowledgement,
not a final answer or a task-completion signal, even though the current wire
message uses `outcome: 'done'`.

The handler forwards dispatch gate changes as `studio.progress`. Plugin events
are forwarded only when they carry the exact correlation of an accepted request;
uncorrelated global events are not broadcast across peers. Consumers must treat this stream as
best-effort process-local notification, not a durable audit or a reliable
completion protocol.

Each accepted request receives an unguessable transport route ID that is passed
as the dispatch correlation. This prevents simultaneous workflows or peers from
being projected under another request ID. A plugin event without that explicit
correlation remains domain-global and is not attached to a request.

## Shutdown

Server shutdown stops the resident Studio via `StudioHost.shutdown()`.
Studio then rejects new dispatches,
stops plugins in reverse order, clears subscriptions, and releases waiting
queues instead of waiting indefinitely for external input. Queued dispatches
that have not started are discarded and cannot invoke a pet after shutdown.
Plugin startup failure rolls back the started prefix in reverse order. A host that owns
Toolkit runtime managers is responsible for their wider lifecycle.

The implementation contract and pluggable HITL control boundary are recorded in the
[independent Host runtime draft](../design/studio/independent-host-runtime.md).

See [Studio configuration](configuration.md) for workdir files and
[Studio API](../reference/api/studio.md) for the transport-independent contract.
