---
name: studio
description: 'Operate a running PinPawo Studio through its CLI: read Channels, manage and address members, inspect Pet progress and reviews, dispatch work, and observe execution.'
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
pinpawo-studio channels create --title "Release 1.0" --description "Ship it" --pet executor --pet reviewer
pinpawo-studio channels read CHANNEL_ID --after 0 --limit 50
pinpawo-studio channels members CHANNEL_ID
pinpawo-studio channels add-member CHANNEL_ID --member pet:wiki
pinpawo-studio channels remove-member CHANNEL_ID --member human:alice
pinpawo-studio channels send CHANNEL_ID --file /tmp/message.md --mention PARTICIPANT_ID
pinpawo-studio channels sessions CHANNEL_ID
pinpawo-studio queues
```

A Channel is a conversation among its members (humans and Pets); it has a title
and optional description, not a goal. Only current members can read it, speak or
be addressed, and only listed `--pet`s join a new Channel with you. Read the
description, members and relevant history before acting. Reads return one page;
continue with `nextAfter` while `hasMore`. The Channel holds only members' public
messages: a Pet's message is its final reply without tool calls; its tool calls,
progress and reviews stay in its Agent Session, which `channels sessions` locates
for each Pet. Check artifacts and public replies for acceptance evidence.

Resolve `participantId` from `channels members`; labels are display names. Repeat
`--mention` for multiple targets. `--reply-to MESSAGE_ID` supplies a reference,
not a recipient. Plain `@label` does not address anyone; valid direct Markdown
links such as `[@Reviewer](participant:pet:reviewer)` also address participants,
so inspect the body even when no `--mention` is passed. Code and quoted examples
do not address recipients. A send without valid addressing only saves a message.
Pet targets dispatch work; human targets do not. A Pet's reply that addresses a
member is delivered the same way. The response includes per-target `deliveries`
(not stored; also published as `channel.delivery` events); saved/accepted does not
mean execution completed. Ordinary replies continue the Channel's existing
Pet/session binding. Do not blindly retry an uncertain send: independent sends
create independent messages.

## Studio clients

```sh
pinpawo-studio clients list
pinpawo-studio clients add alice --label "Alice"
pinpawo-studio clients add-key alice
pinpawo-studio clients revoke alice
```

Each person or external program that connects is a Studio client; in a Channel
it is the member `human:<clientId>`, and the local token is `human:local`. Only
a registered, unrevoked client can be added as a human member. `add` and
`add-key` print a key once; hand it to that client and do not log it. A client
key works as `--token-file` for `channels` commands only; everything else needs
the local token. `revoke` stops all of a client's keys and keeps its history.

The Pet snapshot command observes its active interactive session, which may
not be the Channel's session. Check session identity and use the original Pet
TUI/session (or the Studio Console's Pet session view) for a Channel review; do
not switch sessions or approve a different review merely to unblock a queue.

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
[Channel model](../../docs/design/studio/channel-model.md) for
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
