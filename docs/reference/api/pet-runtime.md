# Pet Runtime API

> **Status: current host-integration contract.** The public port types live in
> [`@pinpawo/studio`](../../../packages/studio/src/types.ts); the local-host
> adapter that executes them lives in
> [`packages/studio/src/host/createPetAgentRuntime.ts`](../../../packages/studio/src/host/createPetAgentRuntime.ts).

`PetAgentRuntime` is the boundary between Studio and one agent runtime. Studio
submits a typed graph invocation and never inspects the agent's private
messages, Toolkit calls, or checkpoint internals.

## Port

```ts
type PetAgentRuntime = {
  descriptor(): PetAgentRuntimeDescriptor;
  invoke(input: PetAgentRuntimeInvokeInput): Promise<PetAgentRuntimeInvokeResult>;
  gate(): PetGateState;
  onGateChange(listener: (state: PetGateState) => void): () => void;
  shutdown?(): Promise<void>;
};

type PetAgentRuntimeInvokeInput = {
  input: StudioDispatchInput;
  threadId: string;
  signal?: AbortSignal;
};

type PetAgentRuntimeInvokeResult =
  | { status: 'completed'; reply: string }
  | { status: 'pending_interrupt'; pendingInterrupt: PendingInterruptProjection };
```

`input` is either a natural-language request or a typed interrupt resume.
Studio resolves the stable Pet `threadId`; producers cannot choose the
checkpoint namespace. Studio's `invocationId` identifies dispatch progress and
does not enter the Pet runtime. Capability, Toolkit, workdir, and other Agent
execution configuration are fixed when the Host builds the resident Pet rather
than supplied by individual dispatches.

## Lifecycle and ownership

- `descriptor()` exposes the pet identity, configured role, startup mode,
  dispatch status, and compiled Capability summary.
- `invoke()` resolves as `completed` or `pending_interrupt`. A durable interrupt
  ends this invocation but remains the current continuation of the stable Pet
  thread. A later invocation may resume it.
- Before ordinary input or resume, the local adapter reads the authoritative
  checkpoint. It rejects ordinary input while a continuation is pending and
  rejects a stale interrupt ID without invoking the graph.
- `gate()` and `onGateChange()` expose Host diagnostics. Studio's per-Pet queue
  serializes active invocations; it does not remain occupied by a durable wait.
- A runtime that creates its own `ToolkitRuntimeManager` may expose `shutdown()`
  to release Toolkit roots. When a host injects a shared manager, the host owns
  shutdown.

## Integrating review and events

The local adapter enables checkpointed human review. It projects the pending
payload into `PendingInterruptProjection`, validates public responses against
the authoritative review specs, and creates a keyed LangGraph `Command` only
for a matching interrupt. Studio transports or interaction Plugins can present
that projection and submit the later typed resume without adopting Chat's
session protocol. See [Events and human review](events-and-review.md) for the
shared review boundary.

## Related contracts

- [Studio API](studio.md) — the caller that dispatches pet invocations.
- [Capability / Toolkit contract](../extensions/capability-toolkit.md) — task
  authority and Toolkit allowlists.
- [Session projection](../runtime/session-projection.md) — client-facing
  checkpoint and live-run state.
