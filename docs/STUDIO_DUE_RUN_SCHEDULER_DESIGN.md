# Studio Due-Run Scheduler 迭代设计（可落地版）

## 目标

我们已经在 `@pinpawo/pet-agent` 里把 Studio 的 run 识别和状态机做了两层复用：

- 标识：`buildStudioRunIdentity({ runId, conversationId? })`
- 记录与事件：`StudioDueRunRecord` + `applyStudioDueRunEvent`
- 本次新增：`InMemoryStudioDueRunStore`（可直接替换为持久化实现）

本设计文档的目标是把这个基础能力推进到 App/API scheduler 可稳定消费的版本，并把并发、重试、幂等与 workdir 绑定明确化。

## 已有基础（本地版本）

当前仓库新增了：

- `packages/pet-agent/src/agent/studio/dueRunScheduler.ts`
  - `submit(input)`：按 `idempotencyKey` 幂等提交 due run
  - `claim(ownerUserId)`：领取 `pending` 任务，返回 claim token
  - `start/succeed/fail/cancel/retry`：基于 claim token 的状态推进
  - `list/listTrace/getByIdempotencyKey/getByRunId`：查询与可观测输出
  - 可选：`retryDelayMs`（对 failed 任务控制再次可领取时间）
- 单元测试：`dueRunScheduler.test.ts` 覆盖：
  - idempotent 提交
  - `pending -> claimed -> running -> success`
  - `failed -> retry -> pending -> claimed` 的重试链路

## 状态机（与本地约定对齐）

状态：`pending | claimed | running | success | failed | canceled`

允许迁移：

- `pending -> claimed`
- `claimed -> running | canceled`
- `running -> success | failed | canceled`
- `failed -> pending | canceled`

claim token 规则：

- token 由 `idempotencyKey + attempt` 组成；
- 每次成功 claim 会 `attempt + 1`；
- 后续 `start/succeed/fail/cancel/retry` 都必须携带当前 token；
- 这样可以防止并发重放与“拿到旧 token 的过时线程”误操作。

## API/Scheduler 与 local-agent 的衔接

建议由 scheduler 执行以下单次动作（单实例或多实例）：

1. 外部触发 `studio_request` 入库
   - `idempotencyKey = studio:{conversationId}:run:{runId}`
   - 一定要先 upsert（冲突复用，不重复入列）
2. worker 领取时执行 claim
   - 以 status / 更新优先级查询
3. 调用 `StudioRunService`（local-agent）
   - 透传 `runId / conversationId / workdir / ownerUserId`
   - 只传 runtime input，不直接读 `studio.json`
4. 成功回调写 `success`（`finalDispatchId / reply`）
5. 失败回调写 `failed` 并决定是否 retry

## 可持久化实现（下一步）

`InMemoryStudioDueRunStore` 的替代目标：

- 新建 `StudioDueRunStore` 持久化实现（数据库/queue 表）
- 最小字段（至少）：
  - `idempotency_key`（唯一索引）
  - `run_id`
  - `conversation_id`
  - `workdir`
  - `status`
  - `attempt`
  - `owner_user_id`
  - `user_request`
  - `claim_token`（或通过 `(idempotency_key, attempt)` 重建）
  - `error_code / error_detail`
  - `final_dispatch_id / reply`
  - `created_at / updated_at / claimed_at / completed_at`
  - `run_at`（重试调度窗口）
- 领取 SQL 需要行锁/锁跳过语义（`FOR UPDATE SKIP LOCKED`）保证多实例不抢占同一行

## 迭代计划

### v1（本地对齐）

已完成：

- in-memory store + 基础测试落地；
- `@pinpawo/pet-agent` 导出 due-run 的事件、记录、claim store；
- local studio 协议字段已返回 `runId / conversationId / idempotencyKey / workdir`。

验收：

- 本地测试：`node --import tsx/esm --test ...dueRunContract.test.ts ...dueRunScheduler.test.ts`
- `npm run typecheck --workspaces --if-present` 通过。

### v2（持久化调度器）

目标：

- 在 scheduler 服务新增 `studio_due_runs` 表；
- 实现并发安全 claim + 状态更新；
- 支持失败后带延迟重试；
- 指标：claim 延迟、失败率、重试次数、workdir 粒度积压数。

验收：

- 同时启动两个 worker，`pending` 任务只被一个 worker claim；
- 冲突入库不重复排队，只复用既有行；
- 同一 `idempotencyKey` 失败后重试会产生 `attempt` 递增和 `pending` 回退。

### v3（多租户/工作区）

目标：

- `workdir` 成为第一类索引字段；
- 不同 workspace 的 scheduler run 不互相污染；
- 支持“owner 并发配额”和“workdir 临时下线/恢复”策略。

验收：

- 同一时间跨两个 workdir 投递任务时，互不影响；
- 不可用 workdir 的任务标记为失败并暂停该 workdir 后续 run（或转 dead-letter）。

### v4（回放与治理）

目标：

- 将 claim/token、错误码、重试次数在 audit trace 与 /runtime 信息链路打通；
- 给每个 run 保留可回放上下文（`studioRequest`、runtimeConfig、最终事件）；
- 支持手工介入：cancel + 手工重推。

验收：

- 一条 run 能从 `idempotencyKey` 反查到完整执行链；
- cancel 后不再进入 claim 阶段，除非显式手动重置。

## 风险与约束

- claim token 依赖状态一致性；持久化实现必须在更新前再次校验 token（同内存版逻辑）；
- 不能把 scheduler 逻辑放在 `@pinpawo/pet-agent` 的纯 agent 层；
- workdir 未通过 runtimeConfig 透传前，不要在 scheduler 侧直接读用户目录下的 `studio.json`。

## 当前交付（2026-06-19）

- 已把 `StudioDueRunRecord` 与事件流扩展为支持 `runAt`。
- `StudioDueRunStore` 接口补齐持久化能力（`clear`/`restore`）。
- `InMemoryStudioDueRunStore` 支持按 `workdir` 过滤 claim。
- `fail` 支持 `retryAfterMs`，`retry` 按 `runAt` 生效。
- 新增文件持久化实现 `FileStudioDueRunStore`（启动恢复、文件锁、原子更新）。
- 新增对应单测，覆盖重启恢复、跨实例重试窗口。

## 下一次变更建议清单

1. 用 `dueRunScheduler.ts` 补齐持久化接口类型（`StudioDueRunStore`）；
2. 在 App/API 仓库加 `studio_due_runs` claim/retry worker；
3. 在 `studio_response` 里补齐 `runId / conversationId / idempotencyKey / workdir`（local-agent 已有）；
4. 先不引入跨进程共享 workdir 的能力，先保持“单进程单工作区”。
