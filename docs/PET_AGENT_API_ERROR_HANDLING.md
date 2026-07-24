# 错误与观察性

## 1. 错误分类

### 1.1 Runtime 级

1. `Pet agent "<petId>" is not dispatchable: <status>`
   - 原因：实例不是可调度状态（如 disabled）
2. `Pet agent "<petId>" hit HITL interrupt but no humanReviewer configured`
   - 原因：执行期间触发审批中断，但未注入 `humanReviewer`
3. `planner 未提交 plan`
   - 见 orchestrator：显式 `plan` 未提供且 planner 未输出结构化 plan 时 turn 停止

### 1.2 Studio 编排级

1. `agent_not_found`
2. `agent_not_dispatchable`
3. `task retries exceeded`
4. `maxIterationCount reached`（内部约束转为 stop）

### 1.3 插件级

1. `Capability plugin invalid`
2. `missing CAPABILITY.md`
3. frontmatter / 空正文 / entry 路径或导出不合法
4. required Toolkit 缺失，Capability 在 registry generation 中 unavailable

## 2. 观测建议

1. 工具行为观测：消费 root `streamEvents(v3)`，经 adapter 归一化为工具生命周期 / `operation` 日志。
2. 编排状态观测：消费 `onTurnEvent`（turn_started/tasks_queued/task_started/task_finished/turn_finished 等）。
3. 能力行为观测：记录 instruction digest、`subagent_prompt_sections` metadata
   与 `capabilityArtifacts`；结构化业务写入由 Toolkit tool contract 校验。
4. 中断排障：记录 `reviewId`、`selectedOptionId`、`pendingAction`。

## 3. 回复风格建议

1. API 错误应返回原始错误消息 + 统一建议操作（如“请配置 humanReviewer”）。
2. 对用户可见异常应区分：可重试（retryable）/ 用户输入不足（user action required）/ 平台配置错误（non-retry）。

## 4. 与 Artifact 相关

本版接口返回仍以 `reply` 为主；能力产物的持久引用与读取方式参考
`PET_AGENT_CAPABILITY_ARTIFACT_STORE_DESIGN.md`（设计文档）。
