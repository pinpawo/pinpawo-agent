# Pending Interrupt in Chat

> Status: Draft
> Date: 2026-08-22
> Related: issues #675 and #684, PR #682
> Resident Pet integration: [Resident Pet Host Ports](../agent-runtime/resident-pet-host-ports.md)

## Decision summary

`PendingInterrupt` is the checkpoint-derived fact that a thread has paused and
can be resumed. Human review is one interrupt payload and its UI is a projection
of that payload; it is not a parallel lifecycle.

PR #682 is scoped to the Chat adapter. Chat already has one implicit active
session and thread, so its interrupt projection and resume path contain neither
`petId` nor Studio `dispatch` semantics.

```text
active Chat thread
  -> checkpoint PendingInterrupt
       -> human-review payload
       -> Chat/TUI projection
  -> response names interruptId
  -> Chat adapter reloads the active checkpoint
  -> validate current payload and resume the same thread
```

## Canonical vocabulary

| Name | Meaning | Owner |
| --- | --- | --- |
| `PendingInterrupt` | Current resumable wait read from a thread checkpoint | Pet runtime/checkpointer |
| `interruptId` | Identity of that checkpoint wait | Pet runtime/checkpointer |
| human-review payload | Ordered review interactions carried by the interrupt | Pet runtime |
| interrupt projection | Presentation-safe view of the current interrupt | `agent-session` / adapter |
| interaction response | Selection for one review interaction | Producer/adapter input |
| `requestId` | One Chat transport command and the events it produces | Chat adapter |

There is no canonical `ReviewAction`, `actionId`, or independent review
lifecycle. During compatibility migration, old names may remain at the wire or
TUI boundary, but they alias the current interrupt rather than naming another
entity.

## Shared checkpoint contract

The target checkpoint-facing shape is generic over interrupt payloads:

```ts
type PendingInterrupt<TPayload = InterruptPayload> = {
  interruptId: string;
  payload: TPayload;
};

type HumanReviewInterruptPayload = {
  kind: 'human_review';
  interactions: HumanReviewRequest[];
};
```

The current runtime supports human-review interrupts at this adapter boundary,
but the surrounding identity is not review-specific. A run or invocation result
may report `status: 'pending_interrupt'` and carry the same projection; that is
a status derived from the checkpoint fact, not another wait object.

The same interrupt ID can be observed again with updated review content after a
middleware re-ask. Consumers must refresh the payload from the latest checkpoint
or event rather than treating an ID match as immutable content.

The canonical Chat wire shapes are:

```ts
type HumanReviewRequested = {
  type: 'human_review.requested';
  requestId: string;
  pendingInterrupt: PendingInterrupt<HumanReviewInterruptPayload>;
};

type HumanReviewResponse = {
  type: 'human_review_response';
  requestId: string;
  interruptId: string;
  responses: Array<{
    interactionId: string;
    selectedOptionId: string;
    input?: Record<string, unknown>;
  }>;
};
```

`actionId`, scalar response fields, and `decisions` are accepted only by the
inbound compatibility parser and are normalized immediately. Newly emitted
messages use the shapes above.

## Chat boundary

Chat resolves the active thread from its active session. Therefore:

- a Chat projection contains no `petId`;
- a Chat review response is not a Studio dispatch;
- `requestId` correlates the protocol exchange but does not identify the
  checkpoint wait;
- `pendingInterrupt` and `activeRun` are independent projection facts: the wait
  has no `requestId`, while every active invocation has one;
- after the client sends a response or cancel, a new `activeRun` owns the
  resulting transport events while the same `pendingInterrupt` remains visible
  until authoritative runtime progress, another interrupt, or terminal state;
- the handler reloads the active checkpoint for every resume attempt;
- missing or mismatched `interruptId` is closed/stale without mutating state;
- internal `ReviewSpec` decisions and effects are recovered from the checkpoint,
  never accepted from the public projection.

Thread invocation serialization owns concurrent Chat calls. Interrupt resume
ordering belongs to that coordinator and the graph checkpoint, not to an
`actionId`-keyed review state machine.

## Studio boundary

Studio has an explicit target and invocation protocol:

```text
dispatch(petId, input) -> invocation on that Pet's stable thread
```

Studio may later carry an interrupt-resume input through dispatch, but that is
outside PR #682. Studio reuses only the shared `PendingInterrupt` payload and
resume semantics. `petId`, `invocationId`, and dispatch producer metadata stay
in Studio envelopes; they do not enter the shared interrupt projection or the
Chat adapter.

## Migration sequence

1. Make the Chat checkpoint projection use `PendingInterrupt` and
   `interruptId` vocabulary.
2. Rebuild Chat snapshots and resume routes directly from the active checkpoint.
3. Remove Chat-local review existence, claim, consumed, and fatal tombstone
   state once thread serialization covers competing calls.
4. Keep temporary wire aliases only where an older TUI can still send them.
5. Let Studio adopt the shared interrupt contract separately through issue
   #684 and its typed dispatch input.

## Non-goals

- Adding `petId`, `threadId`, or `invocationId` to the Chat interrupt payload.
- Treating a Chat response as dispatch.
- Designing Studio concurrency inside a Chat-local coordinator.
- Persisting adapter-local review state beside the graph checkpoint.
- Exposing internal review decisions, effects, or resume commands to the UI.
