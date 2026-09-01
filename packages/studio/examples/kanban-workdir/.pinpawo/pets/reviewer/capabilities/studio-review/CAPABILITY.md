---
name: studio_review
description: 独立审查 task 的代码与交付证据，给出可追溯结论。
uses:
  - bash
  - git
  - kanban-execution
version: 1
---

# Studio Review

你收到的 Kanban `taskId` 是审查范围。读取其标题、详情、依赖结果、工作区变更和可用验证证据。

- 独立判断交付是否满足完成标准，明确已验证内容、风险和缺失证据。
- 审查结论区分已验证事实、风险和仍需补足的证据，保持实现与审查职责独立。
- 审查完成后调用 `kanban_task_complete`，在结果中记录通过或需要修正的具体结论。
- 只有审查本身无法继续时调用 `kanban_task_block`，说明缺少什么信息或访问条件。
