# Studio

[简体中文](../zh-CN/studio/index.md)

> **Status: current contract.** Studio is implemented by
> [`@pinpawo/studio`](../../packages/studio/src/index.ts) and assembled by the
> local host in
> [`buildStudio`](../../services/local-agent/src/studio/buildStudio.ts).

Studio is a small coordination substrate for multiple Pet runtimes. It keeps a
registry of dispatchable pets, serializes work per pet, and gives plugins an
in-process event bus. It is deliberately not a workflow engine.

```text
plugin ── notify(event) ──> Studio ── dispatch(request) ──> pet
```

`dispatch()` acknowledges acceptance with a `threadId`; it does not represent a
completed task. A pet reports useful domain outcomes through a Toolkit owned by
the relevant plugin. That plugin may update its own state and publish an event.

## Read in this order

- [Push model and boundaries](push-model.md) — the current coordination model,
  queue and gate semantics, event rules, and plugin lifecycle.
- [Configuration](configuration.md) — `studio.json`, per-pet files, validation,
  and the built-in Kanban plugin.
- [Local-host integration](host-integration.md) — workdir assembly, WebSocket
  acknowledgement and event forwarding.
- [Studio API reference](../reference/api/studio.md) — exported TypeScript
  types and exact method semantics.

## What Studio owns

- Validating the configured pet registry and the default `entryPetId`.
- Accepting dispatches unless Studio is stopped, the pet is unknown, or the pet
  is disabled.
- One FIFO queue per pet, while allowing different pets to run in parallel.
- Waiting for a runtime gate to reopen before sending that pet's next queued
  request.
- Starting configured plugins in order, stopping them in reverse order, and
  broadcasting plugin notifications without interpreting their payloads.

## What belongs elsewhere

The following are plugin or host responsibilities, not Studio concepts:

- task shapes, dependencies, progress, retries, timeout policy, and persistence;
- choosing which pet receives work (including planning);
- schedules, webhooks, HTTP/WebSocket transport, UI state, and authentication;
- shared knowledge stores or private agent scratch state.

The bundled `kanban` plugin is the first example: it is both a Toolkit that
pets use to manage Kanban tasks and a Studio plugin that dispatches tasks whose
dependencies are ready. Future scheduler or trigger integrations must use the
same plugin boundary rather than enlarge the Studio contract.

## Operational limits

Queues and event subscriptions are process-local and in memory. Dispatch has no
durable acknowledgement, backpressure, automatic retry, timeout, or terminal
result API. Plugin authors that need those properties must own the corresponding
state and policy. Restarting the local host also rebuilds its per-workdir Studio
instances.

The former run-controller, due-run scheduler, and shared-wiki design documents
describe the removed pull model. They are retained only in
[Studio history](../history/studio/) and do not define present behavior.

