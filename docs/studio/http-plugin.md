# Studio HTTP Plugin

[简体中文](../zh-CN/studio/http-plugin.md)

`@pinpawo-plugin/studio-http` is an optional zero-Toolkit Studio Plugin. It
provides a loopback HTTP dispatch endpoint and a live SSE projection of the
Studio Plugin event bus. It does not serve a web page and is not the Studio
Host WebSocket/stdio transport.

## Assembly

```ts
import { createStudioHttpPlugin } from '@pinpawo-plugin/studio-http';

const plugin = createStudioHttpPlugin({
  port: 3212,
  authToken: process.env.STUDIO_HTTP_TOKEN!,
  allowedOrigins: ['http://localhost:3000'],
});
```

The application resolver returns this Plugin for its configured ID. The server
always binds `127.0.0.1`; `port: 0` selects an ephemeral port for embedding or
tests. Both endpoints require `Authorization: Bearer <token>`. Browser requests
must additionally use an exact origin listed under `allowedOrigins`.

## Dispatch

```http
POST /dispatch
Authorization: Bearer ...
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

## Live events over SSE

```http
GET /events
Authorization: Bearer ...
Accept: text/event-stream
```

Each Studio Plugin event is sent as:

```text
event: studio.event
data: {"type":"task.done","source":"kanban","payload":{...},"occurredAt":"..."}
```

Because native `EventSource` cannot set a Bearer header, browser clients should
consume this SSE stream with streaming `fetch`. This is a live-only feed: there
are no durable IDs, `Last-Event-ID` replay, or invocation progress events.
Disconnects can therefore lose Plugin events.

See the [HTTP Plugin design](../design/studio/http-plugin.md) for lifecycle,
limits, and security invariants.
