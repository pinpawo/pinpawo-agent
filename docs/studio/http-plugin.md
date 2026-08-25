# Studio HTTP Plugin

[简体中文](../zh-CN/studio/http-plugin.md)

`@pinpawo-plugin/studio-http` is an optional zero-Toolkit Studio Plugin. It
provides a loopback HTTP dispatch endpoint, the read-only Studio Pet registry,
and a live SSE projection of the Studio Plugin event bus. It does not bundle a
domain page, but exposes a route hook through which another Plugin may
contribute one. It is not the Studio Host WebSocket/stdio transport.

## Assembly

```ts
import { createStudioHttpPlugin } from '@pinpawo-plugin/studio-http';

const plugin = createStudioHttpPlugin({
  port: 3212,
  allowedOrigins: ['http://localhost:3000'],
});
```

The application resolver returns this Plugin for its configured ID. The server
always binds `127.0.0.1`; `port: 0` selects an ephemeral port for embedding or
tests. Loopback calls are unauthenticated by default. An embedding that needs a
Bearer boundary can pass `authToken`; then dispatch, SSE, and contributed routes
require `Authorization: Bearer <token>`. Cross-origin browser requests must use
an exact origin listed under `allowedOrigins`; the Plugin's own loopback origin
is always accepted.

## Dispatch

```http
POST /dispatch
Content-Type: application/json

{
  "petId": "planner",
  "input": { "kind": "request", "request": "plan this work" },
  "idempotencyKey": "retry-1"
}
```

An accepted dispatch returns `202` immediately:

```json
{
  "petId": "planner",
  "threadId": "studio:demo:pet:planner",
  "invocationId": "..."
}
```

The HTTP connection does not own cancellation and does not wait for completion.
Optional producer metadata is only passed through and echoed when the caller
explicitly supplies it; the Plugin creates no HTTP-, frontend-, or Kanban-specific
correlation field.
Invalid JSON/dispatch shapes return `400`, unsupported media returns `415`, and
a Studio dispatch rejection returns `422`.

`GET /dispatches` returns the bounded in-memory read model for dispatches
accepted through this HTTP Plugin. A record starts as `queued`, becomes `busy`
when the Pet invocation begins, and ends as `completed`, `waiting`, `failed`, or
`cancelled`. This is Console observability, not a durable Studio queue: a Plugin
restart clears it, and dispatches produced by other Plugins remain in their own
domain projections.

## Pet registry

```http
GET /pets
```

This returns the current Studio registrations for control clients:

```json
{
  "pets": [{
    "petId": "planner",
    "name": "Planner",
    "role": "plans work",
    "serviceSummary": null,
    "startupMode": "standby",
    "status": "standby",
    "capabilities": []
  }]
}
```

The registry is read-only. It deliberately excludes Agent-private actor fields,
runtime references, checkpoint data, and execution context. `/pets` is owned by
the HTTP Plugin and cannot be replaced through the contributed-route hook.

## Plugin-contributed routes and static UI

The HTTP Plugin exposes a lifecycle-managed `routes` hook. Other installed
Plugins can contribute HTTP handlers without the HTTP Plugin importing their
domain. Every contributed route passes through the same optional authentication
and Origin policy; `/dispatch`, `/dispatches`, `/pets`, and `/events` remain reserved.

When the Kanban Plugin is also installed, it contributes `GET /kanban`, which
returns its current task snapshot and event cursor, plus `GET /kanban/events`
for Kanban-owned durable task history. Kanban still starts normally without HTTP,
and Plugin start order does not affect hook attachment.

The separate `static` hook accepts pre-packaged asset providers rather than a
browser-supplied filesystem path. `@pinpawo-plugin/kanban/console/studio-plugin`
is a zero-Toolkit Plugin that contributes its Vite bundle at `/`; it starts no
second server and the browser uses same-origin `/kanban`, `/pets`, `/events`,
`/dispatches`, and `/dispatch`. Static mount ownership follows normal Plugin lifecycle, so the
files disappear when the Console Plugin stops.

## Live events over SSE

```http
GET /events
Accept: text/event-stream
```

Each Studio Plugin event is sent as:

```text
event: studio.event
data: {"type":"task.done","source":"kanban","payload":{...},"occurredAt":"..."}
```

The HTTP Plugin also projects updates to its own dispatch read model as
`dispatch.updated` messages on the same live stream. Clients recover the current
state from `GET /dispatches` after connecting or reconnecting.

Unauthenticated loopback clients can consume this SSE endpoint with native
`EventSource`. When an embedding enables Bearer auth, use streaming `fetch`
instead because native `EventSource` cannot set a header. This is a live-only
feed: there are no durable IDs or `Last-Event-ID` replay. Disconnects can lose
messages, so the dispatch snapshot and domain-owned histories remain the recovery
paths.

See the [HTTP Plugin design](../design/studio/http-plugin.md) for lifecycle,
limits, and security invariants.
