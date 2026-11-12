# Channel addressing, execution and state

Channel stores a shared Timeline for Human and Pet Instance producers. It validates
identity, membership, mentions and same-Channel references before saving. An
`@` identifies a current member; `replyTo` identifies a message, not a recipient
or authorization. Console Reply preselects a current author as a mention, which
can be changed or removed. Labels are presentation only; `participantId` carries
the stable identity. Plain `@label`, code and quoted examples do not address a
member; direct Markdown links and explicit `mentions` use the same parser.

After a new message commits, Channel publishes a live `channel.message.created`
event. Subscribers are independent of Channel and one another. Events are not a
persistent queue: an offline or interrupted subscriber misses events, with no
replay or catch-up. Stored history remains available through Channel queries.
The current implementation has no Pet Head: **messages and mentions only record
conversation; they do not automatically start a Pet.**

Channel maps a resident Pet's public final message for an admitted Channel-scoped
run to a Timeline message after checking the scope, session and member identity.
The Agent Session message id supplies `externalRef` for deduplication. Tool calls,
operations and private subagent content are not public messages. A failed save
emits `channel.message_failed` rather than changing the recorded history.

Scheduler and Trigger still invoke Channel's separate `run(channelId, petId,
request, origin)` input. It validates membership and uses the fixed Channel/Pet
session binding and a Channel scope for Host dispatch. This explicit entry is
independent of message creation. Its public Pet output can become a Timeline
message. The Host owns dispatch admission, execution and approval; Channel owns
membership, public history and bindings. Scoped context and `channel_read_context`
provide the Channel's instructions and history to an admitted Pet run.

Channel does not persist delivery records, acknowledgements, consumer cursors or
an outbox. Studio's live event stream does not provide exactly-once delivery.
The [Studio API](../../reference/api/studio.md#channel-messages-and-addressing)
documents message and history endpoints.
