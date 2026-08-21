# Studio Independent Host Runtime

> 状态：Draft implementation contract
> 对应：#643，基于 `origin/main@80b6f2ac` 的运行时复核
> 更新：2026-08-21

本文补足“Studio 已提取成独立类”之后仍需成立的运行时边界。它不重新定义
Host / Agent / Capability / Toolkit 领域关系；该关系以
[领域关系设计](../host-agent-capability-toolkit.md)为准。

## 1. 目标边界

```text
Chat Host                         Studio Host
  Chat/TUI session stack            resident Studio
  chat checkpoint root              Studio checkpoint root
  chat HITL/control face             gate projection + optional control plugins
          \                         /
             pinpawo/host-runtime
             HostCapabilityAssembly

  local wire adapter (optional for either Host)
             pinpawo/local-server-transport
```

两个 Host 可作为独立 CLI、systemd unit 或容器启动。共享的是 Capability、Toolkit、
模型和 checkpointer 的**装配方式**，不是 Chat session、transport handler、进程内锁，
也不是同一个 checkpoint writer root。

`host-runtime` 是按 Host 职责划分的中性公共面，不是为了 Studio 建立的 support
facade。`local-server-transport` 则明确是 local-agent wire protocol 的一种具体 adapter；
它不冒充 Host runtime，也不属于 transport-independent Studio core。

package 依赖方向固定为：

```text
local-agent (Chat + shared surface)  ←  @pinpawo/studio  ←  optional modules
                                      ↑ resolver 注入
                              application composition root
```

Studio 不 import kanban 或任何具体 module。配置中的 module id 由外部
`StudioModuleResolver` 解析；未安装 resolver 或找不到 module 时 fail fast。module 可同时
贡献 Studio lifecycle/Toolkit face 与配套 Capability，但所有权都留在 module 包；module
不得用同名 Capability 静默覆盖 Host baseline 或其他 module 的贡献。

## 2. 已确定的不变量

### 2.1 生命周期

- `StudioHost.init()` 必须在 transport 监听前完成 Capability 装配与 resident Studio 构建。
- 并发 `init()` 共享同一次初始化；`shutdown()` 与初始化串行，并且开始关闭后 Host
  不得再次初始化。
- resident Studio 构建失败时，Host 必须关闭已经初始化的 Capability/Toolkit runtime。
- 插件按配置顺序启动；任一 `start()` 失败时，包含失败插件在内的已启动前缀必须逆序
  `stop()`。
- `shutdown()` 之后拒绝新 dispatch；已经入队但尚未开始的 dispatch 不得再调用 pet。
- `shutdown()` 取消并等待 active dispatch 退出后，才停止 plugin 与共享 Toolkit runtime；
  checkpointed waiting dispatch 只解除队列等待，不删除其持久化 continuation。
- transport 断开只删除该 peer 的 route，不关闭 resident Studio；Host shutdown 才关闭它。

### 2.2 持久化所有权

- Chat 与 Studio 使用不同的 checkpoint root：
  `checkpoints-capability-v2` 与 `checkpoints-studio-capability-v2`。
- 每个 Host 在 Capability assembly 初始化前取得 checkpoint root 的生命周期 writer lease；
  已有存活 owner 时启动直接失败。dead-owner 恢复由独占 recovery guard 串行，不能让两个
  恢复者同时成为 owner。
- `FileSaver` 的单次 store mutation 使用 filesystem writer lock；锁覆盖 checkpoint 发布、
  pending-write read-modify-write、thread delete 与 GC。
- constructor 不执行删除型 GC，因为同步 constructor 无法等待跨进程锁；GC 只在持锁的
  delete transaction 内运行。
- 独立 root 与 Host lifetime lease 是正常部署的所有权边界；mutation lock 只保证单次事务，
  不允许多个 Host 共同驱动同一 thread。

### 2.3 Transport 与关联

- Studio Host 不构造 `LocalAgentGraphService`、`LocalServerTuiSessionService` 或
  `LocalServerChatHandler`。
- 每次外部 request 创建不可碰撞的内部 route id，并作为 dispatch `correlationId`。
- 只有显式携带该 correlation 的 plugin event 才能投射回对应 peer/request；无 correlation
  的全局事件不能广播给所有连接，也不能归到“该 peer 最近一次请求”。
- dispatch gate 通过 Host control subscription 投射为 `studio.dispatch.gate` progress；
  `open`/`blocked` 后释放 route。

### 2.4 HITL

LangGraph 已经把 interrupt、pending continuation 与 thread state 持久化到 checkpoint；
waiting 不是 Chat Host 的进程内状态，也不要求 Studio core 理解 review。因此 Pet adapter
保留 review 能力：

```ts
reviewCapabilities = {
  humanReview: true,
  sessionAuthorization: true,
}
```

需要人工确认的 Toolkit operation 可以产生 checkpointed interrupt；`invoke()` 返回后 Pet
gate 保持 `waiting`，Studio 队列停在该 dispatch。没有控制插件时它可以一直卡住，这比在
核心层改变 review policy 更符合持久化执行语义。

当前内建 Studio transport 仍不复用 Chat 的 `human_review_response`、session 或 run-control
协议，因为它不拥有 Chat session state。交互能力应由独立 Studio plugin/Host adapter 提供：
它读取 pending action，把事件投射给用户交互层，并用 Host-owned graph/checkpointer 对同一
thread 执行 resume。Studio core 只观察 gate，不新增 review 领域概念。

checkpoint 已兜底保存中断状态，但当前实现尚未在进程重启后自动重建 dispatch route、gate
订阅和用户侧 pending-action 投射；这些属于控制插件的恢复索引与授权边界，不应以关闭
runtime HITL 的方式代替。

## 3. 验收测试

- shutdown 后 active dispatch 收到取消、queued dispatch 不 invoke；waiting dispatch 不阻塞 shutdown。
- plugin partial-start failure 逆序 rollback。
- 同一 checkpoint root 的第二个 Host writer lease 被拒绝；owner 释放或 dead-owner 安全恢复后
  才能启动。两个 `FileSaver` 实例并发 `putWrites` 不丢 sibling writes。
- Studio event 按 correlation 精确归属；无关联事件不跨 peer 广播。
- Studio transport 明确拒绝 Chat/HITL/session control。
- Studio Pet invocation 保留 human review/session authorization capability，使 interrupt 可落入 checkpoint。
- `StudioHost` success/failure init 均按所有权顺序释放资源。

## 4. 尚未纳入

- 独立 Studio HITL/control plugin，以及重启后的 pending-action/dispatch-route 重建。
- durable event log 与断线重放。
- module catalog/discovery、HTTP trigger、scheduler 与 Kanban 持久化；这些仍由 #638/#645 继续设计。
