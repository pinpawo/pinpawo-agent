---
name: studio
description: 'Operate a running PinPawo Studio through its CLI. Find, create and read Channels, manage Channel-owned Pets, send messages, and verify replies, execution and reviews.'
---

# Studio

Use the project `pinpawo-studio` CLI (Node.js 24+) for an already-running
Host. Operator commands do not start, update, or configure it.

## Select and verify the target

- Get the intended Studio HTTP origin and credential from the actual workspace
  before acting. Multiple Studios on one machine can look alike. Do not guess
  an origin, use a test Host as a fallback, or assume the current checkout is
  the Host's workspace.
- Use a CLI built or installed from the Host's release. Resolve
  `pinpawo-studio` on PATH and inspect `channels --help`. If it is missing or
  stale, use the matching release's executable entry point
  `services/studio/dist/cli.js` with Node.js 24+; do not silently use another
  checkout, download a package, or substitute the `pinpawo` CLI. Help for this
  contract lists `channels create --workdir` and separate `pets create --channel`.
- Set `STUDIO_CLI` to that executable and set `STUDIO_URL` and
  `STUDIO_TOKEN_FILE` for the verified Host. A local Host typically uses
  `~/.pinpawo/local-server-token`; reuse the authorized file without reading
  its value into the conversation, echoing it, or putting it into a command
  argument. Supply the connection flags on either side of an operator command.

```sh
studio() {
  "$STUDIO_CLI" --studio-url "${STUDIO_URL:?}" --token-file "${STUDIO_TOKEN_FILE:?}" "$@"
}
studio channels list --limit 50
```

Before a mutation, check `viewerParticipantId` and the known Channel ID or
workspace evidence. If a list is empty or looks wrong, verify the Host and
identity instead of assuming the Channel should be recreated. An ordinary
client key lists its member Channels and live Pets; it cannot read global
queues, inspect Agent Sessions, set a Channel workdir, or manage Pet instances.
The local Host token has Studio authority and is normally `human:local` in
Channels. It does not replace Channel membership for reading the Timeline or
sending messages. The [Studio API](../../docs/reference/api/studio.md#studio-clients)
describes the permissions and read-only `GET /me` identity check.

## Find and read a Channel

Use returned IDs, not labels: `channelId` identifies the Channel,
`participantId` has form `human:<clientId>` or `pet:<petId>`, and
`messageId` identifies a message within its Channel. A reusable
`definitionId` is not a live `petId`. Match names to IDs using the directory
and current members. Confirm an ambiguous match before writing.

```sh
studio channels list --after "$NEXT_AFTER" --limit 50
studio channels read "$CHANNEL_ID" --limit 50
studio channels members "$CHANNEL_ID"
studio channels sessions "$CHANNEL_ID"
```

List returns one page; follow `nextAfter` while `hasMore`. Read starts at the
newest page. Use `--before "$NEXT_BEFORE"` while `hasEarlier` to read older
messages, or `--after "$NEXT_AFTER"` to catch up from a known page. Do not
combine the two. Read the description, members, and relevant messages before
acting; never substitute another Channel on a 403 or 404. Read only the pages
or Session evidence needed for the authorized work.

## Create an empty Channel, then add only requested participants

```sh
studio channels create --title 'Project review' --description 'Review project changes' \
  --workdir "$CHANNEL_WORKDIR"
# Use channel.channelId from the result as CHANNEL_ID; read it back.
studio channels read "$CHANNEL_ID"
```

The Channel starts with its human creator and no Pets. Omit `--workdir` to use
the Studio workdir. An explicit workdir requires the local Host token, refers
to the Host filesystem, is relative to the Studio workdir if not absolute, and
cannot be changed after creation. It is not a filesystem sandbox. Verify the
directory on the Host, not the CLI machine. A description is for people; a
Channel prompt is a separate Studio-authority collaboration instruction.
Neither grants tools or access, changes review policy, or authorizes an action.

If the user wants a Pet, list reusable definitions, then create a distinct
instance in this Channel. An existing Pet cannot be added to another Channel.
For a human, confirm the recipient is an active Studio client and use its
`human:<clientId>` participant ID. Do not add a Pet or human as a side effect
of an empty-Channel request.

```sh
studio pets definitions
studio pets create "$PET_ID" --definition "$DEFINITION_ID" --name 'Executor' --channel "$CHANNEL_ID"
studio channels add-member "$CHANNEL_ID" --member "$HUMAN_PARTICIPANT_ID"
studio channels members "$CHANNEL_ID"
```

Live Pet membership is projected from the instance. To retire a Pet, use
`pets close` (temporary, `pets reopen` restores the same identity, owner,
sessions and credentials) or `pets remove` (permanent; identity and history
remain and the ID cannot be reused). Removing a `pet:<petId>` with
`channels remove-member` is the same permanent action, not a simple detach.
For a live instance, only pass `--confirm-stop` after explicit consent to stop
its current work and cancel unstarted queued work. One call waits for business
stop and applies the final state. It does not answer a review. Inspect
`pets records` after an uncertain outcome; a failed stop is not a completed
close or removal. Normal Host shutdown is separate. For people,
`channels remove-member` removes that human membership; the last human
cannot leave. See the [Pet lifecycle reference](../../docs/reference/api/studio.md#pet-instances).

## Send and verify what actually happened

A send writes to the public Channel Timeline and can cause work. Do not post
test messages to check connectivity. Inspect the exact body, target and reply
before sending. `--file` reads the CLI machine’s file (or stdin via
`--file -`); unlike `--workdir`, it is not a Host-side path.

```sh
studio channels send "$CHANNEL_ID" --file "$MESSAGE_FILE" --mention "$PET_PARTICIPANT_ID"
```

`--mention` is repeatable and accepts an exact current-member participant ID.
A direct Markdown link such as `[@Reviewer](participant:pet:reviewer)` also
addresses that member; plain `@Reviewer`, quoted examples, and code do not.
Inspect the file even when you omit `--mention`. `--reply-to MESSAGE_ID`
links a message in the same Channel; it does not name a recipient.

- Online Pets independently decide whether to participate. A valid `@Pet`
  bypasses only the named Pet's participation check. It does not guarantee a
  reply or start work, bypass a review, interrupt a run, or change its input.
  Without `@`, a Pet may still answer or request execution. An offline Pet
  does not receive missed events on reopen; history remains readable. A Pet
  ignores its own messages; committed peer messages can still be considered.
- A public Head reply can answer directly, acknowledge, or state that the
  current ordinary dispatch is running or cannot be confirmed. It is not the
  Agent's final reply, an admission receipt, or a completion signal. A
  progress-only question does not dispatch; a separate request may queue.
  A direct Head reply can link back to its trigger. Do not infer a stage,
  outcome, or stop from it, or assume a resident final reply has a reply link.
- Resident work uses the (Channel, Pet) Session. Its public final reply can
  appear in the Timeline; tools, raw Session progress and reviews are not
  public messages. Check the Timeline for the actual reply and inspect the
  requested output or artifact before reporting delivery. A Session binding
  alone does not prove work started. See the
  [Pet Head behavior](../../docs/design/studio/pet-head-mechanism.md).

A send receipt is the saved message; it is not evidence of execution. After an
uncertain create, send, membership change or dispatch, read the authoritative
directory, Channel or execution state and match the exact ID before deciding
whether to retry. No command automatically retries a mutation. A new send
creates a new message; do not blindly resend if a reply is delayed or absent.

## Observe execution and review

- `studio channels sessions "$CHANNEL_ID"` identifies the exact Session for an
  owned Pet. `studio queues` is Studio-authority, global and read-only. It helps
  distinguish current and queued work, but waiting alone does not prove a
  particular approval is pending. If a read fails, treat status as unknown.
  Do not relay other Channels' IDs or private execution details.
- For an interactive Pet, use `studio --agent-url "$AGENT_URL" snapshot "$PET_ID"`
  or `studio --agent-url "$AGENT_URL" events "$PET_ID" --seconds 30`. Use the
  verified Agent Session origin, not the Studio HTTP origin or CLI default.
  Use `--full` only when the scoped work needs more than the compact snapshot.
  The active interactive Session may not be the Channel's. For a Channel
  Session, use the exact-session [Studio API](../../docs/reference/api/studio.md#exact-pet-session-observation-and-review)
  or its Console view. Never switch sessions, use an active-session fallback,
  or answer a different review to unblock a queue.
- Match the Pet, Session, pending interrupt and current choices before any
  approval. Submit only explicitly authorized decisions and verify the
  result. For a matching interactive Session, `send "$PET_ID" --file` takes a
  JSON `interrupt.resume` with a fresh `requestId`, its `interruptId` and
  `value.decisions` (`interactionId` and `selectedOptionId`); pass
  `--agent-url "$AGENT_URL"`. Other interrupt kinds own their own payload.
  Use `channels send` for a Channel continuation, not interactive `chat_request`.
- A generic `studio dispatch "$PET_ID" --file "$TASK_FILE"` admits work
  directly and does not publish into a Channel. Do not substitute it for a
  Channel request. Accepted is not completed; verify start, tool results
  where authorized, and delivery separately. SSE is live, has no replay, and
  closing it does not cancel a run. Recheck the exact Session after reconnect.

`studio clients list`, `clients add`, `clients add-key`, and `clients revoke`
are local-authority account operations. Use them only if requested, never to
bypass a permission error. The creation commands return a key once; do not
log or expose it. Revocation invalidates that client's keys and keeps history.

## Trigger and Schedule

The operator CLI has no `trigger` or `schedule` commands. Use
[`Automation Plugins`](../../docs/design/studio/automation-plugins.md) for
the optional installed Plugins' configuration and routes. Existing schedules
and Trigger deliveries can be checked through their read-only views with the
appropriate authority (`GET /scheduler`, `GET /triggers` when configured).
Do not infer that a missing route means there is no schedule or delivery.

Both paths target a concrete Pet in its owner Channel and run directly
through that Channel's execution input, not by posting their requests to its
Timeline or asking a Head to decide. An accepted delivery or dispatched
schedule is not completion, even though the execution's final public reply
can land in the Channel. Inspect the corresponding record and output before
retrying. Do not create, cancel, invoke, replay or reconfigure either Plugin
as part of ordinary Channel work unless that action was authorized.
