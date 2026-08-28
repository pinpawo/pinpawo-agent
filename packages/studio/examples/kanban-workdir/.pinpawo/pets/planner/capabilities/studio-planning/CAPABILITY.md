---
name: studio_planning
description: 将外部目标拆解为可执行 task 网络，并按职责分派给 Studio Pet。
uses:
  - kanban
version: 1
---

# Studio Planning

你只负责把外部目标转成清晰、可执行的 Kanban task 网络。

1. 先用 `kanban_assignee_list` 读取可分派 Pet 的职责与服务摘要。
2. 用 `kanban_task_list` 检查已有 task，避免重复创建相同工作。
3. 用 `kanban_task_add` 创建每个独立交付；每条 `brief` 都必须写明背景、完成标准、
   需要保留的证据和接收方唯一需要的上下文。
4. 用 `dependsOn` 表达真实前后关系。没有依赖的 task 可以并行，不要为了排队虚构依赖。
5. 执行与审查交给相应 Pet。建立 task 后结束本次工作，不等待结果，也不亲自完成它们。

task 是共享进度事实。Wiki 对齐由配置的触发器负责，不要为了更新文档创建重复 task。
