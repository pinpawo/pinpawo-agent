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
| `interactionSettle.ts` | Standalone post-interaction settle driver for `browser_click`/`type`/`scroll`: walks an interaction's buffered events through the controller and decides `nav_generation` / `settled` / `failed` / `pending` / `timed_out`, mirroring `openReadiness` |
| `waitForReadiness.ts` | **Live** PendingWait-based readiness wait (issue #601): subscribes to a live event/generation stream, feeds it into a controller, and resolves deterministically via `PendingWait` on `readable` / `failed` / wall-clock `timed_out` (with phase / committed URL / readyState diagnostics guiding `browser_wait`) |

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

**Note (browser_open readiness, current scope):** `ChromeExtensionBrowserSession.open()`
drives the navigation through `BrowserLifecycleController` + `driveOpenReadiness`
(bounded by `OPEN_READINESS_DEADLINE_MS`), replaying the events the extension
emits during the navigate round-trip through the controller bound to the
bridge's own navigation generation. The extension emits `document.ready` /
`dom.changed` (with the sampled body text) in the navigate handler so the
reducer can reach `readable`; `BrowserRuntime` binds the bridge to the
controller via `bindBridgeToController` and exposes the current `readiness` on
its snapshot. This lets the Runtime **confirm the readiness verdict
post-hoc** and surface `origin_changed` / `navigation_timeout` deterministically.

**Scope caveat:** the *actual wait* for the page to stop loading is still the
extension's `waitForNavigableTab`, polling `tab.status === 'complete'` before
it captures the snapshot; the readiness events are derived *after* that capture
(back-filled from the snapshot), so the Runtime is currently reviewing facts the
extension already awaited, not driving a live event subscription. A live
readiness event stream (extension subscribing to `Page/Network` events and
reporting `network.activity` / repeated `dom.changed` while a page settles) is
the remaining follow-up that lets the Runtime *own* the wait.

`waitForReadiness.ts` (issue #601) provides the live-wait primitive for that
follow-up: `waitForReadiness(controller, { source, deadlineMs })` subscribes to a
`bridge.onRuntimeEvent` / `onGenerationChanged` source, feeds events into the
controller, and resolves via a `PendingWait` when the Runtime state machine
reaches `readable` / `failed` or the wall-clock deadline elapses — producing
phase / committed URL / readyState diagnostics on timeout to guide the caller
toward `browser_wait`. This is the mechanism that will replace the runtime's
post-hoc review once the extension emits a live (CDP `Page`/`Network`) stream;
the synchronous replayers (`openReadiness` / `interactionSettle`) remain the
current production path until block 1 (extension fire-and-forget navigate +
live CDP event reporting) lands.

**Interaction settle (issue step 4, current scope):** `interactionSettle.ts` is
the pure post-interaction settle driver (mirroring `openReadiness`), and
`ChromeExtensionBrowserSession` now routes `click`/`type`/`scroll` through it.
The session buffers the page-lifecycle events the extension emits around the
interaction, replays them via `driveInteractionSettle` against a controller bound
to the bridge's current navigation generation, and classifies how the action
settled: a newer-generation event is `nav_generation` (action started a new
navigation), a readable same-generation page is `settled`, a cross-origin/target
failure is `failed`, `pending`/`nav_generation` fall back to the already-returned
snapshot (backward compatible), and only a genuine settle deadline elapse
surfaces `navigation_timeout`. The same scope caveat applies: the extension
captures the snapshot before deriving readiness events, so the Runtime reviews
the post-action page rather than owning the wait via a live event subscription.
The `nav_generation` outcome is currently observed but its full readiness
hand-off is **intentionally deferred** — the extension has already returned a
snapshot of the produced page, and driving that navigation to `readable` is the
follow-up once a live navigation event stream lets the Runtime own the wait.
