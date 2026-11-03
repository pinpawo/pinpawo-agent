# Deliverables

This reference describes the Session Artifacts implementation. The
[design](../design/agent-runtime/session-artifacts.md) remains a draft.

A deliverable is a tool-declared reference, `{ uri: string, title?: string }`.
It can identify a published file or another result. An
[artifact](artifacts/index.md) is one source of deliverables; the reference
contract itself does not store file contents.

## Declaration and collection

Every Toolkit uses the same `ToolMessage.artifact.deliverables` field.
Validate the declaration before returning it from a tool:

```ts
import { createToolDeliverables } from '@pinpawo/agent-contracts';

const artifact = createToolDeliverables([
  { uri: 'https://example.com/repository/pull/1', title: 'Pull request' },
]);
```

The helper rejects a missing array, an empty URI, or a non-string title. It
preserves reference values and permits other tool-result metadata. Toolkit
names do not affect collection. Tools without declarations keep their ordinary
result behavior.

Capability execution collects references when tool results are produced. Its
checkpoint state accumulates declarations for that delegation, keeps the first
reference for each URI, and preserves their order. Private-context compression
does not reconstruct references from prose. Review rejection or cancellation
does not discard references already recorded in that delegation.

The collector preserves ordinary tool errors, interrupts and aborts. Same-graph
`Command` results can carry declarations in their tool messages. Cross-graph
`Command` transfers pass through unchanged and are outside the collection
guarantee; current Entry and Supervisor control transfers do not declare
deliverables.

## Acceptance and the public reply

The existing delegation execution record separates `delivery.text`, the
executor's report, from `deliverables`, its declared references. A returned
execution is not proof of Supervisor acceptance.

A successful `review_current(completed: true)` result stores an
`acceptedExecution` projection with the accepted delegation ID and its
references. This reuses the review result rather than adding an acceptance
state machine. Public selection reads successful, paired review results for
the reply's run, merges references in acceptance order and deduplicates by URI.
A rejected earlier attempt remains execution evidence and does not accompany
the reply merely because it returned.

Root compaction preserves Supervisor work and the actual records needed to
review unfinished plan items. The final reply freezes selected references in
its message metadata. Host live events and checkpoint snapshots project that
same metadata; they do not parse links from the reply text.

```text
ToolMessage.artifact.deliverables
  -> delegation checkpoint state
  -> delegate_capability execution record
  -> successful review_current acceptedExecution
  -> final reply metadata
  -> message.completed and snapshot
  -> Channel message and addressed Pet input
  -> Console / TUI
```

## Channel contract

Human and Pet messages use `deliverables: [{ uri, title? }]`. New Channel writes
accept at most 100 references, 4096 characters per raw URI, and 500 per title.
They do not truncate or rewrite references. Invalid Pet references fail the
write and emit `channel.message_failed`.

Migration `0003_channel_deliverables` converts historical `artifacts` to the
new field, processing message history in pages of 100. A label becomes a title;
a version is retained as `label · version`, or `uri · version` without a label.
The original JSON remains for historical preservation. Readers and new writes
use `deliverables`, not a second legacy field. Migrated titles can exceed the
new-write limit and remain readable. Old clients submitting `artifacts` must
update.

## Compatibility

The execution record now requires `deliverables` in place of legacy
`artifacts`. Host defaults use the project persistence path label
`capability-v6` and a corresponding TUI registry. This is not a LangGraph
checkpoint-format version. New default paths do not read or migrate v5
sessions; old files remain on disk. Existing deployments are not switched by
source changes.

The legacy Capability Artifact Pipeline is
[historical documentation](../history/artifacts/pipeline/index.md).
Its store, discovery tools, session index and finalize write APIs are removed.
Ordinary finalize rewriting of `output` / `messages` remains available. External
Capabilities using the removed interfaces must update.

Source: [reference validation](../../packages/agent-contracts/src/deliverable.ts),
[collector](../../packages/pet-agent/src/subagent/toolDeliverables.ts),
[acceptance projection](../../packages/pet-agent/src/agent/orchestrator/executionReviews.ts),
and [Channel migration](../../plugins/channel/src/store/kysely/migrations.ts).
