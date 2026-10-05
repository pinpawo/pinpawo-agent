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

## Validation

From the repository root:

```sh
npm test -w @pinpawo/studio-console
npm run typecheck -w @pinpawo/studio-console
npm run build -w @pinpawo/studio-console
npm exec -w @pinpawo/studio-console -- playwright install chromium
npm run test:browser -w @pinpawo/studio-console
npm run test:browser:layout -w @pinpawo/studio-console
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
