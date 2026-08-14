# Studio Local-Host Integration

[简体中文](../zh-CN/studio/host-integration.md)

> **Status: current local-host behavior.** This page documents the shipped
> local adapter, not a transport-independent Studio API.

The `@pinpawo/studio` package is filesystem- and transport-independent. The
local host owns file loading, runtime construction, and protocol adaptation:

```text
<workdir>/.pinpawo/{studio.json,pets/*.json}
      ↓ buildStudio()
Studio + PetAgentRuntime[] + configured plugins
      ↓ LocalServerStudioHandler
studio_request → dispatch(entryPetId) → studio_response acknowledgement
                                      ↘ studio.progress plugin events
```

## Assembly and lifetime

`buildStudio()` resolves the active workdir, reads its Studio and pet files,
creates one `PetAgentRuntime` per configured pet, and installs the configured
plugins. The local server keeps the resulting Studio instance alive per workdir
rather than rebuilding it for every request. A failed assembly is not cached,
so correcting the configuration allows the next request to try again.

The host supplies a shared checkpointer when available. The Pet runtime uses it
to determine whether `invoke()` has a pending continuation and therefore
whether its gate is `open`, `waiting`, or `blocked`. Studio itself never reads
a checkpoint or processes human-review payloads.

## Wire behavior

On a `studio_request`, the handler dispatches the user text to
`studio.entryPetId`. Once the request is accepted into Studio's per-pet queue,
it sends a `studio_response` with an empty `reply`. This is an acknowledgement,
not a final answer or a task-completion signal, even though the current wire
message uses `outcome: 'done'`.

The handler subscribes to Studio events and forwards each as `studio.progress`.
Those events are emitted only when a plugin calls `notify`; dispatching work
alone produces no progress event. Consumers must treat this stream as
best-effort process-local notification, not a durable audit or a reliable
completion protocol.

For a connected peer, the event bridge associates forwarded events with that
peer's most recent Studio request ID. If an integration needs independent,
durable correlation for simultaneous workflows, it must carry and persist its
own correlation in plugin domain state or event payloads.

## Shutdown

Server shutdown stops each cached Studio. Studio then rejects new dispatches,
stops plugins in reverse order, clears subscriptions, and releases waiting
queues instead of waiting indefinitely for human input. A host that owns
Toolkit runtime managers is responsible for their wider lifecycle.

See [Studio configuration](configuration.md) for workdir files and
[Studio API](../reference/api/studio.md) for the transport-independent contract.

