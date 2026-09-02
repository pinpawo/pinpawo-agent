# Studio Dispatch Queue Notices (Draft)

## Purpose

Surface resident Pet dispatch queues that require attention without making Studio
Core, Kanban, or Scheduler responsible for each other’s domains.

The first use case is a periodic audit: a Studio operator wants to know when a
Pet queue remains `waiting` for input or `blocked` behind an unfinished continuation.

## Boundaries

- The resident runtime owns the complete dispatch queue: pending dispatches,
  conversation priority, active work, and admission state are one state machine.
- Studio Core exposes a read-only, instantaneous `listDispatchQueues()` snapshot
  to Plugins. It does not persist, interpret, or recover queue state.
- Scheduler owns the time policy. Its optional `dispatchQueueAudit` configuration
  decides when to inspect queues and which states require attention.
- Scheduler publishes a fact event, `dispatch.queues_attention_required`; it
  does not select a notification channel.
- Notice owns durable notification projection. It subscribes to configured
  Studio-event rules, stores notices, and makes them visible through its HTTP
  route. It does not change gate state or dispatch work.
- Console is one Notice consumer. Future desktop, email, or chat delivery can
  consume the same persisted notice or event without changing Scheduler.

This keeps the flow unidirectional:

```
resident Pet dispatch queue -> Studio read-only snapshot -> Scheduler audit event
                                            -> Notice projection -> Console
```

## Configuration

Scheduler auditing is opt-in so ordinary Studio deployments do not acquire a
background health policy accidentally:

```json
{
  "id": "@pinpawo-plugin/scheduler",
  "options": {
    "dispatchQueueAudit": {
      "intervalMs": 600000,
      "attentionStates": ["waiting", "blocked"]
    }
  }
}
```

The audit also runs once at Scheduler startup. If a configured attention state
is present, Scheduler emits one event with the affected queue snapshot: `petId`,
state, active operation, and pending counts. It
emits no event for a healthy snapshot. Repeated intervals intentionally produce
repeated facts while the condition remains, so an unavailable Console does not
silently erase the operational signal.

Notice rules are separately configured and only match event facts:

```json
{
  "id": "@pinpawo-plugin/notice",
  "options": {
    "rules": [{
      "noticeId": "dispatch-queues-attention",
      "title": "Dispatch queues need attention",
      "level": "warning",
      "source": {
        "kind": "studio_event",
        "eventSource": "scheduler",
        "type": "dispatch.queues_attention_required"
      }
    }]
  }
}
```

## Non-goals

- Notice does not retry or unblock a Pet queue.
- Scheduler does not infer task status from a queue or dispatch a recovery task.
- Kanban does not inspect Pets or notification channels.
- This draft does not define acknowledgement, escalation, deduplication, or
  external delivery adapters. Those become explicit Notice capabilities only
  when a concrete consumer requires them.
