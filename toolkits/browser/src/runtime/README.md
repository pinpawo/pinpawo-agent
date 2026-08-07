# Browser Runtime: Page Lifecycle Primitives

> Addresses `pinpawo/pinpawo-agent#583` — *Browser Runtime: manage navigation
> readiness and browser lifecycle state*.

This directory contains the pure, unit-testable page-lifecycle primitives that
the Browser Runtime uses to manage each browser operation as a complete
lifecycle rather than a single "done or not" boolean.

Why a separate `runtime/` module? The issue's goal is to move navigation
readiness and lifecycle ownership out of tools, the extension background, and
model prompts and into the Runtime. Keeping this code free of CDP/extension I/O
lets us build and verify the state transitions in isolation (see the `*.test.ts`
files) before wiring them to the live extension event stream.

## Module map

| File                | Purpose                                                              |
| ------------------- | -------------------------------------------------------------------- |
| `navigation.ts`     | Navigation generation manager, phase state machine, settlement/readiness reducer |
| `readiness/*`        | (inline) combined page-readiness policy in `navigation.ts`            |
| `targets.ts`        | Managed Target Registry (event-driven; active / opener / popup)       |
| `events.ts`         | Unified `BrowserRuntimeEvent` envelope + stale-event rejection        |
| `waiter.ts`         | `PendingWait<T>` — deadline, AbortSignal, and settle-once semantics    |
| `errorCodes.ts`     | Structured Runtime error codes                                         |

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
- a settling window passed since the last network/dom activity

Thresholds are Runtime-internal policy, constrained by a unified deadline, and
are not encoded as fixed sleeps.

## Managed Target Registry

The registry owns the set of managed targets (agent-owned tabs, user-bound tabs,
popups) and is updated by lifecycle events. Closing the active target falls back
to the live opener (or the newest open primary/opener). Late events against a
closed target are rejected — a closed target cannot be resurrected.

## Wiring status

These primitives are the first tracked step of issue #583. Next steps (per the
issue's suggested order) are to have the extension/CDP driver emit the unified
events (`events.ts`) and then drive these reducers from the live stream, before
re-automating `browser_open`/interaction tools around the resulting readiness.
