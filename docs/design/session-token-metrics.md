# Session token metrics (draft)

Status: implementation draft for review, 2026-10-19. Baseline: main `28219b7a`.

## Boundaries and evidence

`ServerTuiSessions` maps an interactive session to a checkpoint `threadId`.
Channel is a Studio collaboration scope, not a shared token billing bucket:
its participating Pets have distinct sessions/threads. The Console opens the
Pet session identified by a Channel session reference. One graph run/request
is a turn or resume segment; a model invocation is a smaller boundary.

Previously, `readMessagesTokenUsage` summed retained model messages and
`capabilityTokenUsage` ToolMessage summaries. `chatSessionAdapter` diffed
initial/final messages for a run; `agent-session/project` added run totals.
Checkpoint recovery rebuilt totals from the current transcript. That covers
retained child summaries but can lose compacted messages, failed calls and
usage from model calls whose messages are not retained. Replayed run totals
also depend on transport deduplication.

DeepSeek cache normalization uses the existing OpenAI-compatible boundary;
it does not change streaming defaults or the changes proposed in #984.

## Minimal shared contract

`TokenUsageSnapshot` carries cache numerator and its known input denominator,
unknown-call count/incomplete marker, and an optional output rate with
`stream` or `final` provenance. `usage.updated` carries an **absolute session
snapshot** with a ledger epoch and monotonic revision. Older revisions in
the same epoch cannot replace newer totals, including late completions and
same-session history reads. A rebuilt transient ledger has a new epoch. The
shared session reducer replaces its total, so repeated updates
and final completion do not count tokens again. TUI and Console use
`formatSessionUsageMetrics`; no separate metrics panel is introduced.

- Cache: sum(cache reads) / sum(input for calls reporting cache reads).
  Missing fields remain unknown, including providers that never report zero.
  `*` means some input has unknown cache coverage, including unreported calls
  whose input size is itself unavailable. Writes
  are input consumption but never hits. Cached input is already a subset of
  normalized input and is never added to total again.
- Raw Anthropic usage excludes cache read/write from `input_tokens`; add those
  only for that raw shape. LangChain normalized input already includes them.
  DeepSeek `prompt_cache_hit_tokens` becomes OpenAI-compatible
  `prompt_tokens_details.cached_tokens` before the adapter discards it.
- Session: known provider input/output/total across all inherited model
  callbacks, including private Supervisor/maintenance and Capability scopes.
  Provider `total_tokens` is authoritative; absent total is input + output.
  Reasoning detail is not added again to output or total.
- Speed: provider output tokens / elapsed seconds from first nonempty streamed
  content (text, reasoning, data or tool arguments) to the usage sample/model
  end. TTFT is excluded; terminal/network trailer overhead is included.
  At least two output callbacks and positive elapsed time are required.
  Chunk count is timing evidence only. Native running usage snapshots produce
  `~` live rates; final usage replaces them. With no intermediate provider
  token counts the live rate remains `–`; final usage can still produce a
  final rate. If reported output includes reasoning tokens but no reasoning
  stream was observed, rate stays unknown to avoid counting hidden reasoning
  against only the visible-text interval. Buffered/single-chunk and nonstreaming calls remain `–`.
  The displayed rate belongs to the latest observed call, not a sum of parallel
  child rates or an end-to-end session throughput.

## Persistence and recovery

FileSaver stores `usage.json` inside the encoded thread directory, under its
existing writer lock and atomic file writer. Each callback invocation ID is a
record key. Start persists a pending record before model work; running usage
replaces that record; completion replaces it with final usage. Missing usage,
errors and crash-surviving pending records mark the total incomplete (`≥`).
Reported partial usage survives an error. Replayed starts/errors cannot erase
completed usage, and duplicate final reports are ignored. The ledger records
which call last changed its state; live and restored speed use that same call.
Alternatives in one model response share usage and are counted once. Thread deletion removes its usage; checkpoint compaction/GC
leaves usage records intact. Multiple child callbacks serialize ledger writes.

Existing sessions import retained transcript usage once as an incomplete
baseline, because earlier compaction or failed requests cannot be reconstructed.
After import, callback records are the source of truth; Capability summaries
are not additionally summed. Restored UI snapshots use this same ledger.
Third-party checkpointers without both usage-store methods get an in-memory
ledger scoped to their checkpointer instance. Live statistics still work, but
remain incomplete because the accounting cannot survive a Host restart.
After replacement, retained transcript usage becomes an incomplete baseline;
a new epoch prevents the old revision from blocking fresh updates.
Implementing `SessionUsageStore` provides durable coverage. Custom graph
services that bypass HostGraphService retain transcript fallback behavior.

Usage attached to a native pause is applied before the run closes. On abort,
Host publishes the settled ledger before the terminal interruption event;
new turns/resumes clear the previous call's rate while preserving totals.
Malformed counters/cache coverage or corrupt ledger records are rejected;
they cannot turn into complete zero-usage snapshots.

These are **known usage totals, not a provider billing statement**. Provider/SDK
internal HTTP retries without their own model callbacks or usage cannot be
individually measured. Observable model retries have separate invocation IDs;
failed unreported invocations remain unknown. The implementation neither
changes SDK retry policy nor fabricates charges for hidden HTTP attempts.
A crash before a callback's usage reaches durable storage can also lose that
report; its persisted start retains the incomplete marker.

## Sources and verification

Provider field semantics checked against [DeepSeek cache usage](https://api-docs.deepseek.com/guides/kv_cache/),
[Claude cache usage](https://platform.claude.com/docs/en/build-with-claude/prompt-caching),
and [OpenAI reasoning usage](https://developers.openai.com/api/docs/guides/reasoning),
plus installed LangChain/OpenAI adapter source. Tests use local scripted models
and loopback HTTP only; no paid model invocation or production state is used.

Tests cover normalization/unknown cache fields, raw versus normalized cache
writes/reads, reasoning subsets, inherited parallel child callbacks, model
retry failures, intermediate-to-final reconciliation, buffered/nonstreaming
speed, FileSaver reload/deletion, legacy baseline import and absolute event
replay/completion, parallel reverse-order completion, late callback immunity,
third-party checkpointer replacement, partial metadata fallback and corrupt
snapshot rejection. UI checks cover narrow terminal formatting and the existing
Console session browser flow at desktop and mobile widths.
