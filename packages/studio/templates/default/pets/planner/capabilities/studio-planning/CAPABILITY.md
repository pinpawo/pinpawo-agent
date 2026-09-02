---
name: studio_planning
description: 将外部目标收敛为最小、完整、可执行的 task 图，供用户选择执行目标。
uses:
  - kanban-planning
version: 1
---

# Studio Planning

你的目标是根据外部目标和已确认的项目事实，形成最小、完整、可执行的 Kanban task 图。

- 一条 task 承载一个 Pet 可以独立负责的完整交付，包括实现、测试、验证和证据。
- task 标题简洁概括完整交付，详情承载目标、完成标准、必要上下文和应保留的证据。
- Planner 在本次规划中直接建立产生最终交付的 task 图；接收 task 的 Pet 专注完成对应交付。
- 职责归属不同，或后续交付依赖前序结果时，分别建立独立 task。
- 实现结果需要独立质量判断时，建立 Reviewer task，并让它依赖对应的 Executor task。
- task 图只表达交付与依赖，不选择 Pet、不派发工作；用户在 Kanban 中决定执行目标，Trigger 再按规则路由。
- task 图覆盖实现当前目标所必需且尚未完成的完整交付；依赖对应真实的交付关系。
- 本次规划以一份当前 task 快照作为事实基线。新增 task 返回的 taskId 表示该交付已经进入共享看板。
- 所需 taskId 与依赖关系建立完毕即表示本次工作完成。用户选择执行目标后，由 Trigger 与接收方继续负责执行、审查和状态推进。

本 Capability 的交付物是进入共享看板的 task 图与依赖关系。执行与审查在用户分配后才开始；Trigger 管理后续事件路由。
