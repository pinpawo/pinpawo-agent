# Studio Independent Host Runtime

> 状态：Draft implementation contract
> 对应：#643，基于 `origin/main@80b6f2ac` 的运行时复核
> 更新：2026-08-23

本文补足“Studio 已提取成独立类”之后仍需成立的运行时边界。它不重新定义
Host / Agent / Capability / Toolkit 领域关系；该关系以
[领域关系设计](../host-agent-capability-toolkit.md)为准。

## 1. 目标边界

```text
Chat Host                         Studio Host
  Chat/TUI session stack            resident Studio
  chat checkpoint root              Studio checkpoint root
  chat HITL/control face             invocation projection + optional interaction plugins
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
facade。`local-server-transport` 只暴露 protocol-neutral framing、peer 与 loopback
认证原语；Chat 与 Studio 分别拥有自己的 message contract、parser 和 dispatcher。
这些 transport 原语不冒充 Host runtime，也不属于 transport-independent Studio core。

package 依赖方向固定为：

```text
local-agent (Chat + shared surface)  ←  @pinpawo/studio  ←  concrete Plugins
                                      ↑ resolver 注入
                              application composition root
```

Studio 不 import kanban 或任何具体 Plugin。配置中的 Plugin id 由外部
`StudioPluginResolver` 解析；未安装 resolver 或找不到 Plugin 时 fail fast。Plugin 是
Studio lifecycle 的扩展单元，并可定义供 Agent 使用的 Toolkit，但 Plugin 本身不是
Toolkit。Plugin Toolkit 与其他来源一起进入 Host 的统一 inventory，完成 availability、
provenance 与 Runtime 初始化之后，才能构建 resident Pet。

Capability 属于 Agent，与 Studio Plugin 无关。Resolver 不返回 Capability，Plugin 也不
注册 Capability；Studio Host 按 `petId` 推导
`pets/<petId>/capabilities/`，目录中的每个 `CAPABILITY.md` 就是该 Pet 的定义与选择。
不同 Pet 可以拥有同名但不同内容的 Capability，同一 Pet 内重名则 fail fast。

`HostCapabilityAssembly` 的 Toolkit sources 必须在首次 `init()` 一次性提供。已经初始化
或正在初始化时出现新的 source 必须显式失败，不能静默返回旧 inventory 并构造半装配
Studio。每个 Pet 的 Capability 目录也必须在 resident runtime 构建前完成严格加载。

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
  durable interrupt 已经结束当前 invocation，shutdown 不删除其 checkpoint continuation。
- transport 断开只删除该 peer 的 route，不关闭 resident Studio；Host shutdown 才关闭它。

### 2.2 持久化所有权

- Chat 与 Studio 使用不同的 checkpoint root：
  `checkpoints-capability-v2` 与 `checkpoints-studio-capability-v2`。
- 每个 Host 在 Capability assembly 初始化前取得 checkpoint root 的生命周期 writer lease；
  已有存活 owner 时启动直接失败。dead-owner 恢复由独占 recovery guard 串行，不能让两个
  恢复者同时成为 owner。
- Studio Host 必须在解析 Plugin factory 或加载 Capability `entry` 模块前取得 writer lease；
  竞争失败的 Host 不得先执行扩展代码再退出。
- `FileSaver` 的单次 store mutation 使用 filesystem writer lock；锁覆盖 checkpoint 发布、
  pending-write read-modify-write、thread delete 与 GC。
- constructor 不执行删除型 GC，因为同步 constructor 无法等待跨进程锁；Host 取得
  lifetime writer lease 后，在 mutation lock 内执行启动 GC，thread delete 也在同一锁内 GC。
- 独立 root 与 Host lifetime lease 是正常部署的所有权边界；mutation lock 只保证单次事务，
  不允许多个 Host 共同驱动同一 thread。

### 2.3 Transport 与关联

- Studio Host 不构造 `LocalAgentGraphService`、`LocalServerTuiSessionService` 或
  `LocalServerChatHandler`。
- 每次已接收 dispatch 的 receipt 提供 invocation-scoped observer，并回放已知最新状态。
- transport 先发 `studio.accepted`，再订阅该 receipt；producer-owned `metadata` 不携带
  route id 或其他 transport 私有状态。
- Plugin event 保持进程内全局总线语义，request transport 不隐式把它归到某个
  peer/delivery。未来的外部 event feed 需要显式 subscription/replay 契约。
- invocation 通过 receipt observer 投射为 `studio.invocation` progress；
  到达 completed/pending_interrupt/failed/cancelled 后释放本次 transport route。

### 2.4 HITL

LangGraph 已经把 interrupt、pending continuation 与 thread state 持久化到 checkpoint；
waiting 不是 Chat Host 的进程内状态。Pet adapter 保留 review 能力：

```ts
reviewCapabilities = {
  humanReview: true,
  sessionAuthorization: true,
}
```

需要人工确认的 Toolkit operation 可以产生 checkpointed interrupt；这会让当前 invocation
以 `pending_interrupt` 结束并释放 active queue slot，但不会结束或删除 Pet thread。没有交互
Plugin 时 checkpoint 可以一直等待，这比在核心层改变 review policy 更符合持久化执行语义。

Studio transport 不复用 Chat 的 session 或 run-control 协议，因为它不拥有 Chat session
state。它接受 Studio 自己的 typed `resume_interrupt` dispatch。交互能力由独立 Studio
Plugin/Host adapter 提供：它观察公开 `PendingInterrupt` 投射，把事件送给用户交互层，再把
回答作为一次新的 dispatch 送回同一 Pet。Pet runtime 对 checkpoint 校验 interrupt identity、
解析公开回答并构造 LangGraph resume；Studio core 只搬运 typed input/result，不解释选项。

checkpoint 已兜底保存中断状态，稳定 Pet thread 在进程重启后仍能恢复；一次性的 transport
route 不做重建。用户侧 pending-action 索引、授权与断线重放属于交互 Plugin 的持久化边界，
不应以关闭 runtime HITL 的方式代替。

## 3. 验收测试

- shutdown 后 active dispatch 收到取消、queued dispatch 不 invoke；pending interrupt 不阻塞 shutdown。
- plugin partial-start failure 逆序 rollback。
- 同一 checkpoint root 的第二个 Host writer lease 被拒绝；owner 释放或 dead-owner 安全恢复后
  才能启动。两个 `FileSaver` 实例并发 `putWrites` 不丢 sibling writes。
- Studio invocation 通过 receipt observer 精确归属；producer metadata 无 transport 私有字段。
- Studio transport 接受 typed interrupt resume，但明确拒绝 Chat session/run control。
- Studio Pet invocation 保留 human review/session authorization capability，使 interrupt 可落入 checkpoint。
- `StudioHost` success/failure init 均按所有权顺序释放资源。

## 4. 尚未纳入

- 独立 Studio interaction Plugin，以及重启后的 pending-action 索引。
- durable event log 与断线重放。
- HTTP trigger、scheduler 与 Plugin discovery；这些仍由 #638/#645 继续设计。
  独立进程入口见
  [standalone process draft](standalone-process.md)。

Kanban 持久化和 dispatch result 投射由可选 Plugin 自己实现，见
[Kanban Plugin durable state](kanban-plugin-durable-state.md)。它不改变上述 Studio
Host 边界。
