---
name: studio
description: 'Operate a running PinPawo Studio through its CLI: read Channels, address registered participants, inspect Pet progress and reviews, dispatch work, and observe execution.'
---

# Studio

Use the project CLI `pinpawo-studio` (Node.js 24+). Operator commands connect to
an already-running Host; they do not start or reconfigure it. Run
`pinpawo-studio channels --help` for supported options. Defaults: Studio HTTP
`http://127.0.0.1:3211`, Agent Session HTTP `http://127.0.0.1:3212`; override
`--studio-url`, `--agent-url`, and `--token-file` from the running Host's settings.
The CLI reads `~/.pinpawo/local-server-token` without printing its contents.
Connection flags may precede or follow operator commands. For example:

```sh
pinpawo-studio --studio-url http://127.0.0.1:3291 --agent-url http://127.0.0.1:3292 channels list
```

## Read and address Channels

```sh
pinpawo-studio channels list --limit 50
pinpawo-studio channels read CHANNEL_ID --after 0 --limit 50
pinpawo-studio channels participants
pinpawo-studio channels send CHANNEL_ID --file /tmp/message.md --mention PARTICIPANT_ID
pinpawo-studio channels executions CHANNEL_ID
pinpawo-studio channels interrupts CHANNEL_ID
pinpawo-studio queues
```

Read the current goal/scope and relevant history before acting. Reads return one
page; continue with `nextAfter` while `hasMore`. Channel history includes both
goal revisions and messages. Execution records change in place: refresh pages
from `after=0` to observe existing executions, rather than treating their cursor
as an incremental event stream. `observationLost` means an unfinished observation
belongs to an earlier Host instance; `deliveryError` is distinct from execution
failure. Check artifacts and public replies for acceptance evidence.

Resolve `participantId` from the registry; labels are display names. Repeat
`--mention` for multiple targets. `--reply-to MESSAGE_ID` supplies a reference,
not a recipient. Plain `@label` does not address anyone; valid direct Markdown
links such as `[@Reviewer](participant:pet:reviewer)` also address participants,
so inspect the body even when no `--mention` is passed. Code and quoted examples
do not address recipients. A send without valid addressing only saves a message.
Pet targets dispatch work; human targets do not. The response includes per-target
`deliveries`; saved/accepted does not mean execution completed. Ordinary replies
continue the Channel's existing Pet/session binding. Do not blindly retry an
uncertain send: independent sends create independent messages.

Channel interrupt notifications are historical, not current approval state.
The Pet snapshot command observes its active interactive session, which may
not be the Channel binding. Check session identity and use the original Pet
TUI/session for a Channel review; do not switch sessions or approve a different
review merely to unblock a queue.

## Inspect and coordinate

```sh
pinpawo-studio pets
pinpawo-studio snapshot executor
pinpawo-studio events executor --seconds 30
pinpawo-studio dispatch executor --file /tmp/task.txt
```

Snapshot prints a compact projection including the full pending interrupt; use `--full` for delivered
tool messages and other session evidence. Read actual code/test artifacts when
assessing delivery quality; a completed invocation alone is not acceptance.

A dispatch receipt only means work was submitted. Look for the session's active
run, live events, and actual delivery evidence to establish execution.
Queue `waiting` means pending interrupt; queue `blocked` means the Host could not
read settled session state. Preserve the user's scope; do not turn a request for
status into new work or an approval. Generic dispatch does not publish into a
Channel. See the
[Channel design](../../docs/design/studio/channel-addressing-and-execution.md) for
message/source semantics; keep the operational review rules below.

## Review and continue

Read snapshot first. For a human review, inspect each view and its actual options.
Submit only decisions covered by the user's authorization. Do not infer option
IDs, auto-approve an entire unknown batch, or change the global review policy to
unblock a task.

Send the existing Agent Session message using a JSON file:

```sh
pinpawo-studio send executor --file /tmp/resume.json
```

For `human_review`, the message has this shape (replace IDs from the snapshot):

```json
{
  "type": "interrupt.resume",
  "requestId": "a-new-unique-request-id",
  "interruptId": "from-pendingInterrupt",
  "value": {
    "decisions": [
      {"interactionId": "from-review", "selectedOptionId": "from-options"}
    ]
  }
}
```

Other interrupt kinds own their value shape; inspect the protocol/runtime
documentation for that kind rather than sending review decisions. Ordinary
interactive continuation without a pending interrupt uses `chat_request` with
requestId and message. Use `channels send` for Channel continuation.
`run.interrupt` uses the active run's requestId.

Agent Session sends and dispatch return 202 before execution finishes. Subscribe
to events before sending
when live feedback matters, then verify with snapshot. HTTP commands are owned
by the Host: leaving the SSE connection does not cancel the run. SSE is live
only, with no replay; after disconnect read snapshot again. Do not blindly retry
accepted commands or uncertain mutations. A 404 on these Agent Session routes
can mean the Host predates HTTP support; report that and arrange a controlled
upgrade, rather than taking over the TUI WebSocket connection.
