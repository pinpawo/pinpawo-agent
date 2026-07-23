---
title: Local-Agent Transport Boundary
page_type: concept
status: validated
updated: 2026-07-23
sources:
  - ../../LOCAL_AGENT_SESSION_PROJECTION.md
  - ../../../services/local-agent/src/localServerPeer.ts
  - ../../../services/local-agent/src/localServerMessageDispatcher.ts
  - ../../../services/local-agent/src/localServerStdioTransport.ts
  - ../../../services/local-agent/src/localServerHandlers.ts
  - ../../../services/local-agent/src/localAgentProtocol.ts
  - https://github.com/pinpawo/pinpawo-agent/issues/386
related:
  - ../local-agent-session-projection.md
  - session-projection-ownership.md
  - ../questions/session-projection-open-questions.md
---

# Local-Agent Transport Boundary

## Goal

**Decision (issue #386).** The same typed local-agent messages and the same
reducer/handler paths run over WebSocket or newline-delimited stdio without
putting transport concepts into the session, timeline, snapshot, or review domain
models. Transport selection and protocol/domain mapping stay separate.

## Peer identity, not `WebSocket`

**Fact.** Server handlers depend on a narrow
[`LocalServerPeer`](../../../services/local-agent/src/localServerPeer.ts)
(`isConnected` + `send`), not a `WebSocket`. Object identity scopes
transport-local inflight delivery and per-peer queues. Upgrade, authentication,
Origin checks, readiness, framing, and serialization stay inside the WebSocket
adapter. Message parsing and routing live in a transport-neutral dispatcher.

**Invariant.** Peer identity scopes delivery only; it never determines review
validity. Review validity is session/checkpoint-derived, so a reconnect (new peer
object) does not invalidate a pending review.

## Two transports, one handler composition

**Fact.** `createLocalServerHandlers` composes chat, Studio, review, interrupt,
and session-command handling once; both the WebSocket transport and the one-peer
JSONL stdio transport attach to it. The stdio transport
([`localServerStdioTransport.ts`](../../../services/local-agent/src/localServerStdioTransport.ts))
reserves stdout for protocol messages, sends diagnostics to stderr (global
`console` is redirected), bounds input line framing and output backpressure, and
treats stdin EOF as peer disconnect that aborts active work.

## Session commands: one implementation, two access paths

**Fact.** Snapshot, list, and resume are implemented once on the server
(`loadSnapshot` / `listSessions` / `resumeSession`) and exposed on two access
paths: HTTP endpoints (`/snapshot`, `/sessions`, `/sessions/resume`) used by the
TUI today, and correlated wire commands (`session.snapshot.get`, `session.list`,
`session.resume`) used by spawned stdio clients. Both share the same
transport-neutral snapshot parser. Session-command responses never enter the
timeline reducer.

**Decision.** Session resume admission is actor-wide and shared across HTTP and
stdio: a session switch and chat operations never overlap, and HTTP returns
`409` on an active-run conflict.

## Deliberately not built

**Decision.** No generic pending-command framework, command bus, acknowledgement
protocol, wire-protocol renaming, or `session.patch` / revision numbering was
introduced. Snapshot remains a point materialization, not a transport recovery
protocol.

## Open edge

**Inference.** The TUI still reaches session operations through the HTTP side
channel while stdio clients use the wire `session.*` channel, leaving two client
parsers for the same operations. Migrating the TUI onto the wire channel is the
logical last step of #386 and is tracked in
[open questions](../questions/session-projection-open-questions.md).
