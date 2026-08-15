# API Overview

> **Status: current integration map.** For exact types and behavior, use the
> specific reference page linked from here.

This page introduces the public boundaries of PinPawo Agent. It is a quick map,
not a replacement for the detailed contracts linked below.

For the project model, read [Core Concepts](../../concepts/core-concepts.md). For package and
runtime relationships, read [Architecture](../../concepts/architecture.md). The accepted
cross-host ownership rules are recorded in
[Host / Agent / Capability / Toolkit relationships](../../design/host-agent-capability-toolkit.md).

## Public surfaces

| Surface | Primary owner | Use it when |
|---|---|---|
| **Pet runtime port** | `@pinpawo/studio` + local-host adapter | You need to invoke or embed a single agent runtime. |
| **Studio runtime** | `@pinpawo/studio` | You need multi-Pet dispatch, per-Pet queueing, runtime gates, or plugins. |
| **Capability / Toolkit contract** | `@pinpawo/pet-agent` | You are adding a task boundary, tools, review policy, or Toolkit runtime. |
| **Local agent host** | `pinpawo` CLI package | You need local configuration, Capability loading, HTTP/WebSocket, or stdio transport. |
| **Session projection** | `@pinpawo/agent-session` | You are building a client that renders sessions, runs, and review state. |

## Boundary rules

1. **The Pet runtime owns execution.** It receives an actor, models,
   Capabilities, Toolkits, and input; it owns model calls, Capability selection,
   tool execution, and human-review continuation.
2. **Studio owns the dispatch channel, not workflow state or worker internals.**
   It validates pets, serializes work per Pet, observes runtime gates, and fans
   out plugin events without reproducing a worker's private tool or message
   history.
3. **Capabilities own task intent; Toolkits own executable behavior.** A
   Capability declares a static Toolkit allowlist. A Toolkit provides typed
   tools, availability checks, operation metadata, and policy.
4. **The local host owns machine integration and assembly.** CLI commands,
   local config, Capability/Toolkit selection, transport servers, and workdir
   choice belong outside the runtime-independent packages. A Browser driver or
   another Toolkit backend remains owned by that Toolkit Runtime; the Host only
   injects config and coordinates the generic lifecycle.
5. **Checkpoints are durable authority.** A session projection is a versioned
   materialized client view; it is not a second conversation store.

## Start from your goal

- Embed a single agent: [Pet Runtime API](pet-runtime.md)
- Run multi-agent coordination: [Studio API](studio.md)
- Build an extension: [Capability / Toolkit V2 contract](../extensions/capability-toolkit.md)
- Add a local Capability: [Capability directory protocol](../extensions/capability-directory.md)
- Consume tool activity or approval requests: [Events and human review API](events-and-review.md)
- Operate the local binary: [CLI reference](cli.md)
- Handle errors safely: [Error handling and observability](error-handling.md)

The complete list is maintained in the [API reference](index.md).
