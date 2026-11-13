# Channel addressing, execution and state

Channel stores a shared Timeline for Human and Pet Instance producers. It validates
identity, membership, mentions and same-Channel references before saving. An
`@` identifies a current member; `replyTo` identifies a message, not a recipient
or authorization. Console Reply preselects a current author as a mention, which
can be changed or removed. Labels are presentation only; `participantId` carries
the stable identity. Plain `@label`, code and quoted examples do not address a
member; direct Markdown links and explicit `mentions` use the same parser.

After a new message commits, `ChannelService.subscribe` broadcasts a live
`channel.message.created` event. It invokes current listeners in registration
order without awaiting their asynchronous work and isolates listener failures;
asynchronous work can overlap, and concurrent writes do not guarantee publication
order. Channel also forwards the event to the Studio event bus. That existing bus
serializes delivery separately
for each subscriber: an online slow handler can delay later events for itself,
but not for other subscribers. Its in-memory pending work is not a durable queue;
events missed while unsubscribed or offline are not replayed or caught up. Stored
history remains available through Channel queries.
Each Pet Instance subscribes to its owner Channel Timeline when it becomes
active, and cancels that subscription when it is deactivated. Channel publishes
new messages with its Channel id as the topic; each instance registers that exact
source/topic before handler delivery, so other Channels do not wake its subscriber.
Its Head independently decides whether to ignore a message, reply directly, or
request a Host dispatch. Events missed while inactive are not replayed. Mentions
and replies provide context, not an automatic dispatch rule.
A Head filters its own output. To prevent lightweight confirmation loops, a
Pet-triggered direct reply requires an explicit mention and cannot mention a
Pet itself. Dispatch carries the triggering message, its reply target and their
attachments through the existing Channel session admission path.

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
