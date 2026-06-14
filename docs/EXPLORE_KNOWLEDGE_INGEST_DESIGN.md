# Explore Knowledge Ingest Design

## Goal

`explore` is a read-only capability for investigation-heavy tasks. When the
model context is large enough, the primary strategy is to keep raw evidence
available to the exploration model. Knowledge ingest exists as a context-pressure
compression mechanism, not as a quality enhancer.

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
after every tool call. Tool results remain raw while the transcript fits within
the active context budget.

```text
before next model call
  -> contextPolicy estimates transcript size
  -> if under budget: leave raw tool output unchanged
  -> if over budget: explore calls ingest LLM with previous summary + older raw evidence
  -> older raw tool outputs are replaced with readable summary text plus structured metadata
  -> recent tool outputs remain raw
```

Finalization also runs through explore's `afterRun` middleware. The final
assistant note is ingested into the same private summary marker before the
capability result is read.

## Failure Policy

Knowledge ingest is the source of truth for `ExploreResult.summary`. If final
ingest fails, explore returns `completionReason: 'error'`. If context-pressure
ingest fails, the subagent stops instead of fabricating a summary.

There is intentionally no fallback that converts the latest free-form assistant
message into an explore result. A low-quality fallback summary can make resume
continue from biased or fabricated state, which is worse than stopping.

## Tool Output Policy

Tool-result truncation is not the normal explore strategy. While the transcript
is under budget, raw tool output stays visible to the exploration model. Once
the transcript exceeds the compression budget, older large successful tool
outputs may be rewritten as small readable summary text. The canonical summary
is stored in `additional_kwargs.pinpawo.exploreSummary`, not recovered by parsing
content markers. Recent tool outputs remain raw. Truncating old outputs is
avoided for explore because partial raw output can create misleading evidence.

## Reference Pattern

This follows the same architectural shape as Studio's wiki curator:

- archive or observe raw source,
- run a structured LLM step to update compact knowledge,
- make later workers consume the curated knowledge instead of raw history.

The orchestrator context compaction flow is only a fallback reference for prompt
principles such as preserving goals, progress, blockers, and next steps. It is
not the main explore memory model.
