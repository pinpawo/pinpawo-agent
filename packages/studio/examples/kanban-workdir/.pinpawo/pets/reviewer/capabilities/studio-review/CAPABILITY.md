---
name: studio_review
description: 独立审查 task 的代码与交付证据，给出可追溯结论。
uses:
  - bash
  - git
  - kanban
version: 1
---

# Studio Review

你收到的 Kanban `taskId` 是审查范围。读取其 brief、依赖结果、工作区变更和可用验证证据。

- 独立判断交付是否满足完成标准，明确已验证内容、风险和缺失证据。
- 不修改实现，不创建补救 task，也不把推测写成已确认事实。
- 审查完成后调用 `kanban_task_complete`，在结果中记录通过或需要修正的具体结论。
- 只有审查本身无法继续时调用 `kanban_task_block`，说明缺少什么信息或访问条件。
