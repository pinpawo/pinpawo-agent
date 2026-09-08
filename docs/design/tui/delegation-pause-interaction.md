# Delegation pause interaction (draft)

Updated integration, 2026-09-08: explicit pauses retain their interrupt
behavior. Ordinary Supervisor questions use normal replies and existing work
continuation, following the [Supervisor–Root Interaction Protocol](../agent-runtime/delegation-boundary-protocol.md#supervisor-asks-the-user-directly).
Ordinary text replies now use `resume_active` when the projected current plan has
unfinished work; Esc explicitly selects a new task. Empty Enter remains reserved
for an explicit pause.

## Problem

An unfinished delegation is durable server-side state, but the TUI previously
returned to ordinary chat immediately after an interruption. Ordinary chat
sends `supersede_active`, while the separate `/continue <guidance>` command
sends `resume_active`. Users therefore had to know an invisible protocol
distinction to answer a Supervisor question or resume work they had just stopped.

A Supervisor question can also end a run normally while preserving unfinished
work. That path has no `interrupted` event, so interrupt-only UI behavior cannot
be the sole way to expose continuation.

## Interaction contract

When Agent Session projects an authoritative `pendingInterrupt` with payload
kind `pause_task`, the TUI enters **paused delegation** mode. A generic
`run.interrupted` event alone does not establish a task pause.

- The footer states that the task is paused.
- Enter sends `resume_active`, with or without drafted guidance. Any text is
  guidance for the existing delegation rather than a new task.
- Esc exits paused-delegation mode locally. The next submitted message uses
  ordinary chat semantics (`supersede_active`) and starts a new task.
- `/continue` is removed because its only behavior is now the default in the
  state where continuation exists. Removal depends on the visible continuation
  entry also covering normal replies with saved work, not just interrupts.

Leaving the local mode does not send an empty server operation. The durable
pointer is superseded by the next ordinary chat request, which keeps the
protocol free of artificial turns and preserves cancellation if the user quits.

For normal Supervisor replies with unfinished work, expose a visible continuation
entry using the same `resume_active` operation. The node supplies the question
directly; the UI displays it and routes the answer to the original goal and saved
work. This is continuation after a completed run, not a `PauseTaskInterrupt`.
Use authoritative saved-work availability, not a classifier over question prose,
to offer continuation. The user can explicitly choose new-task behavior instead.

The continuation entry must cover both an active delegation and a remaining plan
without an active delegation. It must not silently submit an answer as
`supersede_active`. Supplying information continues the agreed plan; only user
agreement authorizes the Supervisor to revise that plan. No new wait object,
approval tool, or parallel continuation state machine is introduced.

When Supervisor asks before any plan or delegation exists, submit the answer as
ordinary conversation through `entryAnswer`, which resolves the goal using main
history. There is no execution snapshot to resume. With an active delegation,
append the answer or requested adjustment to main and invoke Supervisor before
further execution, preserving the delegation and its evidence. Input arrival
must not accept, end, or replace it. Use existing task and continuation facts to
select the entry, not a classifier over the question's wording.

## State boundary

Paused mode is local, ephemeral TUI interaction state. It is neither an
`AgentSession` projection nor a checkpoint fact. The server remains the only
owner of the active-delegation pointer and decides whether either transition is
valid. The mode only determines which transition the next TUI submission asks
the server to apply.

Normal-reply continuation likewise relies on Runtime-owned saved work; it must
not infer an interrupt solely from a retained delegation or plan. Exposing that
availability uses unfinished items in the existing `currentPlan` projection;
the composer remains ordinary instead of displaying a synthetic pause.

## State transitions

```text
review resolution stops task -- pause_task projection --> paused
paused -- Enter --> resume_active --> running
paused -- Esc --> ordinary composer -- Enter --> supersede_active --> running
normal reply + saved work -- answer through continuation --> resume_active --> running
```

Starting a run, opening a review, or switching sessions clears paused mode.

## Acceptance criteria

- A cancelled review or explicit pause opens paused mode only when the server
  projects `pause_task`.
- A normal Supervisor question with saved work exposes continuation without an
  interrupted event; its answer retains the original goal and remaining plan.
- A saved remaining plan without an active delegation also supports continuation.
- An answer before plan creation follows ordinary `entryAnswer`; an answer for an
  active delegation reaches Supervisor with that delegation and its messages
  retained, before any execution or plan-adjustment effect. Explicit pause
  continuation instead re-enters the pending delegation directly.
- Plain text and attachments submitted in paused mode carry `resume_active`.
- A second Esc changes the next submission to `supersede_active` without
  sending a standalone request.
- A run ending normally clears paused mode; saved unfinished work still exposes
  continuation. A session without saved work offers ordinary new-task input.
