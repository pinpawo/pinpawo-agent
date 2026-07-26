# `@pinpawo/agent-session`

Runtime-neutral session projection shared by agent hosts and clients.

The package owns:

- canonical `AgentSession` domain and runtime events;
- deterministic `reduceSession` / `applySessionSnapshot` projection;
- the versioned `AgentSessionSnapshot` transport contract;
- boundary parsers and shared protocol message types.

It does not own transports, persistence, checkpoints, authentication, UI state,
runtime assembly, or remote disclosure policy. Those remain in the consuming
service.

```ts
import {
  createAgentSessionSnapshot,
  parseAgentSessionSnapshot,
  reduceSession,
} from '@pinpawo/agent-session';
```

Snapshots wrap the canonical projection directly:

```ts
const snapshot = createAgentSessionSnapshot(session);
const parsed = parseAgentSessionSnapshot(
  JSON.parse(JSON.stringify(snapshot)),
);
```

Consumers must parse untrusted input at their boundary. A service that exposes
the snapshot remotely must apply its own endpoint-specific disclosure adapter
before JSON serialization; trusted local consumers use the same snapshot
contract without a second wire model.
