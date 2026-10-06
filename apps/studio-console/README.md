# Studio Console

Independent browser frontend for Studio HTTP and optional domain Plugin APIs.
Channel is the default page, alongside Scheduler, Notice, Trigger and Knowledge.
Enable `@pinpawo-plugin/channel`, allow the Console origin in the HTTP Plugin,
and enter the Host URL and existing Studio Bearer token in the connection dialog.

[Channel design](../../docs/design/studio/channel-addressing-and-execution.md) owns
participant addressing, default Reply, fixed sessions, trusted input and limitations.
[Console design](../../docs/design/studio/console.md) owns layout, connection,
observation and keyboard behavior. Configuration and migration steps live in
[Studio configuration](../../docs/studio/configuration.md).

## Full-screen Channel messages

Each Timeline message offers **View full screen**, including while disconnected.
The read-only viewer uses the same safe Markdown renderer as the Timeline. Long
messages scroll vertically; wide code blocks and tables scroll within their blocks.
Tab stays in the viewer. Escape or **Close** restores the opening button and the
Timeline/document reading position; clicking blank space keeps the viewer open.

The viewer holds the body and participant names observed when opened, so incoming
updates do not change the text being read. Close and reopen to read the latest
stored message. Reading never sends a message or starts a dispatch.

## Validation

From the repository root:

```sh
npm test -w @pinpawo/studio-console
npm run typecheck -w @pinpawo/studio-console
npm run build -w @pinpawo/studio-console
npm exec -w @pinpawo/studio-console -- playwright install chromium
npm run test:browser -w @pinpawo/studio-console
npm run test:browser:layout -w @pinpawo/studio-console
npm run test:browser:message -w @pinpawo/studio-console
```

Both browser suites start temporary production Resident Host / HTTP / Channel
SQLite paths with deterministic responders. They use no real credentials, user
state or LLM calls, and close their fixture processes on exit. Run them sequentially:
both reserve Console port 5199 and refuse to replace an existing listener.

The functional suite covers default Reply without manual recipient selection,
changed/cleared and human recipients, same-session continuation, participant loops,
global cross-Channel queues, duplicate submission, failure, Review, reconnect and restart.
The layout suite covers duplicate/removed authors, long Markdown/code,
1440/900/390/320px, focus and drawers, quotes and ID links, reading position,
Channel/Host switching, 401/404 responses and standalone dispatch isolation.
These fixtures do not certify live provider behavior or user acceptance.

Screenshots stay local in `/tmp/channel-console-screenshots` (functional) and
`/tmp/channel-console-layout-screenshots` (layout); override with `CHANNEL_SCREENSHOTS`.
`PLAYWRIGHT_BROWSERS_PATH` selects a writable browser cache when needed.

The message viewer suite starts only an isolated frontend (port 5208, configurable
with `CHANNEL_MESSAGE_TEST_PORT`) and a synthetic HTTP/SSE fixture, without a
Studio Host or Pets. It checks desktop and 390×300/320×200 windows, keyboard focus,
independent scrolling, repeated opening, updates while reading and zero writes.
Screenshots default to `/tmp/channel-message-fullscreen-screenshots`.
`CHANNEL_BROWSER_EXECUTABLE` optionally selects an existing Chromium executable
with an isolated temporary profile.
