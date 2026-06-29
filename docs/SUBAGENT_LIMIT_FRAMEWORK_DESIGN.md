# Subagent Limit Framework Design

> Deprecated. Do not use this document as the design source of truth.

The old subagent limit framework mixed several ideas together: local token fuse, repeated-input loop guard, LangGraph recursion fallback, and context rewrite policy. That design has been superseded.

Use [Guard Registry Design](./GUARD_REGISTRY_DESIGN.md) instead.

Current direction:

- Guard rules are registered through the shared guard registry.
- Token watermarks use provider `usage_metadata.input_tokens`, not local token estimation.
- Context rewrite/compaction execution remains policy or handler work, not the guard rule itself.
- Repeated-input detection is not part of the current guard layer.
- LangGraph `recursionLimit` remains a runtime hard breaker, not our guard contract.
