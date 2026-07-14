# Subagent Limit Framework Design

> Deprecated. Do not use this document as the design source of truth.

The old subagent limit framework mixed several ideas together: local token fuse, repeated-input loop guard, LangGraph recursion fallback, and context rewrite policy. That design has been superseded.

Use [Guard Design](./GUARD_DESIGN.md) instead.

Current direction:

- Subagent iteration limits use the explicit iteration guard.
- Subagent context windows use LangChain `summarizationMiddleware`, configured
  only from `contextWindowTokens`.
- Capability-level context policy, rewrite callbacks and tool-result eviction are removed.
- Orchestrator compaction remains a separate graph-level guard/executor flow.
- Repeated-input detection is not part of the current guard layer.
- LangGraph `recursionLimit` remains a runtime hard breaker, not our guard contract.
