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

Completed or superseded work belongs in [history/](../history/index.md).
