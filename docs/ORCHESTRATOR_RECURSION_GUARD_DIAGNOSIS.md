# Orchestrator Recursion Guard Diagnosis

> Deprecated. Do not use this document as the design source of truth.

This was a historical diagnosis for recursion-limit and old local-token-fuse behavior. The proposed fixes in the original note, including derived recursion formulas such as `maxRunIterations * NODES_PER_DELEGATION + MARGIN`, are no longer the guard design.

Use [Guard Registry Design](./GUARD_REGISTRY_DESIGN.md) instead.

Current direction:

- Orchestrator soft limits are expressed as registered guard rules.
- Context compaction watermark checks use provider `usage_metadata.input_tokens`.
- LangGraph `recursionLimit` is only a runtime hard breaker.
- Local token fuse and estimate-based limit decisions are deprecated.
