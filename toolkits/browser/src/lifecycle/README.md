# Browser Runtime: Page Lifecycle Primitives

> Addresses `pinpawo/pinpawo-agent#583` — *Browser Runtime: manage navigation
> readiness and browser lifecycle state*.

This directory contains the pure, unit-testable page-lifecycle primitives that
the Browser Runtime uses to manage each browser operation as a complete
lifecycle rather than a single "done or not" boolean.

Why a separate `lifecycle/` module? The issue's goal is to move navigation
readiness and lifecycle ownership out of tools, the extension background, and
model prompts and into the Runtime. Keeping this code free of CDP/extension I/O
lets us build and verify the state transitions in isolation (see the `*.test.ts`
files) before wiring them to the live extension event stream.

## Module map

| File                | Purpose                                                              |
| ------------------- | -------------------------------------------------------------------- |
| `navigation.ts`     | Navigation generation manager, phase state machine, settlement/readiness reducer |
| `targets.ts`        | Managed Target Registry (event-driven; active / opener / popup)       |
| `events.ts`         | Unified `BrowserRuntimeEvent` envelope + stale-event rejection        |
| `controller.ts`     | Runtime page-lifecycle controller: merges the event stream into the navigation reducer and exposes read-only phase/readiness/error/generation |
| `waiter.ts`         | `PendingWait<T>` — deadline, AbortSignal, and settle-once semantics    |
| `errorCodes.ts`     | Structured Runtime error codes                                         |
| `openReadiness.ts`  | Standalone `browser_open` readiness driver: walks an injected event sequence through the controller to `readable`, handling redirect/timeout/SPA-shell/long-lived/SPA-route-change scenarios |

## Navigation phase model

```
requested ──commit──▶ committed ──document.ready──▶ dom_ready
                                                     │       │
                                   settle fails (activity) │
                                                     ▼       ▼ settle passes
                                                  settling ──▶ readable
                                                     │
                                                     ▼  (any)
                                                  failed
```

`readable` and `failed` are terminal: later events are ignored. Every event,
target, and connection carries its own generation so a stale page/connection can
never pollute current Runtime state (`events.ts::isEventCurrent`).

## Page-readiness policy

`defaultPageReadinessPolicy` composes:

- `document.readyState` reached `interactive`/`complete`
- a readable body actually exists (textLength > 0 once sampled)
- inflight requests quiesced (long-lived WebSocket/SSE that never report
  inflight requests do **not** block forever)
- a settling window passed since the last *network* activity (DOM churn is
  tracked separately and does not re-arm the network settle window)

Thresholds are Runtime-internal policy, constrained by a unified deadline, and
are not encoded as fixed sleeps.

## Managed Target Registry

The registry owns the set of managed targets (agent-owned tabs, user-bound tabs,
popups) and is updated by lifecycle events. Closing the active target falls back
to the live opener (or the newest open primary/opener). Late events against a
closed target are rejected — a closed target cannot be resurrected.

## Wiring status

The extension already reports navigation and lifecycle transitions as
`browser.event` messages. `BrowserExtensionBridge` now exposes
`onRuntimeEvent(listener)` and forwards every incoming event (including the
legacy `tab.navigated`, mapped onto `navigation.committed`) as a unified
`BrowserRuntimeEvent`. Navigation-scoped events (`navigation.*`, `document.ready`,
`network.activity`, `dom.changed`, popup/download) are additionally stamped with
the active `navigationGeneration` (bumped via `beginNavigation()`, or
automatically when a `navigate` command is dispatched), so `isEventCurrent` can
drop late events that belong to a superseded navigation.

`BrowserLifecycleController` and `openReadiness.ts` provide the pure consumer of
this stream: they merge events via `applyNavigationEvent`/
`defaultPageReadinessPolicy`, reject stale events via `isEventCurrent`, and
expose a read-only snapshot (`hasActiveNavigation`, `phase`, `readable`, `error`,
`generation`, `context`). The controller also fails a navigation deterministically
via `notifyGenerationAdvance(connectionGeneration, targetGeneration)` — the
authoritative signal the driver sends when the bridge bumps its connection/target
generation (`runtime_disconnected` / `target_closed`) — and ignores malformed
url-less commits rather than treating them as benign intermediate steps.

The controller binds the bridge's navigation generation: `beginNavigation(
requestedUrl, approvedOrigin, connection, target, navigationGeneration)` accepts
the bridge-owned counter so event stamps and controller context always agree
(no independent second counter). A stale generation bump is never inferred from
a single late event (which would also kill old-navigation SPA events); only the
explicit `notifyGenerationAdvance` produces a deterministic failure.

`bindBridgeToController` (see `bridgeBinding.ts`) is the production seam that
closes the loop between the transport layer and the controller: it subscribes
`bridge.onRuntimeEvent` → `controller.handleEvent` and
`bridge.onGenerationChanged` → `controller.notifyGenerationAdvance`. The bridge
notifies that callback whenever it bumps its connection (`replaceActiveSocket`
on an extension reconnect) or target (`target.closed`) generation, so an
in-flight navigation fails deterministically with `runtime_disconnected` /
`target_closed` instead of hanging until its deadline — the #583 requirement
that "等待者得到确定结果" on detach/reconnect.

The controller's `beginNavigation` accepts the bridge-owned navigation
generation and its standalone fallback never regresses below the highest value
it has ever bound, so mixing an external binding with a later standalone call
cannot re-mint a lower generation that would let a stale higher-numbered event
be misread as current.

**Note:** the event stream is forwarded and consumed via
`bindBridgeToController`, but nothing in the runtime/session yet drives
`BrowserLifecycleController` end-to-end as the owner of `browser_open` /
interaction tools. Next steps (per the issue's suggested order) are to wire the
controller + `openReadiness` into `browser_open` and to have the extension emit
the finer-grained `network.activity` / `dom.changed` / `document.ready` events
the reducer already supports.
