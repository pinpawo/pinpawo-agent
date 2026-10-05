# Studio Dispatch Queue Notices

Status: implemented opt-in audit. Queue facts come from resident runtime through
`Studio.listDispatchQueues()`; the [Studio API](../reference/api/studio.md#global-dispatch-observation)
defines the snapshot. This audit is separate from Channel's immediate queue UI
and deferred automatic send acknowledgement.

Scheduler owns when to audit; Notice owns durable notification projection.
Neither schedules recovery work, retries dispatch, unblocks a Pet or changes gate state.
The event is a repeated fact, not a persisted queue or acknowledgement protocol.

```text
resident snapshot → Scheduler audit event → configured Notice rule → Console
```

## Configuration

Audit is off unless explicitly configured. It runs once at startup and at each
interval; with affected states it emits `dispatch.queues_attention_required` containing
`queues`, `attentionStates` and `checkedAt`. Healthy snapshots emit nothing.
Repeated intervals deliberately repeat the fact while the condition remains.

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

Notice delivery is selected independently:

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

Channel does not own this audit policy. Acknowledgement, escalation, deduplication
and external notification adapters require explicit Notice capabilities; none are implied.
See [Automation Plugins](studio/automation-plugins.md) for scheduling and event boundaries.
