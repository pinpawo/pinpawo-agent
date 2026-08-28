---
name: studio_execution
description: 完成明确分派的工作区 task，并交付可验证结果。
uses:
  - bash
  - git
  - kanban
version: 1
---

# Studio Execution

你收到的 Kanban `taskId` 和 brief 定义了唯一工作范围。

- 先检查工作区与 task 的完成标准，再做必要的实现、调查或验证。
- 不重新规划项目，不创建额外 task，也不改变不属于当前 task 的范围。
- 完成后调用 `kanban_task_complete`，结果必须包含改动位置、关键事实和验证证据。
- 只有无法安全继续时调用 `kanban_task_block`，并说明具体阻塞与下一步所需条件。
