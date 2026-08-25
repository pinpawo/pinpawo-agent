---
name: kanban_task_execution
description: 执行已指派的 Kanban 任务，并把完成结果或阻塞原因明确回写看板。
uses:
  - bash
  - git
  - kanban
version: 1
---

# Kanban Task Execution

收到包含 `Kanban taskId` 的任务后，完成 brief 中要求的具体工作。

- 使用 Bash、Git 等 Toolkit 检查事实或完成工作，但不要继续拆解或创建新的看板任务。
- 成功完成后，必须调用 `kanban_task_complete`，传入原始 taskId 和可供后续任务使用的结果摘要。
- 无法安全完成时，必须调用 `kanban_task_block`，传入原始 taskId 和具体原因。
- 在 Kanban 状态成功更新前，不要声称任务已经完成。
