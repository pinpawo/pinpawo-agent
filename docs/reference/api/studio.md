# Studio API

> Status: current contract. The public API is exported by
> [`@pinpawo/studio-core`](../../../packages/studio/src/index.ts).

Studio is a small one-way dispatch and Plugin-event substrate. It receives only
Pet registration metadata and `PetDispatchPort`; it does not receive Agent
Session, checkpoint, Capability inventory, or private actor data.

```ts
type StudioPetBinding = {
  registration: {
    petId: string;
    name: string;
  };
  dispatch: PetDispatchPort;
};

type StudioDispatchRequest = {
  petId: string;
  request: string;
  session?: { id: string; create?: boolean }; // in-process Plugin only
  scope?: { namespace: string; id: string }; // in-process Plugin only
  metadata?: JsonObject;
  idempotencyKey?: string;
};
```

The HTTP wire form omits `session` and `scope`; unknown targeting fields are
rejected. They are trusted Plugin-to-Host fields, not client metadata.

`Studio.dispatch()` validates the live Pet, allocates an `invocationId`, and
returns an admission receipt after the resident dispatch port accepts the input.
The receipt has no completion, execution status, output, error, or cancellation
handle. Queueing and the dispatch gate belong to the resident runtime; execution
is observed through Agent Session events, checkpoints, or Plugin-owned domain
state rather than a Studio result.

After admission, Studio publishes a live `dispatch.accepted` event with the
`invocationId`, target `petId`, request text, and producer name. This is an
observability fact on the same non-durable event bus, not a completion signal or
a dispatch result store. Idempotent replay returns the original receipt without
publishing another accepted event. Simultaneous submissions share the pending
admission Promise. Keys are scoped to producer and Pet; a failed admission releases
the process-local reservation. This is not a durable replay or exactly-once guarantee.

Plugins may declare `contextNamespaces` and register a context provider during startup. For an admitted dispatch in such a namespace, Studio asks its owner to resolve invocation-local system sections from the trusted scope, Pet and session; it passes the resulting snapshot to the Host. Providers are not HTTP inputs, and ordinary unscoped conversations do not acquire a Plugin scope. A declared provider that is unavailable causes scoped admission to fail. Context sections may be sent with each model call, so registration does not itself reduce token use.

Plugins receive `dispatch`, `notify`, `subscribe`, `listPets`, `listDispatchQueues`, Plugin
hook installation, and `storage`: `storage.open(migrations)` applies the Plugin's pending
migrations in the shared Studio database (SQLite or Postgres, set by `studio.json` `storage`)
and returns a Kysely instance. Each Plugin owns its tables and its `<name>_migrations` history;
Studio closes the database after every Plugin has stopped. `allocateSessionId(petId)` names a new
session for `dispatch({ session: { id, create: true } })` without creating it. A Plugin may define
Toolkits; their tools call `readStudioInvocation()` from `@pinpawo/studio-core` to learn which admitted
dispatch (Pet, invocation, session, scope) they run in, and get `undefined` outside one. A Plugin
cannot construct a Pet, inspect a runtime, or participate in Agent Session conversation, and needs
no import from `pinpawo/host-runtime`.

Every published `StudioEvent` carries an `eventId` that Studio assigns at `notify()`, along with
`source` and `occurredAt`; subscribers can use it to tell two events apart even when they share a
millisecond.

## Global dispatch observation

The Studio HTTP Plugin exposes `GET /dispatch/queues` under the existing Studio
Bearer authority. It forwards each resident Pet's actual global admission snapshot:
state, active operation, queue counts, and optional active / queued dispatch identities.
Queue entries include dispatch ID, enqueue time, and admitted session / scope
correlation, with no request text or model content. Conversation holds are counts,
not a second dispatch queue. This read-only endpoint neither schedules nor restores work.
The local operator's existing Bearer authority can observe all configured Pets;
the JSON includes other Channels' scope IDs and session / dispatch correlation IDs.
There is no new per-Channel ACL. Console shows known Channel titles or generic
source labels, never another session's ID or request body. Model context does not
include this queue endpoint. Disconnected or failed reads show the last observed
queue as unknown; a global waiting gate alone does not establish a human review.

## Exact Pet session observation and review

Under the same Studio Bearer authority, the HTTP Plugin forwards each resident
Pet's `PetSessionPort` (Host `resident.sessions`, borrowed by Studio as
`context.petSessions`). Every route addresses one `petId + sessionId`; an unknown
Pet or session is `404` and never falls back to the active session or creates one.

| Route | Result |
| --- | --- |
| `GET /pet-sessions/snapshot?petId&sessionId` | `{ petId, snapshot }`, the Host's `AgentSessionSnapshot` |
| `GET /pet-sessions/events?petId&sessionId` | SSE `agent.session`: first `session.snapshot.result`, then only that session's `AgentServerMessage`s |
| `POST /pet-sessions/review` | `{ petId, sessionId, requestId, interruptId, value: { decisions } }` → `202 { requestId }` |

Observing holds no interactive connection and never changes the active session.
The review route accepts only a human-review answer; it runs through the same
admission, checkpoint validation and dispatch continuation as a TUI answer, in
the addressed session's own thread. `202` means the Host took the answer, not
that it applied: the resumed run's `run.started`, or an `interrupt_closed` /
`interrupt_stale` / `interrupt_response_invalid` / `interrupt_wrong_session`
error, arrives on that session's
event stream under the same `requestId`; a later Host failure is reported there
as an `error` too. An answer the Host can already refuse gets `409 { error }`
instead: the review is no longer the session's current one, or the Pet is
running a turn (including another answer being resumed). Snapshots re-read the
checkpoint when a run started or settled during the read, so a reconnect
straddling a run's end shows its final state. Transient tool `raw` payloads are live
only; a reconnect rebuilds from the checkpoint snapshot.

## Channel messages and addressing

Channel contributes these routes to the HTTP Plugin with `client` authorization:
any Studio client key, or the local Host token, may call them. The caller is the
member `human:<clientId>` (the local token is `human:local`). A request on a
Channel the actor is not a current member of is `403` except for the Studio-authority
management routes noted below; an unknown Channel is `404`.
A human joins only as an active Studio client, and its label is the client's label.

| Route | Input / result |
|---|---|
| `GET /channels` | Paginated Channels the actor is a member of, plus `viewerParticipantId`. With `all=true`, the local Host token lists every Channel. |
| `POST /channels` | `title`, optional `description` and `prompt`, required `pets: [...]`; only Studio authority may supply a non-empty prompt. Ordinary clients can create a Channel without one. The creator and those Pets are the initial members. `201 { channel, members }`. |
| `POST /channels/update` | `channelId`, optional `title`, optional `description` and `prompt` (`null` clears the corresponding field). Members may edit title and description; only Studio authority may modify or clear prompt, even when the caller created the Channel. Non-member Studio authority may update prompt alone; mixed updates still require membership. |
| `GET /channels/context?channelId=...` | Channel, current members, a page of messages (the newest by default; `before` reads older, `after` newer), `viewerParticipantId`. |
| `GET /channels/members?channelId=...` | Current members. The local Host token may read any Channel's members. |
| `POST /channels/members` | `channelId`, `kind` (`human` \| `pet`), `id`; adds or rejoins a member. Any member, or the local Host token for any Channel. |
| `POST /channels/members/remove` | `channelId`, `kind`, `id`; the member leaves, its messages stay. `409` for the last human member. Any member, or the local Host token for any Channel. |
| `GET /channels/sessions?channelId=...` | Each Pet's session in this Channel, for `/pet-sessions/*`. |
| `POST /channels/messages` | `channelId`, `body`, optional `replyTo`, `mentions`, `artifacts`; message plus per-target deliveries. |

`prompt` is an optional Channel collaboration instruction, separate from its
human-facing description. It is trimmed, limited to 50,000 characters, and an
empty value clears it. Current members can read it; only Studio authority can set
a non-empty prompt on creation or modify or clear it later. Ordinary clients can
create Channels without a prompt, but cannot edit one even as the creator. A
Channel-scoped Pet dispatch uses a snapshot of the prompt for that run; edits apply to later dispatches, not to the current run or its approval
continuation. The routing model can also see it, but routing still applies only to
unaddressed human messages. The prompt expresses collaboration intent, not authorization; it
does not override Host or PET safety rules, grant tool access, change review policy,
or change Channel membership. Supplying it does not guarantee model compliance. See the
[design draft](../../design/studio/channel-collaboration-prompt.md).

Pagination uses `after` / `limit` and returns `nextAfter` / `hasMore`. Channel
messages are read from the newest page by default; `before=nextBefore` reads the
page before it while `hasEarlier`, and `after=nextAfter` reads what came later.
Messages are in sequence order either way, and `after` and `before` cannot be
combined. Schemas and
limits are defined by [ChannelService](../../../plugins/channel/src/channelService.ts).
`mentions: [{participantId}]` and direct Markdown `[@label](participant:pet:reviewer)`
share one parser and address only current members; request-body author, source and
scope claims are rejected. Deliveries are not stored: the response carries them and
Channel publishes each as a global `channel.delivery` event. A Pet's final reply
without tool calls in its Channel session is saved as its message and delivered the
same way. The model is specified in [Channel model](../../design/studio/channel-model.md);
addressing syntax and fixed sessions in the [Channel design](../../design/studio/channel-addressing-and-execution.md).
Delivery acceptance is not execution completion.

## Studio clients

Every HTTP request is authenticated as a Studio client. The local Host token is
the client `local` and may use every route; other clients authenticate with a
key and may use only routes registered with `client` authorization (the Channel
routes) plus `GET /me` and `GET /pets`. Keys are `pps_…`, shown once, stored as
SHA-256 hashes.

| Route | Input / result |
|---|---|
| `GET /me` | `{ clientId, scope }` for the token, `scope` is `studio` or `client`. |
| `GET /pets` | `{ pets: [{ petId, name }] }`, the Pet directory a client needs to create a Channel. |

`/events`, `/dispatch`, `/dispatch/queues` and `/pet-sessions/*` stay with the
local Host token, so a client follows its Channels by polling the Channel
routes. The Console does this when it connects with a client key or JWT: it
shows only the Channel page, without dispatch queues or Pet sessions.

These routes take the local Host token:

| Route | Input / result |
|---|---|
| `GET /clients` | `{ clients, localClientId }`. |
| `POST /clients` | `clientId` (1–64 of letters, digits, `.`, `_`, `-`), `label`; `201 { client, key }`. `409` if the id exists. |
| `POST /clients/keys` | `clientId`; another key for an active client, `201 { clientId, key }`. |
| `POST /clients/revoke` | `clientId`; all its keys stop working. The local client cannot be revoked. |

The CLI equivalents are `pinpawo-studio clients list|add|add-key|revoke`.

With the `jwt` option, a JWT from a configured issuer is also accepted as the
Bearer token. A valid token (signature, `iss`, `aud`, `nbf`, required `exp` and
`sub`) is the client `<clientPrefix>.<sub>` with `client` scope, registered on
first use with the `name` claim (or `sub`) as its label. Revoking that client
with `POST /clients/revoke` refuses its later tokens. See the
[HTTP Plugin design](../../design/studio/http-plugin.md#外部-jwt) for the options.

## Host lifecycle

`StudioHost` eagerly builds every configured Pet. Any Pet startup failure rolls
the whole Host back. `startStudioHost()` also starts the host Pet-scoped
Agent Session listener. Configured HTTP Plugins provide the Studio control plane;
Studio has no built-in WebSocket or stdio dispatch protocol.

## Host Agent Session HTTP

The host listener also exposes HTTP/SSE alongside its WebSocket, on the
Pet port (default `3212`). This is separate from the Studio HTTP Plugin (`3211`).
All routes require the existing Bearer token; they share the WebSocket Origin
policy, protocol parser and runtime handlers.

| Route | Result |
| --- | --- |
| `GET /agent-session/pets/:petId/snapshot` | Existing `session.snapshot.result` envelope plus `queue` state |
| `GET /agent-session/pets/:petId/events` | Live SSE, `event: message`, JSON `AgentServerMessage` data |
| `POST /agent-session/pets/:petId/messages` | Existing `AgentClientMessage` with `requestId`; JSON body, 1 MiB limit; `202 {requestId}` |

HTTP commands and SSE readers do not claim the exclusive TUI connection. The
Host owns submitted commands, so disconnecting HTTP/SSE does not stop execution.
To resolve review, read the snapshot and send `interrupt.resume` with its
interrupt ID and the kind-owned decision value. The runtime validates the same
IDs and decisions used by the TUI. `run.interrupt` targets a run by request ID
across HTTP, TUI and dispatch.

202 is acceptance, not completion. Events have no persistent replay; subscribe
before sending commands and reread the snapshot after reconnecting. Do not
blindly resubmit accepted mutations. Legacy `new_session` without a request ID
is not an HTTP command; use the current `session.new` protocol instead.

The repository's [Studio skill](../../../skills/studio/SKILL.md) provides
usage guidance for the project Node.js CLI. `pinpawo-studio channels`,
`pets`, `queues`, `snapshot`, `events`, `dispatch`, and `send` wrap existing
HTTP endpoints; they do not start a Host. The former Python helper has been
replaced. See the [CLI commands](../../../services/studio/README.md#operate-a-running-host)
for connection flags and pagination.
