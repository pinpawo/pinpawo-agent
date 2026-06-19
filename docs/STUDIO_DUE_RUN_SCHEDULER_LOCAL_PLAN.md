# 本地 Studio due-run 调度器迭代计划（可持续交付）

## 1. 目标（当前阶段）

让 `LocalAgent` 在当前单进程服务内，支持：

- workdir 级配置（runtimeConfig）下的 studio 运行。
- studio 任务去重（同一个 `idempotencyKey` 只执行一次）。
- 并发 `studio_request` 的可控行为（等待、取消、过滤）。
- `workdir` 过滤范围内的任务领取与执行。
- 任务 trace 在本地 HTTP 暴露（含 `workdir` 与可观测字段）。

## 2. 已完成（v1）

- `LocalStudioDueRunScheduler` 已接入 `workdir` 过滤（`filterWorkdir`）。
- 调度器提交路径改为异步等待提交者等待并返回运行结果。
- 增加 `LocalStudioDueRunScheduler` 单元测试（3 条）：
  - 同一 `runId/conversationId/workdir` 并发提交只触发一次执行。
  - 不同 `workdir` 的任务被过滤，且不会执行。
  - `stop()` 会拒绝仍在等待的提交。
- 修复关键竞态：`submit()` 需要在启动轮询循环前先注册 waiter，避免行内立即 claim 时拿不到 waiter 导致任务被 `cancel`，从而造成提交挂起。
- `/runtime` 现已返回 `studio_due_runs_path`；
  增加 `/studio_due_runs` 端点返回本地 due-run trace（含 `workdir` 与 `trace` 列表）以便观测。
- `/studio_due_runs` 支持按 `status` 与 `limit` 查询参数做轻量过滤。

## 3. 当前行为约束（已上线）

- 默认仍为单进程、内存 store（`InMemoryStudioDueRunStore`）；
- 调度器仅维护服务内并发，**不跨进程**。
- 单次服务启动的默认串行执行约束由 `claimRunning` + 轮询循环保持，不做强并发执行扩展。

## 4. 下一步（v2，按优先级）

1. **持久化与可观测性**
   - 将 `InMemoryStudioDueRunStore` 与本地配置 store 对齐成可恢复状态（文件化/数据库化）。
   - 暴露 claim 失败、重试、取消、任务耗时指标。
   - 继续完善 trace：按 `status/attempt` 聚合报警阈值、失败归因日志字段。
2. **多 workdir 的服务侧一致性**
    - 明确 `runtimeConfig` 在 scheduler 创建、执行、错误回放中的透传链路。
    - 与 `runtime` 接口统一 `workdir` 字段来源，避免并发时读取源路径漂移。
    - 修复 `workdir` 不在 scheduler scope 时的防悬挂行为：`submit` 阶段进行 scope 校验，不允许进入等待循环。
    - 将服务启动 `run --workdir` 改为显式参数注入 runtimeConfig，不依赖 `PINPAWO_WORKDIR` 全局副作用；
      同时让 `startLocalServer` 在缺省 `runtimeConfig` 时按 `deps.workdir` 构造运行配置，避免 chat/pet/studio 混用默认工作目录。
3. **跨连接并发策略**
   - 明确是否允许同一连接并行提交多个 studio 请求；
   - 若允许，定义队列或合并策略（如 conversation 粒度、priority、老请求是否可中断）。
4. **安全与恢复**
   - `signal` 中止后的 waiter 残留监听清理。
   - 针对 `stop()` 之后的短时间内新提交行为，给出更明确返回策略（`aborted` 或 `already stopped`）。

## 5. 验收标准（每迭代）

- 关键提交场景不再出现 `submit` 永久挂起。
- `runId/idempotencyKey` 去重可验证（并发 >1000 次重复请求仅一次真实执行）。
- `workdir` 过滤无误（外部任务不被执行，不应写入当前 runtime 产物）。
- 至少保留 2 个稳定测试：竞态回归、跨 workdir 过滤、停止行为。
