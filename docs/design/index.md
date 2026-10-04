# Design Records

These documents record active proposals, implementation choices, and rationale.
They may be draft or implementation-oriented; they do not override the public
contracts in [reference/](../reference/index.md).

## Cross-cutting architecture

- [Host / Agent / Capability / Toolkit domain relationships](host-agent-capability-toolkit.md) —
  accepted ownership and assembly constraints tracked by issue #645

## Agent runtime

- [Root、Supervisor 与 Capability 的状态与交接](agent-runtime/run-scoped-supervisor-session.md) —
  当前状态边界、工具消息交接与恢复设计
- [Capability routing manifest](agent-runtime/capability-routing-manifest.md) —
  draft vocabulary bridge for progressive Capability discovery
- [Review and interrupt semantics](agent-runtime/review.md) — 工具审核策略、执行与恢复
- Capability / Toolkit 的组合规则见[公共契约](../reference/extensions/capability-toolkit.md)。

## Local host and interfaces

- [Host architecture refactor](host/architecture-refactor.md),
  [process runtime](host/process-runtime.md),
  [workspace runtime configuration](host/workspace-runtime-config.md), and
  [app chat UI](host/app-chat-runtime-ui.md)
- [TUI textarea](tui/textarea.md), [timeline](tui/agent-timeline.md), and the
  [OpenTUI capability matrix](tui/v2-capability-matrix.md)
- [Browser Toolkit package](toolkits/browser-package.md)
- [Resident Pet Host ports](agent-runtime/resident-pet-host-ports.md) — canonical
  host boundary for resident runtime, Agent Session interaction, and
  conversation-priority dispatch coordination
- [Studio Independent Host runtime](studio/independent-host-runtime.md) — Studio
  process, dispatch mapping, Plugin boundary, persistence, and lifecycle
- [Pending interrupt in Chat](host/pending-interrupt-chat.md) — draft
  checkpoint/projection/resume boundary for PR #682, explicitly excluding
  Studio dispatch identity

## Studio applications and Plugins

- [Studio Console](studio/console.md) — independent pure frontend for fixed Studio,
  Channel, Scheduler, Notice, Trigger, and Knowledge APIs
- [Studio HTTP Plugin](studio/http-plugin.md) — one HTTP control-plane container
  for dispatch, events, and Plugin routes
- [Studio automation Plugins](studio/automation-plugins.md) — durable Scheduler and
  Trigger domain/API boundaries

## Historical Kanban designs

- [Kanban SQLite task store](kanban/sqlite-task-store.md) — retired design retained for
  historical task, dependency, history, transaction, and recovery context

Completed or superseded work belongs in [history/](../history/index.md).
