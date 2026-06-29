# Explore Knowledge Ingest Design

## Goal

`explore` is a read-only capability for investigation-heavy tasks. The primary
strategy is to keep recent raw evidence available to the exploration model.
Knowledge ingest exists to replace older large tool outputs with durable summary
evidence, not as a quality enhancer.

## Result Shape

The public capability result stays intentionally small:

```ts
type ExploreResult = {
  status: 'progress' | 'completed';
  summary: string;
  nextSteps: string[];
};
```

`summary` carries the useful structure:

```md
## 目标

## 已查看文件

## 关键知识点 / 概念

## 已确认事实

## 未确认 / 风险

## 下一步
```

`nextSteps` is kept for compatibility with structured capability results, but
the canonical continuation state is inside `summary`.

## Ingest Flow

The ingest logic is private to the `explore` capability. It is not triggered
after every tool call. Recent tool results remain raw; older large successful
tool results are eligible for ingest and replacement only after the latest
provider `usage_metadata.input_tokens` crosses the shared context watermark.

```text
before next model call
  -> subagent context rewrite guard checks latest provider input_tokens against the context watermark
  -> rewrite handler finds older large successful tool results
  -> if none are eligible: leave raw tool output unchanged
  -> if eligible: explore calls ingest LLM with previous summary + older raw evidence
  -> older raw tool outputs are replaced with readable summary text plus structured metadata
  -> recent tool outputs remain raw
```

Finalization also runs through explore's `afterRun` middleware. When old-output
ingest already produced an inline `Explore summary:` marker in a dedicated
assistant message, that summary is persisted into artifact metadata as-is.
Otherwise, final output is optionally re-ingested once by a lightweight finalizer
and persisted as the run-level `kind: "report"` artifact (if the structured
ingest succeeds).

## Failure Policy

`ExploreResult.summary` is still read from structured summary markers only.
If old-output ingest fails, the run keeps raw context and continues; if final
re-ingest fails, no summary artifact is written and the run still returns.

There is intentionally no direct parse-based fallback that turns latest free-form
assistant text into result state. The final fallback is a structured re-ingest
step that writes a best-effort `report` artifact while preserving strict error
behavior for run state.

## Tool Output Policy

Tool-result truncation is not the normal explore strategy. Recent raw tool output
stays visible to the exploration model. Older large successful tool outputs may
be rewritten as small readable summary placeholders, and a dedicated
`Explore summary:` assistant message is appended to the lane transcript. The
canonical summary comes from this assistant message content (not from
`additional_kwargs`) so downstream code can read it with a simple marker parser.
Truncating old outputs is avoided for explore because partial raw output can
create misleading evidence.

## Reference Pattern

This follows the same architectural shape as Studio's wiki curator:

- archive or observe raw source,
- run a structured LLM step to update compact knowledge,
- make later workers consume the curated knowledge instead of raw history.

The orchestrator context compaction flow is only a fallback reference for prompt
principles such as preserving goals, progress, blockers, and next steps. It is
not the main explore memory model.
