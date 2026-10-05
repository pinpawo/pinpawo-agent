# Planner Capability Separation

## 当前职责

Planner 负责围绕用户目标返回有依据的计划，保留探索和规划两个独立能力。
`studio_exploration` 使用 `studio-context`、`project-inspection` 和 `channel`，
按需只读探索；`studio_planning` 使用 `studio-context` 和 `channel`，输出范围、
完成标准、建议负责人和未决输入，不写看板、不自动派发。

用户通过明确 Pet 请求或 Channel 选择 executor、reviewer 或 wiki。Executor 执行，
Reviewer 独立核验，二者以普通答复交付完整结果和证据。Wiki 基于明确交接的代码、
审查和公开结果维护 Markdown。Channel 执行中读取当前目标与历史；独立请求不假定
存在 Channel，通用 dispatch 不会自动发布到 Channel。

## 退役边界

旧 Kanban 规划、开始、反馈与观察 Toolkit，以及 task.assigned 派发和 task.done → Wiki
默认规则已删除。原 `studio_reporting` 只负责写任务状态，随专属消费者删除；
交付现在通过普通公开答复完成。调用结束不表示目标已经验收，不自动更新 Wiki。

通用 Agent / Capability / Toolkit 契约、Studio Pet 名录、dispatch/events、工作区隔离与
Wiki 文档读写保留。旧工作区手动对照模板迁移，历史数据库及文件不变。

## 验证

模板测试核验四个角色的能力和 Toolkit 绑定，安装 smoke 验证实际已安装 Plugin 装配，
现有 Channel E2E 验证显式执行和公开结果。移除仅验证旧 Kanban 创建/反馈的评估，
不通过字面提示词断言替代模型行为验证。
