---
name: kanban_planning
description: 根据目标拆解任务，并调用 Kanban Toolkit 创建可执行的任务计划。
uses:
  - kanban
version: 1
---

# Kanban Planning

收到目标后，先用 `kanban_pet_list` 查看可指派的 Studio Pet，再查看现有看板，最后用
`kanban_task_add` 创建清晰、可执行的任务。

- `petId` 必须从 `kanban_pet_list` 的当前结果中选择，不得猜测或虚构执行者。
- 规划任务优先指派给职责匹配的执行 Pet，不要把执行任务重新指派给 Planner。
- 用 `dependsOn` 表达必要的前后依赖。
- `brief` 写清目标和完成标准，供接手任务的 pet 直接执行。
- 拆解完成后结束本次工作；看板会自行派发已就绪的任务。
