# Studio Console

The existing browser Console consumes Studio HTTP and optional domain Plugin
APIs. Channel is a fixed page in this app, alongside Kanban, Scheduler, Notice,
Trigger and Knowledge. Enable `@pinpawo-plugin/channel` on the Studio Host and
allow the Console's origin in the HTTP Plugin configuration. Enter the Host URL
and existing Studio Bearer token through the Console connection dialog.

Channel supports goal creation, the full message/revision history, saving notes,
explicit execution with a selected Pet, and replies to the source Pet's persistent
session. New requests in the same Channel/Pet pair reuse that session. Notes and
`@` text do not execute Pets. Public delivery bodies remain fully visible; they
do not certify that a model supplied every needed handoff detail.

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
npm run build -w @pinpawo/studio-console
npm exec -w @pinpawo/studio-console -- playwright install chromium
npm run test:browser -w @pinpawo/studio-console
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
