# Local-Agent Event Pipeline

This document describes how tool-call activity inside `pet-agent` becomes
`operation` events that reach a TUI, the macOS companion, or the hosted
PinPawo app, and the small transport-specific transformation applied to
completed main-agent messages.

## Big picture

```mermaid
flowchart LR
  subgraph pet[pet-agent runtime]
    LG[LangGraph stream<br/>on_tool_start/end]
  end

  subgraph local[local-agent service]
    NORM[agentStreamNormalizer<br/>→ AgentOperationEvent]
    TRK[ToolOperationTracker<br/>(id reuse, finishActive)]
    REG[recordOperationActivity<br/>operationActivityState]
    APPOUT[sendLocalAgentEvent<br/>(audience=remote)]
    LOCOUT[sendLocalAgentEvent<br/>(audience=trusted-local)]
  end

  subgraph remote[Hosted PinPawo app]
    APPUI[Remote chat UI<br/>reads summary/details only]
  end

  subgraph trusted[Trusted local clients]
    TUI[Ink TUI<br/>tuiStateReducer]
    MAC[macOS companion]
  end

  LG --> NORM --> TRK --> REG
  REG --> APPOUT
  REG --> LOCOUT
  APPOUT -- "native events; completed text redacted" --> APPUI
  LOCOUT -- "raw preserved" --> TUI
  LOCOUT -- "raw preserved" --> MAC
```

Two physical egress points exist:

| Egress | File | Audience |
| --- | --- | --- |
| App WS relay | `runtime.ts` (`inflightRequests`), `localAgentAppChatHandler.ts` | `remote` (default) |
| Local HTTP/WS server | `localServer.ts`, `localServerChatHandler.ts`, `localServerStudioHandler.ts` | `trusted-local` |

Both call the same `sendLocalAgentEvent(ws, event, options?)`. Remote delivery
only redacts obvious local path fragments in main-agent
`message.completed.text`. Deltas, operation payloads, snapshots, and other
messages retain their native shape. Trusted-local delivery preserves every
event unchanged.

## Why two modes

`operation.raw.input/output/error` is the unmodified tool-call payload.
Toolkit authors also provide `operations[toolName].summarize{Input,Output,Error}`,
which produce a structured `{ target, summary, details }` projection of the
same data — see `packages/pet-agent/src/types/toolkit.ts`.

These two channels serve different needs:

- `summary/target/details` — small, schema-stable, safe to render anywhere.
  This is the stable display projection toolkit authors guarantee.
- `raw` — the full tool input/output. Useful for UIs that want to do things
  the toolkit author didn't pre-imagine: diff renderers, "expand JSON",
  re-running the call locally, debugging. It can be large and may contain
  sensitive content from the user's environment.

Both transports currently retain `raw`. The hosted app may use it for transient
tool rendering and debugging; it is not treated as a durable sanitized API
projection. If a future public API needs a stricter disclosure contract, that
policy belongs at that API boundary.

## Per-event lifecycle

```mermaid
sequenceDiagram
  autonumber
  participant Graph as LangGraph (pet-agent)
  participant Norm as agentStreamNormalizer
  participant Track as ToolOperationTracker
  participant Act as operationActivityState
  participant Send as sendLocalAgentEvent
  participant Local as TUI / companion
  participant App as Hosted app

  Graph->>Norm: on_tool_start { name, input, toolCallId }
  Norm->>Track: accept(payload)
  Track-->>Norm: event { phase:'started', raw:{input} }
  Norm->>Act: recordOperationActivity(event)
  par fan-out to both transports
    Norm->>Send: emit on local socket (audience=trusted-local)
    Send->>Local: { phase, operation, raw:{input} }
  and
    Norm->>Send: emit on app socket (audience=remote)
    Send->>App: { phase, operation, raw }
  end

  Graph->>Norm: on_tool_end { output }
  Norm->>Track: accept(payload)
  Track-->>Norm: event { phase:'completed', raw:{input,output} }
  Norm->>Send: emit (same fan-out rules)
```

When a turn ends mid-stream (user interrupt, error), the tracker's
`finishActive(phase, error)` synthesizes terminal events for any tool calls
that didn't naturally complete; they go through the same fan-out.

## Where `raw` is consumed locally

- `localServerOperationEvents.ts` — pretty-prints `raw.input/error` into the
  local-agent log (truncated). Lives inside the agent process; doesn't cross
  any wire.
- TUI / companion clients receive `event.operation.raw` through the local WS
  parser (`parseLocalAgentServerMessage`) and may use it for diff/inspection
  rendering. UIs that don't need raw can simply ignore it.

## Wire schema reference

```ts
type AgentOperationEvent = {
  type: 'operation';
  requestId: string;
  phase: 'started' | 'updated' | 'completed' | 'failed' | 'interrupted';
  operation: {
    id?: string;
    kind: string;                 // e.g. 'bash.read_file', 'browser.click'
    title?: string;               // human-readable, supplied by toolkit author
    target?: string;              // e.g. file path / URL
    summary?: string;             // short status, e.g. '已完成'
    details?: Record<string, unknown>; // toolkit-defined structured data
    source?: {
      provider: 'toolkit' | 'runtime';
      name: string;
      toolName?: string;
      callId?: string;
    };
  };
  raw?: {
    input?: unknown;
    output?: unknown;
    error?: unknown;
  };
};
```

`AgentOperationEvent` is the canonical operation event type. The trusted-local
vs remote split is enforced at the **transport** layer through `audience`, not
through separate internal and external event types. The current remote rule is
intentionally narrow: only main-agent `message.completed.text` is redacted.

`buildLocalAgentEventEnvelope` only frames a native event. It does not accept
an audience or apply disclosure policy. Remote egress must use
`sendLocalAgentEvent`; `sendLocalServerPeerEvent` is intentionally fixed to
trusted loopback peers.

## Adding a new transport

If you build a new egress (e.g. a different IPC, a webhook), select its
`audience` using the same rule:

- Trusted, same-machine, bandwidth-rich → `trusted-local`.
- Remote, multi-tenant, or low-bandwidth → `remote`.

If in doubt, use the default `remote` policy. This preserves protocol behavior
while applying the completed-message text transformation.
