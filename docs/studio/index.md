# Studio

[简体中文](../zh-CN/studio/index.md)

> **Status: current contract.** Studio is implemented by
> [`@pinpawo/studio`](../../packages/studio/src/index.ts), which owns its Host,
> runtime assembly, and Plugin composition. It reuses local Host assembly
> through the public local-agent
> [`host-runtime`](../../services/local-agent/src/hostRuntime.ts) surface; the
> Pet Agent Session adapter is a separate `local-server-transport` surface.
> The `pinpawo-studio` executable entry also lives in this package. Concrete
> Plugins remain externally injected through `StudioPluginResolver`.

Studio is a small dispatch-admission substrate for multiple Pet runtimes. It
keeps a registry of dispatchable pets and gives plugins an in-process event bus.
The resident runtime owns queueing and the gate. Studio is deliberately not a
workflow engine.

```text
Plugin A ── notify(event) ──> Studio event bus ── subscribe ──> Plugin B
Plugin   ── dispatch(request) ──> Studio ── PetDispatchPort ──> Pet
```

`dispatch()` immediately acknowledges acceptance with a new invocation identity.
The receipt does not track execution. Agent activity is projected by Agent
Session events, while Plugin domain outcomes are reported through Plugin-owned
Toolkits and state.

## Read in this order

- [Independent Host runtime](../design/studio/independent-host-runtime.md) — Host,
  process, Plugin, dispatch, and interaction ownership.
- [Resident Pet Host ports](../design/agent-runtime/resident-pet-host-ports.md) —
  local-agent assembly between Studio dispatch and direct Pet conversation.
- [Configuration](configuration.md) — `studio.json`, per-pet files, validation,
  and Plugin injection.
- [Studio API reference](../reference/api/studio.md) — exported TypeScript
  types and exact method semantics.
- [HTTP Plugin design](../design/studio/http-plugin.md) — the single HTTP/SSE
  control plane and contributed-route boundary.

## What Studio currently owns

- Validating the configured pet registry and the default `entryPetId`.
- Accepting dispatches unless Studio is stopped or the Pet is unknown.
- One admission identity per accepted dispatch.
- Starting configured plugins in order, stopping them in reverse order, and
  broadcasting plugin notifications without interpreting their payloads.

## What belongs elsewhere

The following are plugin or host responsibilities, not Studio concepts:

- task shapes, dependencies, progress, retries, timeout policy, and persistence;
- choosing which pet receives work (including planning);
- schedules, webhooks, concrete HTTP adapters, UI state, and authentication;
- direct Pet conversation, Agent Session projection, and TUI transport;
- shared knowledge stores or private agent scratch state.

The optional `@pinpawo-plugin/kanban` package is the first example: its Plugin defines a
Toolkit that pets use to manage Kanban tasks, while the Plugin lifecycle dispatches
tasks whose dependencies are ready. The Plugin is not itself a Toolkit. Future
scheduler or trigger integrations must use the same Plugin boundary rather than
enlarge the Studio contract.

The optional `@pinpawo-plugin/studio-http` package is another concrete Plugin. It defines no
Toolkit; it projects `context.dispatch()` and `context.subscribe()` to an
authenticated loopback HTTP/SSE boundary. Studio core owns the lightweight
in-process Plugin event bus; HTTP is an ordinary subscriber and owns no database,
event queue, or domain history.

The Host registers only currently live, eagerly started
Pets. Studio neither reports lazy/disabled Pets nor publishes active Agent
Session thread identity. The HTTP Plugin becomes the Studio control-plane
transport; a separate local-agent Agent Session WebSocket in the same Host
process handles direct Pet conversation without entering Studio core.

## Operational limits

Idempotency records and event subscriptions are process-local and in memory.
Studio dispatch has no execution result, automatic retry, timeout, or durable
event replay. Resident queue/gate state, Pet checkpoints, and active Agent
Session threads belong to local-agent rather than those Studio projections.

The former run-controller, due-run scheduler, and shared-wiki designs are kept
only in [Studio history](../history/studio/) and do not define present behavior.
