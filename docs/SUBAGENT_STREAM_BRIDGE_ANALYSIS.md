# Subagent Stream Bridge Analysis

> Status: Phase 1 spike complete — verdict **GO** (two scoped caveats); Phase 2
> adapter landed as a parallel path. Updated: 2026-07-03. Referenced by issue
> #322.
> Spike evidence: `packages/pet-agent/src/subagent/rootStreamProjection.test.ts`.
> Adapter + correspondence tests:
> `services/local-agent/src/events/rootStreamEventAdapter.ts`.

## Why the bridge exists, and what it costs

Today `createSubagent()` consumes its own child `agent.streamEvents(v3)` and
manually re-emits everything through the `onToolEvent` callback:

- four parallel drain loops (`values`, `messages`, protocol tool events, the
  `toolCalls` projection) whose only job is to keep the child stream settled;
- `SubagentProtocolToolEventReader` (~110 lines): tool-name resolution,
  started/finished dedup sets, serialized-interrupt filtering;
- `buildNestedSubagentStreamConfig`: strips `callbacks`/`runId` from the
  parent config before the child run;
- `SubagentToolEventTracker` and the local-agent side normalizer that
  re-interprets the bridged events.

The stripping and the ALS isolation (#313, #316) are scar tissue: with the
child consuming its own stream while parent context bled in through
AsyncLocalStorage, two tracers shared one runTreeMap ("No run to end",
closed-controller errors). Those fixes treat symptoms of the two-stream
model; root streaming removes the second stream and with it the disease.

The event topology is also fragmenting: root `graph.stream(['messages',
'values', 'custom'])`, the subagent `onToolEvent` bridge, and
`dispatchCustomEvent` for traces are three channels that every new event kind
(most recently guard decision records, #318) must choose between or duplicate
across.

## Spike setup

A parent `StateGraph` whose node **dynamically** creates a `createAgent()`
child (mirroring capability/general lanes) and — the crucial change — awaits
`child.invoke(input, config)` with the parent config passed through untouched,
instead of stripping it and consuming a child stream. The root is consumed via
`graph.streamEvents(input, { version: 'v3' })`.

## Findings

### Confirmed working (the GO case)

1. **Child tool lifecycle** (`tool-started`/`tool-finished`) surfaces on the
   root protocol stream with the child's namespace.
2. **Child model calls** surface as namespaced `messages` lifecycles
   (`message-start` → `content-block-delta` → `message-finish`), i.e. live
   token streaming from the subagent is observable at root.
3. **Namespace depth is the attribution model**: depth 1
   (`["delegate:<task>"]`) marks messages a node adds to state; depth 2
   (`[..., "model_request:<task>"]` / `[..., "tools:<task>"]`) marks model
   calls and tool executions. `run.subgraphs` discovers the dynamic child as
   its own `SubgraphRunStream`.
4. **Custom events propagate child → root through the writer.** Pregel
   injects the stream writer with `config.writer ??= ...`, so a child invoked
   with the parent config writes through the *parent's* writer; `getWriter()`
   inside child middleware surfaces as a root protocol event
   (`method: 'custom'`). This is the native transport for guard decision
   records after the migration (today's `subagent_guard_decision` ride on the
   `onToolEvent` bridge must move here when the bridge is removed — see
   Phase 4 note below).
5. **Interrupts bubble and resume.** An `interrupt(...)` raised inside a
   child *tool* (the toolkit-review shape) surfaces in the root stream's
   `interrupts`, and a bare `Command({ resume })` against the parent
   checkpoint re-enters the child and completes the reviewed tool call.
6. **No tracer/closed-controller errors** in any scenario, including nested
   child-in-child — with no child-side stream consumption there is no second
   consumer to conflict with.

### Caveat 1 — tool-boundary nesting loses inner visibility

An agent invoked from inside a **tool** (subagent spawning a nested subagent,
the #313 shape) completes cleanly and its result flows back, but:

- it gets **no namespace segment of its own** (its state chunks flow
  flattened into the enclosing `tools:` namespace), and
- its **model message lifecycles do not surface** on the root stream at all.

One-level node → subagent nesting (the production orchestrator shape) is
fully projected; only tool-boundary nesting is affected. If live tokens from
nested subagents matter, that level needs either config surgery to
re-propagate the stream context through the tool boundary, a scoped bridge
for that hop only, or a LangGraph upgrade. The spike test pins the current
behavior so an upgrade that fixes it will fail the assertion and prompt a
revisit.

### Caveat 2 — consume the protocol stream, not the sugar projections

The ergonomic projections (`run.messages` and friends) showed
subscription-timing sensitivity in the spike: depending on when iteration
starts relative to the run, lifecycles could be missed. The **raw protocol
stream** (`for await (const event of run)`) reliably carries every event with
its namespace. The Phase 2 local-agent adapter should be built on the
protocol stream; adopting the sugar projections can be evaluated separately.

## Phase 2 — the root event-stream adapter (landed, parallel path)

`services/local-agent/src/events/rootStreamEventAdapter.ts` translates raw
root protocol events into the local-agent chat event vocabulary.
`LocalAgentGraphService.streamEvents(setup)` opens the v3 run alongside the
legacy `stream()`; nothing existing is rewired — the legacy path stays the
production default until the correspondence is validated end-to-end.

Correspondence with the legacy consumption (pinned by tests):

| Legacy (`graph.stream` + bridge) | Root adapter |
| --- | --- |
| `messages` chunk `[msg, metadata]`, `_getType() === 'ai'` | message lifecycle per namespace; a lifecycle is excluded only by a KNOWN non-assistant role — model streams omit `role` on `message-start` |
| `readStreamNode(metadata.langgraph_node)` | `readNamespaceNode(namespace[0])` (`"answer:<task>"` → `answer`) |
| `isOrchestratorInternalAiStreamNode` skip | same helper applied to the namespace node |
| `isLaneTaggedAiMessage` skip (lane tag on `additional_kwargs`) | protocol events do not carry `additional_kwargs`; the lane boundary is structural instead — depth ≥ 2 namespaces and depth-1 activity of lane nodes (`capability`/`general`) are subagent scope |
| prefix dedup (`chunkText.startsWith(streamedReply)`) | per-scope prefix dedup: a node that streams a model then writes the message to state produces a second full-content lifecycle (the state echo); lane nodes echo their child's stream one namespace level up, so subagent scopes key on the top-level lane segment |
| `values` payload with `__interrupt__` | root-namespace `values` event with `__interrupt__` |
| `onToolEvent` bridged tool lifecycle | `tools` protocol events with namespaces (operation metadata join is Phase 3) |
| `custom` stream mode chunks (#318) | `custom` protocol events filtered by `GUARD_DECISION_EVENT` / `SUBAGENT_GUARD_DECISION_EVENT` |

Two protocol facts the adapter had to absorb (worth knowing for Phase 3+):

- `content-block-delta` carries no message id; deltas belong to the message
  opened by the most recent `message-start` in the same namespace.
- `message-start` for live model streams carries no `role`; state-echo
  lifecycles may. Filtering must be "known non-assistant role excludes",
  not "assistant role includes".

## Implications for the #322 phase plan

- **Phase 2 (root stream adapter)**: consume raw protocol events keyed by
  `method` + `params.namespace`; use namespace depth (see finding 3) to
  attribute main vs subagent vs model/tool scope. Validate real-LangSmith
  tracer behavior here — the spike used fake models without a live tracer.
- **Phase 3 (operation projection)**: root `tools` events carry
  `tool_call_id`/`tool_name`; display metadata (title/target/summary) still
  needs the operation map joined in a transformer, as the issue anticipates.
- **Phase 4 (remove the bridge)**: subagent guard decision records must move
  from `onToolEvent` to the writer (`getWriter()`), which reaches the root
  protocol stream natively. The orchestrator guard emitter (#318) already
  writes to the writer; after local-agent consumes `streamEvents(v3)`, its
  `graph.stream` custom-mode leg can be re-evaluated (`dispatchCustomEvent`
  stays for LangSmith).
- **Nested subagents**: scope Caveat 1 explicitly — either accept flattened
  attribution for the inner level initially, or keep a minimal bridge for
  the tool-boundary hop only.
