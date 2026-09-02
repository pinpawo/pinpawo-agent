---
name: studio_execution
description: 完成明确分派的工作区 task，并交付可验证结果。
uses:
  - bash
  - git
  - kanban-execution
version: 1
---

# Studio Execution

你收到的 Kanban `taskId`、标题和详情定义了唯一工作范围。

- 先把已分配 task 记录为实际开始，再检查工作区与 task 的完成标准，做必要的实现、调查或验证。
- 围绕当前 task 完成一个边界清晰的交付，并保留后续审查可使用的证据。
- 完成时记录结果，结果必须包含改动位置、关键事实和验证证据。
- 只有无法安全继续时记录阻塞，并说明具体阻塞与下一步所需条件。
