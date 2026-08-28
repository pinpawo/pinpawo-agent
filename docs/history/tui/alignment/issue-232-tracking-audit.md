# Issue #232 Tracking Audit: timeline, run registry, snapshot reconciliation

> **Purpose.** This is the gap/status audit for the TUI overhaul tracking issue
> [#232](https://github.com/pinpawo/pinpawo-agent/issues/232). It records the
> **current** vs. **target** state of the three named workstreams, the
> data-structure / ownership index, and the remaining rollout steps. It is a
> coordination record, not a design replacement.
>
> **Scope note on terminology.** Issue #232 was filed against the *previous* TUI
> state model (Ink/React reducer with `TuiState.runs[runId]`,
> `SessionModel.activeRunId`, `activeRun`, `runRoute`, `history`,
> `skipTimelineIds`). That model has since been **fully superseded** by the
> client-neutral `AgentSession` projection in the runtime-neutral
> `@pinpawo/agent-session` workspace package. The "run registry" concept the
> issue names no longer exists as a `runs[]` map; it is expressed as a single
> `activeRun` + nullable `pendingInterrupt` per focused session, with
> a single focused `session` in `TuiSessionState`, with session listing/switch
> (`listSessions`/resume) as a transport boundary returning
> `AgentSessionSummary[]`.
>
> The current authority for all three areas is
> [`docs/reference/runtime/session-projection.md`](../../../reference/runtime/session-projection.md).

---

## 1. Gap list (current vs. target)

### 1.1 Timeline (时间线)

| # | Gap | Current | Target | Status |
| --- | --- | --- | --- | --- |
| T1 | Timeline is the single checkpoint message log | `AgentSession.timeline: AgentTimelineEntry[]` is the only ordered message log. No `history`/`transcript`/`transcriptSnapshot`/message-only view remains in code. | `timeline == backend checkpoint messages` | ✅ Done |
| T2 | Timeline carries only user-interaction messages | `AgentTimelineEntry` = `AgentMessageEntry` (`user`/`assistant`/`system`/`subagent`) ∪ `AgentOperationEntry`. Review, notice, error, studio-progress, subagent streaming are **not** timeline entries — they live on `pendingInterrupt`, run state, or TUI-local fields. | Only user/assistant/tool messages in timeline | ✅ Done |
| T3 | Single projection, no dual message model | `@pinpawo/agent-session` exposes `AgentSession`; TUI consumes it via `reduceSession`/`applySessionSnapshot`. No second message log. | Remove history/transcript double model | ✅ Done |
| T4 | Timeline replay derives from checkpoint | Snapshot endpoint materializes checkpoint messages + pending-interrupt into `AgentSessionSnapshot`; `applySessionSnapshot` replaces the ordered timeline. | Snapshot is source of checkpoint messages | ✅ Done |

**Residual gap.** None on the canonical model. The only historical thread is
CORE-6 (PR #240) which was closed-without-merge but superseded by CORE-7
(`codex/tui-core-7-core-closure`), which deleted `history`, `runRoute`, and
`skipTimelineIds`. Confirmed absent from current source: `grep` for `runRoute`,
`activeRunId`, `skipTimelineIds`, `TuiState` returns no matches under
`services/tui` or packages.

### 1.2 Run registry (运行注册表)

| # | Gap | Current | Target | Status |
| --- | --- | --- | --- | --- |
| R1 | Single explicit run ownership | `AgentSession.activeRun: AgentRunView \| null` — a single active invocation per session (`running: thinking/using_tool/streaming` or `interrupting`). | Replace ambiguous `activeRun + runRoute` with explicit ownership | ✅ Done (via `activeRun`) |
| R2 | Pending interrupt is separate, not a run | `AgentSession.pendingInterrupt: PendingInterruptProjection \| null` coexists with a new `activeRun` after response/cancel. | review wait is state, not run/timeline | ✅ Done |
| R3 | Multiple resumable sessions | The `TuiSessionController` holds a single focused `session` in `TuiSessionState`; session switching/listing goes through `listSessions`/resume via `AgentSessionSummary[]` on the protocol boundary. Late/background session events are scoped to their owning session. | Session-keyed state, not a global runs map | ✅ Done |
| R4 | Run lifecycle routed through one reducer | `reduceSession(session, input, { observedAt })` is the deterministic transition for `user.accepted`, `run.started`, `run.interrupting`, `run.finished`, `interrupt.resume.accepted`, `runtime.event`. | Reducer/action ownership single-source | ✅ Done |

**Residual gap.** Conceptually none of the *old* gap remains: the `runs[runId]`
registry shape was replaced by the single-active-run projection. The issue's
wording ("run registry") is now expressed as "active run + pending interrupt +
session-keyed state", documented in `session-projection.md`.

### 1.3 Snapshot reconciliation (快照协调)

| # | Gap | Current | Target | Status |
| --- | --- | --- | --- | --- |
| S1 | One snapshot replace path for all triggers | `reconcileSessionSnapshot(live, snapshot, reason, observedAt)` routes `startup`/`reconnect` → `applySessionSnapshot`, and `completion`/`manual`/`completion-metadata` → dedicated reconciliation. | Snapshot replace is the universal restore path | ✅ Done |
| S2 | Completion snapshots merge live-only details | `completionSnapshot.ts` merges checkpoint messages with live operation/subagent details instead of discarding settled supplementary entries. | Don't lose live-only operation/subagent rows on completion | ✅ Done |
| S3 | Reconnect restores authoritative server output | `sessionTransportCoordinator` + `sessionController` reconnect through snapshot before reconnecting WS; late session snapshots are ignored. | Reconnect = reconciliation trigger, not separate path | ✅ Done |
| S4 | Stale/closed review triggers reconciliation | Review error codes (`review.conflict`/`stale`) trigger snapshot reload. | Review errors reconcile snapshot | ✅ Done |

**Residual gap.** `AgentSessionSnapshot` is version 5; versions 1–2, the
previous `runs[] + activeRunId`, and message-only restore shapes are
**unsupported** (parser rejects them). V3/V4 shapes are normalized into V5 as
inbound compat boundaries. No follow-up required for closure.

---

## 2. Data structure + ownership index

### 2.1 Canonical domain (client-neutral)

| Concern | Type / symbol | File |
| --- | --- | --- |
| Message entry | `AgentMessageEntry` (`user`/`assistant`/`system`/`subagent`, `streaming`/`completed`) | `packages/agent-session/src/domain.ts` |
| Operation entry | `AgentOperationEntry` (`phase`, `operationSource`, `raw`) | `packages/agent-session/src/domain.ts` |
| Timeline entry | `AgentTimelineEntry = AgentMessageEntry \| AgentOperationEntry` | `packages/agent-session/src/domain.ts` |
| Active run | `AgentRunView` (`running: thinking/using_tool/streaming` or `interrupting`) | `packages/agent-session/src/domain.ts` |
| Session | `AgentSession` (`sessionId`, `kind`, `timeline`, `activeRun`, `pendingInterrupt`, `currentPlan`, `runtime`, `tokenUsage`, `sessionTokenUsage`) | `packages/agent-session/src/domain.ts` |
| Pending interrupt | `PendingInterruptProjection` | `packages/agent-session/src/review.ts` |
| Snapshot wrapper | `AgentSessionSnapshot` (`version: 5`, `session`) | `packages/agent-session/src/snapshot.ts` |
| Reducer / transition | `reduceSession(...)` | `packages/agent-session/src/project.ts` |
| Snapshot apply | `applySessionSnapshot(...)` | `packages/agent-session/src/project.ts` |
| Snapshot parser (untrusted input) | `parseAgentSessionSnapshot(...)` | `packages/agent-session/src/parser.ts` |
| Timeline entry id/projection helpers | `agentOperationEntryFromEvent`, `agentOperationEntryId` | `packages/agent-session/src/timeline.ts` |

### 2.2 TUI consumption (`services/tui`)

| Concern | Symbol / file | Role |
| --- | --- | --- |
| Timeline model / display | `services/tui/src/timeline/timelineModel.ts` | `buildTimelineDisplayLines`, `isSettledTimelineEntry`, `formatLiveSession` |
| Timeline scrollback | `services/tui/src/timeline/timelineScrollback.ts` | native scrollback commit, prefix reconciliation cache |
| Snapshot reconcile dispatch | `services/tui/src/session/sessionSnapshot.ts` | `reconcileSessionSnapshot` + `SessionSnapshotReason` |
| Completion snapshot merge | `services/tui/src/session/completionSnapshot.ts` | `reconcileCompletionSnapshot`, `mergeCheckpointMessagesWithLiveDetails` |
| Session controller | `services/tui/src/session/sessionController.ts` | `TuiSessionController`; owns `TuiSessionState` (`connection` + `session`) |
| Session controller types | `services/tui/src/session/sessionControllerTypes.ts` | `TuiSessionState`, command result unions |
| Transport + reconnect | `services/tui/src/session/sessionTransportCoordinator.ts` | WS decode queue, snapshot request, reconnect backoff |
| Session commands (resume/new/compact) | `services/tui/src/session/sessionCommandCoordinator.ts` | `listSessions`, `resume`, `startNew` |
| Status model | `services/tui/src/status/statusModel.ts` | two-line status; connection/run/usage facts |

### 2.3 Server-side snapshot producer (`services/local-agent`)

| Concern | File |
| --- | --- |
| Snapshot endpoint (`/snapshot`, `/sessions/resume`) | `services/local-agent` (session projection producer; not part of this audit's deep-dive) |

**Ownership summary.** Transport/UI no longer owns the domain model. The
`AgentSession` projection is owned by `@pinpawo/agent-session`;
`services/local-agent` produces/serves it; `services/tui` consumes it. Studio
dispatch, `petId`, and backend persistence are outside this Chat projection.

---

## 3. Rollout steps / split recommendation

The blocking chain and parallel tracks from issue #232 are all merged. The only
open thread is the tracking issue's own checklist. Recommended closure steps:

### Step 1 — Confirm CORE-6 is superseded (no code change expected)

- [x] Verify `history`/`transcript`/`transcriptSnapshot`/`skipTimelineIds` are absent (confirmed: no matches).
- [x] Verify `activeRun`/`runRoute`/`TuiState.runs`/`activeRunId` legacy model is absent (confirmed: no matches).
- [x] Verify CORE-7 (`codex/tui-core-7-core-closure`) landed and removed the mirrors (confirmed via `docs/history/tui/alignment/core-7-core-closure.md` and local branch).

### Step 2 — Update the tracking issue checklist

- Update issue #232's checkbox list to mark CORE-1…CORE-7, UI-1…UI-4, CONTRACT-1 done.
- Add a note that CORE-6 (PR #240, closed-without-merge) is subsumed by CORE-7.
- Either close the issue, or (if any genuinely split-off item remains) file a
  small follow-up against the **current** `AgentSession` baseline.

### Step 3 — Residual follow-up candidates (only if a small issue is wanted)

| Candidate | Why | Recommendation |
| --- | --- | --- |
| Richer operation/run timestamps in snapshots | CORE-7 deferred it; checkpoint does not persist operation timestamps | Optional; only if a product need appears |
| Explicit checkpoint-coordinate in snapshot | `session-projection.md` notes implicit coordinate today | Future capability, out of scope for closure |
| `TUI_OVERHAUL_DESIGN.md` / PR #234 | Referenced by the issue but never materialized as such; design evolved into `agent-timeline.md` → `session-projection.md` | No action; the canonical contract is already authoritative |

**Net recommendation.** The overhaul is complete against the current baseline.
No blocking code work remains for the three workstreams. The tracking issue
should be updated and closed, or have its single residual thread (CORE-6/PR #240)
explicitly marked as superseded-by-CORE-7.

---

## 4. Evidence index

| Evidence | Location |
| --- | --- |
| Issue #232 body / blocking chain / PR split | GitHub issue #232 |
| State-audit comment (CORE/UI/CONTRACT merged; CORE-6 closed-unmerged) | issue #232 comment `5043855804` (2026-07-22) |
| Per-track completion records | `docs/history/tui/alignment/core-1…core-7`, `ui-1…ui-4`, `contract-1`, `ui-alignment-closure.md` |
| Current canonical contract | `docs/reference/runtime/session-projection.md` |
| Canonical domain types | `packages/agent-session/src/domain.ts` (v5) |
| Canonical reducer / snapshot apply | `packages/agent-session/src/project.ts` |
| TUI reconcile dispatch | `services/tui/src/session/sessionSnapshot.ts`, `completionSnapshot.ts` |
| TUI timeline display | `services/tui/src/timeline/timelineModel.ts`, `timelineScrollback.ts` |
