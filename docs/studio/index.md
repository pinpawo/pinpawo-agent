# Studio

[简体中文](../zh-CN/studio/index.md)

> **Status: current contract.** Studio is implemented by
> [`@pinpawo/studio`](../../packages/studio/src/index.ts), which owns its Host,
> runtime assembly, and local transport adapters. It reuses local Host assembly
> through the public local-agent
> [`host-runtime`](../../services/local-agent/src/hostRuntime.ts) surface; the
> concrete local wire adapter is a separate `local-server-transport` surface.
> The `pinpawo-studio` executable entry also lives in this package. Concrete
> Plugins remain externally injected through `StudioPluginResolver`.

Studio is a small coordination substrate for multiple Pet runtimes. It keeps a
registry of dispatchable pets, serializes work per pet, and gives plugins an
in-process event bus. It is deliberately not a workflow engine.

```text
plugin ── notify(event) ──> Studio ── dispatch(request) ──> pet
```

`dispatch()` immediately acknowledges acceptance with stable Pet-thread and new
invocation identity. Its completion promise later settles the invocation; a Pet
may also report domain outcomes through a Toolkit owned by the relevant Plugin.

## Read in this order

- [Push model and boundaries](push-model.md) — the current coordination model,
  thread/invocation semantics, durable resume, event rules, and Plugin lifecycle.
- [Configuration](configuration.md) — `studio.json`, per-pet files, validation,
  and Plugin injection.
- [Local-host integration](host-integration.md) — workdir assembly, WebSocket
  acknowledgement and event forwarding.
- [HTTP Plugin](http-plugin.md) — direct dispatch and live Plugin events over SSE.
- [Studio API reference](../reference/api/studio.md) — exported TypeScript
  types and exact method semantics.

## What Studio owns

- Validating the configured pet registry and the default `entryPetId`.
- Accepting dispatches unless Studio is stopped, the pet is unknown, or the pet
  is disabled.
- One active invocation per Pet, while allowing different Pets to run in parallel.
- One stable durable thread per Pet and one identity per accepted invocation.
- Live invocation observation, including presentation-safe pending interrupts.
- Starting configured plugins in order, stopping them in reverse order, and
  broadcasting plugin notifications without interpreting their payloads.

## What belongs elsewhere

The following are plugin or host responsibilities, not Studio concepts:

- task shapes, dependencies, progress, retries, timeout policy, and persistence;
- choosing which pet receives work (including planning);
- schedules, webhooks, concrete HTTP adapters, UI state, and authentication;
- shared knowledge stores or private agent scratch state.

The optional `@pinpawo-plugin/kanban` package is the first example: its Plugin defines a
Toolkit that pets use to manage Kanban tasks, while the Plugin lifecycle dispatches
tasks whose dependencies are ready. The Plugin is not itself a Toolkit. Future
scheduler or trigger integrations must use the same Plugin boundary rather than
enlarge the Studio contract.

The optional `studio-http` package is another concrete Plugin. It defines no
Toolkit; it projects `context.dispatch()` and `context.subscribe()` to an
authenticated loopback HTTP/SSE boundary.

## Operational limits

Queues, idempotency records, and event subscriptions are process-local and in
memory. Dispatch has no backpressure, automatic retry, timeout, durable event
replay, or bundled interaction Plugin. Pet checkpoints and stable Pet thread
identity survive Host restart independently of those process-local projections.

The former run-controller, due-run scheduler, and shared-wiki design documents
describe the removed pull model. They are retained only in
[Studio history](../history/studio/) and do not define present behavior.
