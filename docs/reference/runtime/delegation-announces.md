# Delegation Result Delivery

<a id="delegation-announce-contract"></a>
<a id="identity-and-lifecycle"></a>
<a id="publish-before-acceptance"></a>
<a id="consumer-projection"></a>
<a id="compaction-timing"></a>
<a id="invariants"></a>

> **Current contract; retained path.** The earlier Announce payload and its
> identity/acceptance metadata were removed. The old path remains for links; the
> [previous Announce document](https://github.com/pinpawo/pinpawo-agent/blob/29f0bec9094a0be57ed48f03778ce2a7ccc6ac3d/docs/reference/runtime/delegation-announces.md)
> is historical.

A Supervisor `delegate_capability` call returns a paired `ToolMessage`. Its
artifact records the actual execution snapshot and result. A non-empty delivery
has `returned` status and includes the task, text and scope; no new delivery
returns `missing_deliverable` with an error tool status. A rejected call has its
own record, and a rejected or cancelled human review is represented separately.
The result is evidence for Supervisor, not an automatic acceptance decision.
See [execution records](../../../packages/pet-agent/src/agent/orchestrator/executionMessages.ts),
[Capability execution](../../../packages/pet-agent/src/agent/orchestrator/capabilityExecution/runner.ts)
and the [state and handoff design](../../design/agent-runtime/run-scoped-supervisor-session.md).

Child messages remain in the subgraph namespace (and its checkpoint when
configured) instead of being copied into Root as a transcript. Root compaction retains the recent suffix and
actual call/result records needed for unfinished plan items; it does not use
Announce identity. See [context compaction](../../../packages/pet-agent/src/agent/orchestrator/contextCompaction.ts).
