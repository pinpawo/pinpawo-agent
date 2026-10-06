# Host persistence and dispatch recovery (draft, #912)

HostPersistence is the composition entry for Host-owned durable state. Its
SessionRegistryPort and InvocationStorePort express domain operations, rather
than arbitrary CRUD. Runtime checkpoints remain entirely runtime-owned.

The initial adapter extends the existing v4 session registry in place with a
versioned invocation section. v2/v3 session records are migrated on first write;
IDs, opaque threads, active selection and profiles are preserved. No second
session registry is written. Existing registry load/save helpers become adapter
compatibility facades; ServerTuiSessionService only uses the session port.

Admission commits before queueing. Explicit Plugin targets are fixed then.
Legacy unscoped callers keep active-session-at-dequeue behavior: their queued
provisional registration may be rebound through a conditional domain operation
before claiming execution; scoped/started invocations cannot be rebound. A session registration may precede invocation
admission; an orphan session is safe and reusable, while no model/tool starts
until invocation admission and its execution claim have committed. Each chunk
has a separate requestId and revision; runtime task/run identity is obtained
through the public runtime execution/recovery contract, never Host snapshot
values or checkpoint metadata. Resume matches Pet/session/thread/run/interrupt,
claims the waiting revision, and reinstates only that invocation's original scope.

Settlements retain a stable invocation identity and public reply/error before
publication. Studio replays durable lifecycle results after plugins activate;
Channel's unique invocation output makes replay idempotent. This is recoverable
at-least-once result publication, not exactly-once tool execution. Unknown start
windows, mismatched identities and queued work after restart are blocked for
explicit repair; external effects are never replayed automatically. The adapter
is single-writer: atomic rename and fsync protect file replacement, not a
multi-process database transaction. Malformed durable state fails closed.

Stored input/public replies remain local alongside the session registry until
explicit removal; no automatic expiry is introduced. Do not put credentials in
invocation metadata. A later retention policy must preserve pending associations
and unacknowledged settlements.

## Migration inventory

| State / call sites | Owner and path after this change |
| --- | --- |
| ServerTuiSessionService / tuiSessionRegistry | HostPersistence.sessions; same file, only adapter writes |
| Dispatch admission, pending association, settlement | HostPersistence.invocations; same adapter commit boundary; in-memory queue is scheduling only |
| Studio idempotency | Durable resident admissions; process map only concurrent admission reservation; legacy mock ports retain compatibility |
| storage.ts config, global policy, capability preferences | HostPersistence configuration port, existing config path; facade only, no copied credentials |
| CapabilityArtifactStore | HostPersistence artifact port composes existing specialized content adapter; manifests/content remain single authority |
| FileSaver/runtime authorization and plans | Runtime-owned, excluded; public execution/recovery descriptors only |
| Channel messages/bindings/execution timeline | Plugin-owned display projection, excluded; original scope and invocation source required |
| Tokens, process locks/PIDs, temporary files, user files | Security/process/user owners, excluded; no copies |

Supervisor contract errors, automatic Channel history and UI duplicate-click
handling are outside this change. A Supervisor failure does settle the original
invocation as failed, without claiming to fix that separate error.
