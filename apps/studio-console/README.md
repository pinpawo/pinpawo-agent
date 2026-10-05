# Studio Console

The existing browser Console consumes Studio HTTP and optional domain Plugin
APIs. Channel is the default page in this app, alongside Scheduler, Notice,
Trigger and Knowledge. Enable `@pinpawo-plugin/channel` on the Studio Host and
allow the Console's origin in the HTTP Plugin configuration. Enter the Host URL
and existing Studio Bearer token through the Console connection dialog.

Channel supports goal creation, the full message/revision history, saving notes,
explicit execution with a selected Pet, and replies to the source Pet's persistent
session. New requests in the same Channel/Pet pair reuse that session. Notes and
`@` text do not execute Pets. Public delivery bodies remain fully visible; they
do not certify that a model supplied every needed handoff detail.

The Channel page uses a 232px navigation column, a flexible conversation and a
collapsible 320px activity column. Only the conversation history scrolls above
its composer. Activity becomes a modal drawer below 1101px; Channel navigation
becomes a drawer below 701px. Both drawers and the creation dialog contain
keyboard focus, close with Escape, and return focus to the opening control.
Registered Pet names appear in messages and history. Duplicate names include
IDs in the selector; historical unregistered Pets retain their ID and a removed
marker. Message/session/invocation IDs stay in expandable technical details.
Quotes locate their original message, and activity links locate the stored
request and outputs for that exact invocation. Ordinary consecutive notes may
share a visual author group; every stored message retains its own ID and body.

Execution history records the latest observed state, including failure reasons.
Refresh reads persisted facts; it does not recover or resubmit work. Unfinished
records from an earlier Host instance show status unknown. Review notices are
historical: inspect and decide in the original Pet TUI/session. This page does
not resume approvals, publish their restored output, or automatically coordinate
multiple Pets.

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

The browser test starts this Console on port 5199 and a temporary production
resident Host + Channel SQLite + HTTP Plugin with two deterministic graph
responders. It checks creation, duplicate submission guards, note-only writes,
explicit Pet selection, reply ownership/session reuse, cross-Pet public context,
cross-Channel isolation, persistent execution failure, review guidance,
disconnect handling and execution after a Host restart with the original session.
It makes no LLM calls and uses no real credentials or user
state. Screenshots default to `/tmp/channel-console-screenshots`; override with
`CHANNEL_SCREENSHOTS`. `PLAYWRIGHT_BROWSERS_PATH` can select a writable browser
cache in restricted environments. Existing Host listeners on port 5199 must be
stopped before the test; the test does not replace them.

The layout browser test uses two independent temporary Hosts and stored fixture
history, including duplicate registered names and a removed Pet. It checks long
Markdown/code, 1440/900/390/320px layouts, fixed input, reading position across
SSE updates and global navigation, ID copying, quotes, request/output links,
drawer/modal keyboard focus, reply cancellation, Channel/Host switching, and
401/404 failures, navigation without the retired task page, and standalone
dispatch without publishing to Channel. It also makes zero LLM calls. Its screenshots stay local under
`/tmp/channel-console-layout-screenshots` (or `CHANNEL_SCREENSHOTS`); it does not
upload them. Run the two browser tests sequentially because both reserve port
5199. These fixtures do not validate live provider behavior or user acceptance.
