# Pending Interrupt in Chat

> Status: Historical design draft for PR #682; wire and Studio details have since evolved.
> Current contract: [Agent Session projection](../../reference/runtime/session-projection.md) and
> [Native human review interrupts](../agent-runtime/interrupt.md).
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

## Vocabulary

| Name | Meaning | Owner |
| --- | --- | --- |
| `PendingInterrupt` | Current resumable wait read from a thread checkpoint | Pet runtime/checkpointer |
| `interruptId` | Identity of that checkpoint wait | Pet runtime/checkpointer |
| human-review payload | Ordered review interactions carried by the interrupt | Pet runtime |
| interrupt projection | Presentation-safe view of the current interrupt | `agent-session` / adapter |
| interaction response | Selection for one review interaction | Producer/adapter input |
| `requestId` | One Chat transport command and the events it produces | Chat adapter |

Review is represented by the pending interrupt, not a separate review lifecycle.
The earlier draft's wire aliases are not the current protocol; use the contracts
linked above.

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

The current Agent Session runtime event and client command use these shapes:

```ts
type InterruptRequested = {
  type: 'interrupt.requested';
  requestId: string;
  pendingInterrupt: PendingInterruptProjection;
  usage?: TokenUsageSnapshot;
};

type InterruptResume = {
  type: 'interrupt.resume';
  requestId: string;
  interruptId: string;
  value: JsonObject;
};
```

`interrupt.requested` is carried inside an Agent Session event envelope. The
human-review kind currently accepts `value: { decisions: HumanReviewResponse[] }`
or `value: { action: 'cancel' }`; each public decision identifies its
`interactionId` and `selectedOptionId`, with optional input. The Host validates
responses against the current checkpoint before resuming. See
[`protocol.ts`](../../../packages/agent-session/src/protocol.ts),
[`events.ts`](../../../packages/agent-session/src/events.ts), and
[`pendingHumanReviewInterrupt.ts`](../../../services/host/src/pendingHumanReviewInterrupt.ts).
The original `human_review.requested` / `human_review_response` names were draft
shapes and are not the current canonical wire messages.

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
dispatch(petId, input) -> invocation in the selected Pet session
```

PR #682 did not specify a Studio dispatch resume protocol. Current Studio also
borrows a restricted Host session port for snapshot, observation, and review of
an exact Pet session; see [Studio API](../../reference/api/studio.md#exact-pet-session-observation-and-review).
Studio routing metadata does not enter the shared interrupt projection.

## Original migration sequence

This records the draft plan, not a current implementation checklist.

1. Make the Chat checkpoint projection use `PendingInterrupt` and
   `interruptId` vocabulary.
2. Rebuild Chat snapshots and resume routes directly from the active checkpoint.
3. Remove Chat-local review existence, claim, consumed, and fatal tombstone
   state once thread serialization covers competing calls.
4. At the time, keep temporary wire aliases only where an older TUI can still send them.
5. Let Studio adopt the shared interrupt contract separately through issue
   #684 and its typed dispatch input.

## Original non-goals

- Adding `petId`, `threadId`, or `invocationId` to the Chat interrupt payload.
- Treating a Chat response as dispatch.
- Designing Studio concurrency inside a Chat-local coordinator.
- Persisting adapter-local review state beside the graph checkpoint.
- Exposing internal review decisions, effects, or resume commands to the UI.
