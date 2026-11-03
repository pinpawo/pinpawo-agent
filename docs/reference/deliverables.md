# Deliverables

A deliverable is a tool-declared reference, `{ uri: string, title?: string }`.
It can identify a published file or another result, such as a pull request.
The reference contract does not store file contents or define an upload service.

## Tool declaration and execution record

Tools from any Toolkit may return the same declaration in
`ToolMessage.artifact.deliverables`. The public `@pinpawo/agent-contracts`
helpers validate it before the tool returns:

```ts
const artifact = createToolDeliverables([
  { uri: 'https://example.com/repository/pull/1', title: 'Pull request' },
]);
```

Toolkit names do not change collection behavior. Tools without a declaration keep
their ordinary result behavior. Capability execution accumulates declarations
when results are produced, deduplicates by URI, and records them in the existing
`delegate_capability` result. Context summarization does not discard this
accumulated data; references already declared also remain recorded after review
rejection or cancellation. Cross-graph `Command` control transfers pass through
unchanged and are outside the current collector's guarantee.

The execution record distinguishes `delivery.text`, the executor's report, from
`deliverables`, the references it declared. Recording a reference is not
Supervisor acceptance. Public replies carry the references selected from the
current run's accepted executions through the existing message, snapshot and
Channel paths; they are not inferred from reply prose.

The removed Capability Artifact Pipeline is retained only as
[historical documentation](../history/artifacts/pipeline/index.md). Its store,
finalize write interface and artifact-discovery tools are no longer runtime
contracts. Existing files are not deleted by this code removal.

File publishing, local/object-store adapters and reference downloads are described
in the [Session Artifacts design](../design/agent-runtime/session-artifacts.md).
Their availability must be assessed separately from the reference contract.
