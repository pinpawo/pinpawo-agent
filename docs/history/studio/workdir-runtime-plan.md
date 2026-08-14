# Studio App 调用 & 工作目录作用域：可迭代设计说明

> **状态：历史记录。** 本文针对已经移除的 run、wiki 与 due-run 运行时模型；
> 它不定义当前 Studio 契约。请阅读[当前 Studio 文档](../../studio/index.md)。

## 背景

当前目标是把 studio 能力完整接入 App WebSocket 路径，并确保所有 studio 运行链路都能随启动时传入的 `workdir` 生效。此前主要缺口是：App 侧并未真正消费 `studio_request`，以及部分 studio 配置仍是全局路径。

## 已落地（第 1 阶段）

1. 协议层
   - App 客户端可发送 `studio_request`。
   - 请求参数支持 `runId?`、`conversationId?`。
   - 回包 `studio_response` 回传 `runId`、`conversationId`、`idempotencyKey`、`workdir`。

2. App 运行时接入
   - `LocalAgentAppWsClient` 新增 `onStudioRequest` 分发。
   - `LocalAgentAppChatHandler` 新增 `handleStudioRequest`。
   - 人工审核路由改为先走 studio review，再走 chat review。
   - 连接关闭时清理 studio pending review。

3. local-server 运行配置作用域化
   - `LocalAgentRuntime` 在组装 `LocalServerDeps` 时透传 `runtimeConfig`。
   - `StudioRunService` 使用 `runtimeConfig?.workdir` 组装 `BuildStudioInput`，从而加载当前 workdir 下的 `studio.json`、pets 与 wiki。
   - 普通 `LocalServer` 与 App 路径共享同一套 `LocalServerDeps`，保持一致。
   - 普通 `chat` 运行链路也沿用当前 `workdir`：`LocalAgentAppChatHandler` 通过 `buildLocalChatAgentInput` 注入 `workdir`，并在 tests/contract 中校验。

4. 运行身份与调度契约
   - 在 `@pinpawo/pet-agent` 内新增 `StudioDueRun*` 契约（`StudioDueRunRecord`、状态机、重试策略接口）。
   - 用于后续 API/scheduler 的幂等、并发领取和重试判定。

## 当前交付（2026-06-19）

- `workdir` 体系已经对齐到启动时 runtimeConfig（chat + studio 同步透传）。
- normal chat 与 pet runtime 已经能按启动 `workdir` 读取 prompt、工具和运行参数。
- studio runtime 已使用 `runtimeConfig` 托起 `studio.json` / `pets` / `wiki` 的 workdir 版本。
- 同连接 `studio_request` 已改为串行队列执行（不会并发执行多个 studio turn）。
- due-run 层新增了 `runAt` 与 `workdir` 过滤 claim 的接口语义。
- 新增文件级持久化 store 作为 scheduler 过渡实现（可用于多进程同目录竞争场景）。

## 回答你提到的并发问题

- App 端当前实现是**同连接串行化**：同一 WebSocket 上的后续 `studio_request` 会进入队列，等待前序请求完成后再执行（chat 和 studio 共用控制器，避免并发覆盖同一连接的控制与 review 上下文）。
- 这保证不会有两个 in-flight 请求同时写同一张控制面状态，但不能保证“同一请求多实例并发落盘/重复执行”。
- 真正的并发安全和重复提交控制要在 scheduler 层（API）按 `runId/idempotencyKey` 落库实现。

## 下一步迭代（推荐）

1. 调度表（`studio_due_runs`）接入
   - 字段：`idempotencyKey`、`runId`、`conversationId`、`workdir`、`status`、`attempt`、`owner_user_id`。
   - 状态流：`pending -> claimed -> running -> success/failed/canceled`。
   - 领取采用数据库原子更新（`pending`/`failed` 可 claim）。

2. App/本地入口行为收敛
   - App 发起 studio 请求时优先带上稳定的 `conversationId`（按用户会话）和 `runId`。
   - `runId` 空值时服务端按 requestId 派生，便于兼容旧调用端。

3. 观测与告警
   - 打点：claim 等待时延、run 时长、失败码、重试次数。
   - 失败时输出 `owner_user_id + runId + errorCode` 便于追踪。

4. 连接级边界收敛（下一步）
   - 断开连接时，终止当前 `studio_request`，并显式丢弃未开始的排队请求。
   - 建立测试：断连后不会再有未开始请求继续执行 side effect。

5. 回退策略
   - 本地运行保持兼容：`workdir` 缺失时回退到 buildLocalAgentRuntimeConfig 当前环境行为。
   - `studio` 尚未配置时继续返回当前错误提示，不做隐式静默降级。

## 风险与验证点

- `local-server` 的 WebSocket 测试里有对 `127.0.0.1` 监听权限的环境依赖失败（EPERM），CI/沙箱需允许运行网络监听。
- App 侧 studio review 与 chat review 路由顺序一旦调整需补单测（已补），避免误分发。
- scheduler 表必须与本地/服务端回放一致，否则会出现“回包回到旧 workdir”的错配。
