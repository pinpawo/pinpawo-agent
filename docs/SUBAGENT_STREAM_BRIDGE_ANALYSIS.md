# Subagent Stream Bridge Analysis

> Status: **Phase 4 complete — the bridge is gone.** Root `streamEvents(v3)`
> is the production consumption path; `createSubagent()` invokes the child
> with the parent config passed through and consumes no stream of its own.
> Updated: 2026-07-04. Referenced by issue #322.
> Spike evidence: `packages/pet-agent/src/subagent/rootStreamProjection.test.ts`.
> Adapter: `services/local-agent/src/events/rootStreamEventAdapter.ts`.
> Production integration test:
> `packages/pet-agent/src/subagent/createSubagent.test.ts` (root-stream test).

## Why the bridge existed, and what it cost

Before Phase 4, `createSubagent()` consumed its own child
`agent.streamEvents(v3)` and manually re-emitted everything through the
`onToolEvent` callback:

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

## Phase 2 — the root event-stream adapter (landed; production since Phase 4)

`services/local-agent/src/events/rootStreamEventAdapter.ts` translates raw
root protocol events into the local-agent chat event vocabulary.
`LocalAgentGraphService.streamEvents(setup)` opens the v3 run; since Phase 4
it is the only consumption path (the legacy `stream()` method is deleted).

Correspondence with the legacy consumption (pinned by tests):

| Legacy (`graph.stream` + bridge) | Root adapter |
| --- | --- |
| `messages` chunk `[msg, metadata]`, `_getType() === 'ai'` | message lifecycle per namespace; a lifecycle is excluded only by a KNOWN non-assistant role — model streams omit `role` on `message-start` |
| `readStreamNode(metadata.langgraph_node)` | `readNamespaceNode(namespace[0])` (`"answer:<task>"` → `answer`) |
| `isOrchestratorInternalAiStreamNode` skip | same helper applied to the namespace node |
| `isLaneTaggedAiMessage` skip (lane tag on `additional_kwargs`) | protocol events do not carry `additional_kwargs`; the lane boundary is structural — depth-1 message activity of lane nodes (`capability`/`general`) is a state echo of what the depth ≥ 2 child scope already streamed, and is dropped exactly like the legacy lane-tag skip |
| bridged `subagent_message_delta` (token feed) | one completed `subagent.message` per child model lifecycle (buffered deltas flushed on `message-finish`, consecutive-identical echo dropped). Subagent runs contain MULTIPLE messages; token-level dedup across them is unsound (a later message may extend or repeat earlier text — the truncation/duplication P1), and the feed is ambient progress, so block-level granularity is the intended semantics |
| prefix dedup (`chunkText.startsWith(streamedReply)`) | kept for the MAIN assistant reply only (single-stream semantics, state-echo suppression) |
| `values` payload with `__interrupt__` | root-namespace `values` event with `__interrupt__` |
| `onToolEvent` bridged tool lifecycle | `tools` protocol events with namespaces (operation metadata join is Phase 3) |
| `custom` stream mode chunks (#318) | `custom` protocol events filtered by `GUARD_DECISION_EVENT` / `SUBAGENT_GUARD_DECISION_EVENT` |

Deliberate granularity change: the legacy bridge streamed subagent tokens
live; the adapter emits completed subagent messages. Live "typing" for an
ambient feed bought the whole token-dedup bug class; activity signals still
arrive from tool lifecycle events between messages. If per-token subagent
streaming ever becomes a product requirement, it must be scoped per message
lifecycle (deltas between one `message-start`/`message-finish` pair), never
accumulated across a lane.

Two protocol facts the adapter had to absorb (worth knowing for Phase 3+):

- `content-block-delta` carries no message id; deltas belong to the message
  opened by the most recent `message-start` in the same namespace.
- `message-start` for live model streams carries no `role`; state-echo
  lifecycles may. Filtering must be "known non-assistant role excludes",
  not "assistant role includes".

## Phase 3 — operation metadata projection (landed; folded into the tracker path in Phase 4)

Root protocol `tools` events carry only `tool_call_id`/`tool_name` (the name
only on `tool-started`); the TUI operation timeline needs title/target/summary
from the operation registry. The production chain after Phase 4:

```
adapter `tool` event
  → NamespacedProtocolToolEventReader (pet-agent: per-namespace name memory,
                                       started/finished dedup,
                                       serialized-interrupt swallowing)
  → emitToolEvent → ToolOperationTracker (registry join, summary inheritance,
                                          finish-active-on-abort)
  → LocalAgentOperationInternalEvent
```

`SubagentProtocolToolEventReader` moved out of `createSubagent.ts` into
`subagent/protocolToolEvents.ts` and is exported. `tool_call_id`s are only
unique within the scope that produced them, so root-stream consumers use
`NamespacedProtocolToolEventReader` — one reader per namespace; two scopes
reusing an id must not share dedup/name state.

## Phase 4 — the bridge is removed (landed)

What changed, per surface:

- **`createSubagent()`** no longer consumes a child `streamEvents()` run: the
  child is `invoke()`d with the parent config passed through untouched. The
  four drain loops, `SubagentToolEventTracker`, `subagent_message_delta`
  bridging, `buildNestedSubagentStreamConfig` and the ALS-clearing scar
  tissue (#313/#316) are deleted; the child no longer takes an explicit
  checkpointer (it inherits the parent's through the config — the spike's
  interrupt test pins that a bare `Command({ resume })` against the parent
  re-enters the child). `SubagentRunInput` lost `onToolEvent`/`checkpoint`.
- **Guard decision records** ride the stream writer (`getWriter()`) with the
  shared `{ event: 'on_runtime_event', name, data }` envelope and surface as
  root `custom` protocol events (`SUBAGENT_GUARD_DECISION_EVENT`).
- **Per-delegation operations** (`SubagentRunInput.operations`, e.g. a
  capability's private toolset metadata) are announced through the writer as
  `SUBAGENT_OPERATIONS_EVENT`; local-agent overlays them on the request's
  operation registry (`acceptDelegationOperations` →
  `ToolOperationTracker.overlayOperations`). This closes the switchover
  checklist item: delegation-scoped tools that are in no static toolkit still
  join display metadata.
- **local-agent chat** (`runChatSession`) consumes
  `graphService.streamEvents(v3)` through `adaptRootStream`; the legacy
  `graph.stream(['messages','values','custom'])` method is deleted. Tool
  protocol events are translated to lifecycle payloads by
  `NamespacedProtocolToolEventReader` and joined with the registry by the
  existing `ToolOperationTracker` (which also finishes dangling operations on
  abort).
- **Invoke-style consumers** (`runAgent`, the Studio pet runtime) are plain
  `graph.invoke()` again. The Studio surface has no UI today, so its whole
  `onToolEvent` threading (studio types/orchestrator/pet runtime, local-agent
  studio handler/scheduler/run service) was deleted rather than shimmed; if a
  Studio timeline ever ships, it should consume the root stream directly, not
  a callback bridge.
- **`onToolEvent` no longer exists.** Toolkit runtime events (authorization
  notices) also ride the stream writer: nodes wire `ToolkitContext.
  emitRuntimeEvent` to `createRuntimeEventStreamEmitter()`, and runChatSession
  maps the known names to system notices from `runtime.custom` chat events.
  One protocol fact learned here: `getWriter()` resolves through
  AsyncLocalStorage and does NOT reach tool-execution scopes inside a child
  agent (the same tool boundary as Caveat 1) — review middleware emits from
  inside wrapped tools, so the writer must be CAPTURED at node time and
  closed over, not resolved at emission time.

Remaining scope (unchanged from the spike):

- **Nested subagents (Caveat 1)**: tool-boundary nesting still loses inner
  visibility; we accept flattened attribution for that level. The pinned
  spike assertion will flag a LangGraph upgrade that changes this.
- **Live tracer validation**: the spike and tests use fake models without a
  live LangSmith tracer; watch the first live runs for tracer regressions
  (the two-stream disease itself can no longer occur — there is no second
  consumer).
