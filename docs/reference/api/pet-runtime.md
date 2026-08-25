# Pet Runtime API

> **Status: current transitional host-integration contract.** The current port
> types live in
> [`@pinpawo/studio`](../../../packages/studio/src/types.ts); the local-host
> adapter that executes them lives in
> [`services/local-agent/src/residentPetAgentRuntime.ts`](../../../services/local-agent/src/residentPetAgentRuntime.ts).
> The accepted replacement is
> [Resident Pet Host Ports](../../design/agent-runtime/resident-pet-host-ports.md).

`PetAgentRuntime` is the boundary between Studio and one agent runtime. Studio
submits a typed dispatch and never inspects the agent's private messages,
Toolkit calls, or checkpoint internals. `local-agent` creates the runtime and
owns all Pet/graph/checkpoint semantics behind this port.

This interface represents only the dispatch side even though its name currently
looks like the entire Pet runtime. It must not be reused as a TUI/session API.
The target local-agent assembly constructs `ResidentPet` and
`ResidentPetInteraction` independently, then holds both through a
`ResidentPetHost` composition. Studio receives only `PetDispatchPort`; the
interaction side directly reuses `@pinpawo/agent-session` messages and snapshots.
`invoke()` will be renamed to `dispatch()` as consumers move to that contract.

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
  | { status: 'waiting'; pendingContinuation: PendingContinuationProjection };
```

`input` is either a natural-language request or an opaque continuation resume.
Studio resolves the stable Pet `threadId`; producers cannot choose the
checkpoint namespace. Studio's `invocationId` identifies dispatch progress and
does not enter the Pet runtime. Capability, Toolkit, workdir, and other Agent
execution configuration are fixed when the Host builds the resident Pet rather
than supplied by individual dispatches.

## Lifecycle and ownership

- `descriptor()` exposes the pet identity, configured role, startup mode,
  dispatch status, and compiled Capability summary.
- `invoke()` resolves as `completed` or `waiting`. A durable continuation ends
  this invocation but remains the current continuation of the stable Pet
  thread. A later invocation may resume it.
- Before ordinary input or resume, the local adapter reads the authoritative
  checkpoint. It rejects ordinary input while a continuation is pending and
  rejects a stale continuation ID without invoking the graph.
- `gate()` and `onGateChange()` expose Host diagnostics. Studio's per-Pet queue
  serializes active invocations; it does not remain occupied by a durable wait.
- A runtime that creates its own `ToolkitRuntimeManager` may expose `shutdown()`
  to release Toolkit roots. When a host injects a shared manager, the host owns
  shutdown.

## Integrating review and events

The local adapter may enable checkpointed human review. It projects the pending
Pet-owned payload into `PendingContinuationProjection`, validates its public
responses against the authoritative review specs, and creates a keyed LangGraph
`Command` only for a matching continuation. Studio transports or interaction
Plugins may present that opaque projection and submit a later typed resume;
Studio itself does not adopt Chat's session protocol or interpret the payload.
See [Events and human review](events-and-review.md) for the shared review
boundary.

## Related contracts

- [Studio API](studio.md) — the caller that dispatches pet invocations.
- [Capability / Toolkit contract](../extensions/capability-toolkit.md) — task
  authority and Toolkit allowlists.
- [Session projection](../runtime/session-projection.md) — client-facing
  conversation and live-run projection; it is not a Studio/Pet dispatch port.
