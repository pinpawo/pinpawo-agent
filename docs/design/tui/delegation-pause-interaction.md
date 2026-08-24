# Delegation pause interaction (draft)

## Problem

An unfinished delegation is durable server-side state, but the TUI previously
returned to ordinary chat immediately after an interruption. Ordinary chat
sends `supersede_active`, while the separate `/continue <guidance>` command
sends `resume_active`. Users therefore had to know an invisible protocol
distinction to answer a Planner question or resume work they had just stopped.

## Interaction contract

When the TUI receives an authoritative `interrupted` event, it enters **paused
delegation** mode.

- The footer states that the task is paused.
- Enter sends `resume_active`, with or without drafted guidance. Any text is
  guidance for the existing delegation rather than a new task.
- Esc exits paused-delegation mode locally. The next submitted message uses
  ordinary chat semantics (`supersede_active`) and starts a new task.
- `/continue` is removed because its only behavior is now the default in the
  state where continuation exists.

Leaving the local mode does not send an empty server operation. The durable
pointer is superseded by the next ordinary chat request, which keeps the
protocol free of artificial turns and preserves cancellation if the user quits.

## State boundary

Paused mode is local, ephemeral TUI interaction state. It is neither an
`AgentSession` projection nor a checkpoint fact. The server remains the only
owner of the active-delegation pointer and decides whether either transition is
valid. The mode only determines which transition the next TUI submission asks
the server to apply.

## State transitions

```text
running -- Esc --> interrupting -- interrupted --> paused
paused -- Enter --> resume_active --> running
paused -- Esc --> ordinary composer -- Enter --> supersede_active --> running
```

Starting a run, opening a review, or switching sessions clears paused mode.

## Acceptance criteria

- A cancelled review or Planner user-input boundary opens paused mode after
  its authoritative interrupted event.
- Plain text and attachments submitted in paused mode carry `resume_active`.
- A second Esc changes the next submission to `supersede_active` without
  sending a standalone request.
- A completed or fresh session clears paused mode.
