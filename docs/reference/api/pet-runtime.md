# Pet Runtime API

> **Status: current host-integration contract.** The public port types live in
> [`@pinpawo/studio`](../../../packages/studio/src/types.ts); the local-host
> adapter that executes them lives in
> [`services/local-agent/src/studio/createPetAgentRuntime.ts`](../../../services/local-agent/src/studio/createPetAgentRuntime.ts).

`PetAgentRuntime` is the boundary between Studio and one agent runtime. Studio
submits a bounded request, observes only its gate, and never inspects the
agent's private messages, Toolkit calls, or review loop.

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
  brief: string;
  wikiRoot?: string;
  signal?: AbortSignal;
  threadId?: string;
  execution?: AgentExecution;
  workdir?: string;
  runtimeEnvironment?: string;
  toolkits?: AgentToolkit[];
  extraCapabilities?: AgentCapability[];
  allowedCapabilityNames?: string[];
  activeDelegationTransition?: ActiveDelegationTransition;
};

type PetAgentRuntimeInvokeResult = { reply: string };
```

`brief` is the task handed to the pet. `extraCapabilities` and `toolkits` add
to the runtime configuration for this invocation only. `allowedCapabilityNames`
limits the Capability Planner's readable workspace; it is an allowlist, not a
tool permission bypass.

## Lifecycle and ownership

- `descriptor()` exposes the pet identity, configured role, startup mode,
  dispatch status, and compiled Capability summary.
- `invoke()` resolves with `{ reply }` or rejects, but that does not necessarily
  mean all work is complete: a checkpointed runtime can return while it waits
  for human input. `gate()` and `onGateChange()` are the queue-authority
  boundary for Studio.
- A runtime that creates its own `ToolkitRuntimeManager` may expose `shutdown()`
  to release Toolkit roots. When a host injects a shared manager, the host owns
  shutdown.
- `wikiRoot` is optional. When the local host also supplies `wikiAccess`, the
  runtime reads the wiki index and adds a constrained read Toolkit; Studio does
  not receive the worker's private scratch state in return.

## Integrating review and events

`humanReviewer` is supplied when the local host creates the runtime, not per
call. It accepts a canonical `HumanReviewInterruptPayload` and resolves to a
`ReviewResponse`. See [Events and human review](events-and-review.md) for the
review and root-stream boundary.

## Related contracts

- [Studio API](studio.md) — the caller that dispatches pet invocations.
- [Capability / Toolkit contract](../extensions/capability-toolkit.md) — task
  authority and Toolkit allowlists.
- [Session projection](../runtime/session-projection.md) — client-facing
  checkpoint and live-run state.
