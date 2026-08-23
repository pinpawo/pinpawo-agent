# Design Records

These documents record active proposals, implementation choices, and rationale.
They may be draft or implementation-oriented; they do not override the public
contracts in [reference/](../reference/index.md).

## Cross-cutting architecture

- [Host / Agent / Capability / Toolkit domain relationships](host-agent-capability-toolkit.md) —
  accepted ownership and assembly constraints tracked by issue #645

## Agent runtime

- [Agent requirements](agent-runtime/agent-requirements.md)
- [Persistent Planner](agent-runtime/persistent-planner.md),
  [orchestrator routing](agent-runtime/orchestrator-routing.md), and
  [terminal semantics](agent-runtime/terminal-semantics.md)
- [Planner non-commit routing](agent-runtime/planner-incomplete-routing.md)
- [Dynamic context governance](agent-runtime/dynamic-context-governance.md),
  [human review](agent-runtime/human-review.md), and
  [subagent limits](agent-runtime/subagent-limits.md)
- [Capability / Toolkit composition](agent-runtime/toolkit-composition.md),
  [Toolkit HITL policy](agent-runtime/toolkit-hitl-policy.md), and
  [decision-prompt prefix](agent-runtime/decision-prompt-prefix.md)

## Local host and interfaces

- [Local-agent architecture refactor](local-agent/architecture-refactor.md),
  [process runtime](local-agent/process-runtime.md),
  [workspace runtime configuration](local-agent/workspace-runtime-config.md), and
  [app chat UI](local-agent/app-chat-runtime-ui.md)
- [TUI architecture](tui/local-agent-tui.md), [overhaul](tui/overhaul.md),
  [textarea](tui/textarea.md), [timeline](tui/agent-timeline.md), and the
  [OpenTUI capability matrix](tui/v2-capability-matrix.md)
- [Browser Toolkit package](toolkits/browser-package.md)
- [App Studio agents requirements](studio/app-agents-requirements.md)
- [Pending interrupt in Chat](local-agent/pending-interrupt-chat.md) — draft
  checkpoint/projection/resume boundary for PR #682, explicitly excluding
  Studio dispatch identity
- [Studio Pet thread and dispatch invocation](studio/pet-thread-dispatch-invocation.md) —
  draft identity/lifecycle model for one durable thread per Pet, one invocation
  per dispatch, and interrupt resumes delivered through dispatch

## Kanban

- [Kanban SQLite task store](kanban/sqlite-task-store.md) — independent Kanban
  task, dependency, history, transaction, and recovery design
- [Kanban Console UI](kanban/ui-console.md) — mouse-first desktop console for
  dispatch, tasks, events, authorization, and Markdown context
- [Studio Kanban Plugin adapter](studio/kanban-plugin-durable-state.md) — optional
  dispatch/event/Toolkit/hook integration without Studio data ownership
- [Studio CLI Plugin Web Composition](studio/cli-plugin-web-composition.md) — generic
  CLI loading plus one HTTP container for Plugin-contributed APIs and UI assets

Completed or superseded work belongs in [history/](../history/index.md).
