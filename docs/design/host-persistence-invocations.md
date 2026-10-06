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

## Optional usage domain seam (design, reserved interface only)

`HostPersistence.usage?: UsageStorePort` reserves a domain entry for future token
accounting alongside the existing four ports. `createHostPersistence` passes
through an injected adapter; the default and current file adapter leave usage
undefined. Undefined means unavailable, not zero consumed. This change does not
add a writer, change the session/invocation file schema, or promise usage durability
under their commit boundary. Usage types are exported through `pinpawo/host-runtime`.

The reserved operations are asynchronous `record(UsageObservation)` returning
`recorded | duplicate | stale`, and `list(UsageFilter, cursor?)` returning current
per-attempt facts and an opaque next cursor. A future adapter keys physical provider
requests by `(sourceId, attemptId)` and compares revisions: redelivery is a duplicate,
older observations are stale, and different content at the same revision is an
error. A later observation updates one attempt's contribution rather than counting
another request. Adapter concurrency and durability guarantees remain to be specified.

Observations reuse `RuntimeExecutionIdentity`, `requestId` for the start/resume
segment, and optional `planItemId`/`delegationId`. There are no extra chunk/Step IDs.
Host invocation and original Channel scope remain in the invocation store; future
queries join through its formal runtime association, never an active session or
checkpoint contents. `modelCallId` identifies a logical call, while `attemptId`
identifies each actual request including retries. The eventual runtime producer
must retain stable source/event identities for redelivery.

Each fact carries phase, provider/model, timestamps, outcome and input/output/total,
with optional cache/reasoning breakdowns and missing reason. Null means unknown;
reported zero is known. Empty results mean no recorded matching requests, not
complete historical zero. Only reported numeric usage belongs here, never prompts,
response bodies or credentials. Future totals sum physical requests once across
start/resume, failure/cancellation and compaction; capability aggregates are
projections, not additional consumption. Context occupancy is a separate metric.

Runtime instrumentation at the actual retry boundary, a real persistence adapter,
replay/coverage contracts, aggregation, HTTP routes and Console views are deferred.
Until those exist, this seam provides neither capture nor complete historical
accounting. A crash between provider consumption and durable observation remains
an explicit coverage gap; do not infer missing usage or rerun models to recover it.
