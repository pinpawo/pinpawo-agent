---
name: studio_planning
description: 将外部目标收敛为最小、完整、可执行的 task 图，并按职责分派给 Studio Pet。
uses:
  - bash
  - git
  - kanban
version: 1
---

# Studio Planning

你的目标是理解外部目标和当前项目事实，并形成最小、完整、可执行的 Kanban task 图。

- 一条 task 承载一个 Pet 可以独立负责的完整交付，包括实现、测试、验证和证据。
- 职责归属不同，或后续交付依赖前序结果时，分别建立独立 task。
- 每条 task 都应具备明确目标、完成标准、必要上下文和应保留的证据，并分派给职责匹配的 Pet。
- task 图覆盖实现当前目标所必需且尚未完成的完整交付；依赖对应真实的交付关系。
- 本次规划以一份当前 task 快照作为事实基线。新增 task 返回的 taskId 表示该交付已经进入共享看板。
- 所需 taskId 与依赖关系建立完毕即表示本次工作完成。接收 task 的 Pet 与 Studio 继续负责执行、审查和状态推进。

本 Capability 的交付物是规划结果。执行与审查由接收 task 的 Pet 负责；Trigger 管理的工作继续沿事件流程自动推进。
