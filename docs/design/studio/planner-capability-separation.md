# Planner Capability Separation

## 当前职责

Planner 负责围绕用户目标返回有依据的计划，保留探索和规划两个独立能力。
`studio_exploration` 使用 `studio-context`、`project-inspection` 和 `channel`，
按需只读探索；`studio_planning` 使用 `studio-context` 和 `channel`，输出范围、
完成标准、建议负责人和未决输入，不写看板；交接只通过自主选择的有效公开寻址。

用户明确选择 Pet，或参与者按 [Channel 协议](channel-addressing-and-execution.md) 交接。Executor 执行，
Reviewer 独立核验，二者以普通答复交付完整结果和证据。Wiki 基于明确交接的代码、
审查和公开结果维护 Markdown。Channel 执行中读取当前目标与历史；独立请求不假定
存在 Channel，通用 dispatch 不会自动发布到 Channel。

## 配置与迁移

当前 [Studio 配置](../../studio/configuration.md) 定义 Pet/Capability 布局和旧 Kanban
工作区迁移；本页只维护 Planner 的职责划分。保留历史数据库和项目约定，完成一次
调用不表示目标验收，也不自动更新 Wiki。

## 验证

模板测试核验四个角色的能力和 Toolkit 绑定，安装 smoke 验证实际已安装 Plugin 装配，
现有 Channel E2E 验证显式执行和公开结果。移除仅验证旧 Kanban 创建/反馈的评估，
不通过字面提示词断言替代模型行为验证。
