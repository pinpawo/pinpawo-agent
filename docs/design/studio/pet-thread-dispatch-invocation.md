# Studio Pet Dispatch and Conversation Continuity

> Status: Accepted target; current implementation is transitional
> Date: 2026-08-26
> Related: issue #684, PR #682, issues #561 and #675
> Resident Pet access boundary:
> [Resident Pet Host Ports](../agent-runtime/resident-pet-host-ports.md)

## Decision summary

Studio dispatch is a one-way work-delivery surface. It targets a live resident
Pet and creates one Studio invocation, but it does not own a Pet thread and does
not resume a continuation.

The same resident Pet also has a richer Agent Session conversation surface. That
surface owns session/thread selection, pending-interrupt projection, review,
resume, observation and control. In both capability and scheduling terms:

```text
conversation > dispatch

Studio HTTP dispatch ─┐
                     ├─ Resident Pet Coordinator ─> shared Agent runtime
Agent Session WS ─────┘
      conversation queue is selected first; active work is non-preemptive
```

Studio core receives only the dispatch port. The Agent Session interaction
adapter is built by local-agent and may run in the same Studio Host process, but
it is not a Studio protocol or Plugin.

## Vocabulary and ownership

| Concept | Meaning | Owner | Lifetime |
| --- | --- | --- | --- |
| Studio | Registry, dispatch queue and event substrate for live Pets | Studio Host | Host generation |
| Pet | Configured resident Agent runtime | Host runtime registry | Runtime lifetime |
| active thread | Agent Session's currently selected checkpoint continuity | Agent Session/local-agent | Until conversation switches it |
| dispatch | One-way request targeting a Pet | Studio API | One accepted call |
| invocation | Studio observation identity for one dispatch | Studio | Until its terminal result |
| pending interrupt | Durable checkpoint wait projected to conversation | Agent runtime/checkpointer | Until conversation resolves it |
| conversation | Full Agent Session interaction with a resident Pet | local-agent interaction adapter | Client/session lifetime |

Studio owns Pet targeting, invocation identity, its own FIFO dispatch queue and
Studio events. It does not own thread identity, checkpoint interpretation,
continuation recovery or Agent Session messages.

## Dispatch contract

The target semantics are:

```ts
type StudioDispatchRequest = {
  petId: string;
  request: string;
  metadata?: JsonObject;
  idempotencyKey?: string;
  signal?: AbortSignal;
};

type StudioDispatchReceipt = {
  invocationId: string;
  onInvocation: (handler: StudioInvocationEventHandler) => () => void;
  completion: Promise<StudioDispatchResult>;
};

type StudioDispatchResult = {
  petId: string;
  invocationId: string;
  status: 'completed' | 'waiting' | 'failed' | 'cancelled';
};
```

Every accepted call receives a new `invocationId` unless an explicit
`idempotencyKey` resolves to an existing call. Acceptance returns immediately;
the receipt observer and completion promise project later queue/execution
changes. Producer metadata remains opaque and never enters Agent execution
metadata.

The target receipt and event do not expose a stable Pet `threadId`. Dispatch
does not bind a thread when accepted or queued. When the resident Coordinator
actually selects it, the runtime reads Agent Session's active thread and keeps
that execution on the selected thread until it settles.

## Conversation and thread switching

The conversation surface directly reuses `@pinpawo/agent-session` client/server
messages and snapshots. It does not define a Studio-specific session protocol.

- Before Host readiness, local-agent restores the Pet-scoped active session or
  creates a default one; dispatch never waits for the first TUI connection to
  establish a thread.
- `session.new` and `session.resume` change the resident Pet's active thread.
- The active selection is shared Host state for that Pet, not per-WebSocket UI
  focus. Multiple clients observe the same selection and switch it through the
  serialized conversation queue.
- A switch queued while an operation is active takes effect after that operation
  settles.
- Dispatches that have not started use the active thread at their actual start,
  so they naturally follow the latest completed conversation switch.
- An already running dispatch finishes on the thread it selected at start.
- Studio never reads, stores or publishes that active thread as a dispatch
  identity.

A wire/schema-invalid Agent Session message is rejected by the interaction
adapter before it reaches the Coordinator. Once the adapter accepts a message as
a conversation operation, it receives conversation priority; the Coordinator
does not invent a second "valid conversation" predicate.

## Queue and gate semantics

Each resident Pet has one simple Coordinator with two FIFO queues:

1. At most one Agent graph operation runs at a time.
2. Active work is non-preemptive and naturally settles.
3. When idle, the Coordinator selects conversation before dispatch.
4. A newly queued conversation moves ahead of all dispatches that have not
   started, but does not abort the active dispatch.
5. An idle conversation connection does not occupy the queue.
6. Strict priority may starve dispatch during sustained conversation traffic;
   that is the accepted behavior for this phase.

`open`, `busy`, `waiting` and `blocked` are observations of the same atomic gate,
not independent admission checks. While a checkpoint is waiting or blocked,
ordinary dispatch remains queued. Only Agent Session conversation control can
resolve the durable pending state.

Dispatch observes its terminal `completed`, `waiting`, `failed` or `cancelled`
result. It does not consume token/tool activity or the full conversation event
stream. Whether work completes immediately or waits is a queue/result concern,
not a reason to turn dispatch into a session.

## Continuation boundary

Dispatch resume is deliberately removed from the target contract. A dispatch
that reaches a durable interrupt settles as `waiting`, without projecting the
interrupt identity or payload into Studio. Later recovery occurs only through
Agent Session's typed review/interrupt behavior and snapshot.

Studio core and Plugins may display or persist Studio events, but they do not:

- submit a continuation through dispatch;
- inspect checkpoint state;
- validate review payloads;
- construct LangGraph resume commands;
- receive a Pet runtime or conversation reference through Plugin context.

Checkpoint persistence remains the durable authority, so a waiting state does
not depend on Studio or Chat Host memory.

## Runtime and lifecycle alignment

- local-agent exposes resident-runtime construction and Agent Session
  interaction construction as separate, composable surfaces.
- Studio Host composition eagerly starts every configured resident Pet and its
  paired interaction adapter before becoming ready.
- Any Pet startup failure fails the entire Host and closes all resources created
  by that attempt. Pet startup and shutdown order are unspecified.
- There is no lazy or disabled Pet state.
- `listPets()` returns currently live Pets using config-owned registration
  metadata plus Host runtime liveness. It does not expose runtime references or
  Capability inventory.
- Studio control-plane access is HTTP through the HTTP Plugin. The paired Agent
  Session WebSocket is a local-agent listener inside the Host process and only
  talks to the resident Agent.

## Current implementation delta

The shipped implementation predates this accepted target and still contains:

- deterministic `(studioId, petId) -> threadId` resolution;
- typed request/resume dispatch input;
- `threadId` in Studio receipts and invocation events;
- Studio-owned WebSocket/stdio transport;
- a transitional `PetAgentRuntime.invoke()` adapter.

These are migration inputs, not contracts to preserve. New code must not copy
them into `ResidentPetHost`, Studio Plugin context or Agent Session.

## Required migration tests

- conversation switches the Agent Session active thread; a queued dispatch uses
  the new thread when it starts;
- an active dispatch is not aborted by a newly queued conversation;
- after active work settles, queued conversation runs before queued dispatch;
- idle conversation connections do not block dispatch;
- dispatch contains no resume input and receipts/events contain no Pet thread
  identity;
- pending interrupt is projected, restored and resolved only through Agent
  Session after process restart;
- Studio imports no Agent Session contract and Agent Session contains no Studio
  message;
- one configured Pet failure fails Host startup; successful startup reports only
  live Pets.

## Remaining questions

- How the local-agent Agent Session WebSocket selects one Pet without adding
  `petId` to Agent Session messages (for example, one route per Pet). This is a
  transport/composition decision, not a Studio protocol field.
- How historical fixed Studio/Pet checkpoint namespaces are retained or exposed
  for migration after active-thread selection replaces them.
- Whether idempotency records need durable retention beyond the current Host
  generation.
