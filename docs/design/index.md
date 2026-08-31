# Design Records

These documents record active proposals, implementation choices, and rationale.
They may be draft or implementation-oriented; they do not override the public
contracts in [reference/](../reference/index.md).

## Cross-cutting architecture

- [Host / Agent / Capability / Toolkit domain relationships](host-agent-capability-toolkit.md) —
  accepted ownership and assembly constraints tracked by issue #645

## Agent runtime

- [Run-scoped Supervisor session](agent-runtime/run-scoped-supervisor-session.md) and
  [terminal response finalization](agent-runtime/terminal-response.md)
- [Entry Answer routing](agent-runtime/entry-answer-routing.md) and
  [Delegation Announce messages](agent-runtime/delegation-announce-message.md)
- [Capability / Toolkit composition](agent-runtime/toolkit-composition.md) and
  [Toolkit HITL policy](agent-runtime/toolkit-hitl-policy.md)

## Local host and interfaces

- [Local-agent architecture refactor](local-agent/architecture-refactor.md),
  [process runtime](local-agent/process-runtime.md),
  [workspace runtime configuration](local-agent/workspace-runtime-config.md), and
  [app chat UI](local-agent/app-chat-runtime-ui.md)
- [TUI textarea](tui/textarea.md), [timeline](tui/agent-timeline.md), and the
  [OpenTUI capability matrix](tui/v2-capability-matrix.md)
- [Browser Toolkit package](toolkits/browser-package.md)
- [Resident Pet Host ports](agent-runtime/resident-pet-host-ports.md) — canonical
  local-agent boundary for resident runtime, Agent Session interaction, and
  conversation-priority dispatch coordination
- [Studio Independent Host runtime](studio/independent-host-runtime.md) — Studio
  process, dispatch mapping, Plugin boundary, persistence, and lifecycle
- [Pending interrupt in Chat](local-agent/pending-interrupt-chat.md) — draft
  checkpoint/projection/resume boundary for PR #682, explicitly excluding
  Studio dispatch identity

## Studio applications and Plugins

- [Studio Console](studio/console.md) — independent pure frontend for fixed Studio,
  Kanban, Scheduler, and Trigger APIs
- [Studio HTTP Plugin](studio/http-plugin.md) — one HTTP control-plane container
  for dispatch, events, and Plugin routes
- [Studio automation Plugins](studio/automation-plugins.md) — durable Scheduler and
  Trigger domain/API boundaries

## Kanban

- [Kanban SQLite task store](kanban/sqlite-task-store.md) — independent Kanban
  task, dependency, history, transaction, and recovery design

Completed or superseded work belongs in [history/](../history/index.md).
