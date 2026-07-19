# Explore Knowledge Ingest Design

## Goal

`explore` is a read-only capability for investigation-heavy tasks. Context-window
maintenance and durable artifact persistence are separate concerns:

- `createSubagent()` owns in-loop context summarization for every subagent.
- Explore `afterRun` owns the final structured `summary + evidence` artifact.

Explore does not provide a custom context rewrite callback and does not persist
artifacts from inside the agent loop.

## Result Shape

```ts
type ExploreResult = {
  status: 'progress' | 'completed';
  summary: string;
  nextSteps: string[];
};
```

The canonical `summary` is exposed through an `Explore summary:` message. The
durable report artifact stores the same readable summary plus structured evidence:

```ts
type ExploreKnowledgeIngest = {
  summary: string;
  evidence: Array<{ source: string; proves: string; value: string }>;
};
```

## Runtime Flow

```text
createSubagent(contextWindowTokens)
  -> LangChain summarizationMiddleware monitors message tokens
  -> when the derived trigger is reached, older execution context is summarized
  -> the summary is persisted in subagent state (`lc_source: summarization`)
  -> Explore continues with the summary plus recent raw messages

Explore afterRun
  -> collect the latest LangChain summary, newest tool results and final answer
  -> run one structured final ingest
  -> append `Explore summary:` when the ingest produced a new version
  -> if the subagent has no announce, expose that generated summary by its message id
  -> write one `kind: "report"` artifact through CapabilityArtifactStore
  -> record the returned ref through CapabilityMiddlewareContext
```

The final ingest prompt preserves file paths, URLs, issue/PR identifiers, commands,
errors and other source references. It may refine an earlier Explore summary from a
continued delegation. When the evidence budget is reached, newer tool results take
priority over older results.

## Failure Policy

- LangChain summarization is part of the shared subagent runtime, not Explore.
- A summarization error aborts the subagent before its `RemoveMessage` state update is committed.
- If final structured ingest fails and an earlier Explore/LangChain summary exists,
  `afterRun` uses that summary as a best-effort artifact payload.
- If no summary or final evidence is available, no artifact is written.
- Store failures are logged and do not fail the subagent result.
- Free-form assistant text is never parsed directly as `ExploreResult`; only the
  explicit `Explore summary:` marker is canonical result state.

## Ownership

- Toolsets/toolkits own limits on a single tool response.
- `createSubagent` owns window-triggered execution-history summarization.
- Explore owns final knowledge normalization and artifact persistence.
- The orchestrator owns artifact refs and handoff visibility, not artifact bytes.
