# Studio Independent Host Runtime

> 状态：Draft implementation contract
> 对应：#643，基于 `origin/main@80b6f2ac` 的运行时复核
> 更新：2026-08-26

本文补足“Studio 已提取成独立类”之后仍需成立的运行时边界。它不重新定义
Host / Agent / Capability / Toolkit 领域关系；该关系以
[领域关系设计](../host-agent-capability-toolkit.md)为准。

## 1. 目标边界

```text
Chat Host                         Studio Host process
  Chat/TUI session stack            resident Pet runtime(s)
          \                         /       │
             pinpawo/host-runtime           ├─ local-agent Agent Session WebSocket
             HostCapabilityAssembly         │      (只与内部 Pet 交互)
                                            └─ Studio core + HTTP Plugin
                                                   dispatch/event/hook
```

两个 Host 可作为独立 CLI、systemd unit 或容器启动。共享的是 Capability、Toolkit、
模型和 checkpointer 的**装配方式**，不是 Chat session、transport handler、进程内锁，
也不是同一个 checkpoint writer root。Studio Host process 内可以同时运行两种入口，但
Studio control plane 只有 HTTP；Agent Session WebSocket 属于 local-agent interaction
adapter，不是 Studio transport，也不进入 Studio core。

`host-runtime` 是按 Host 职责划分的中性公共面，不是为了 Studio 建立的 support
facade。local-agent 分开暴露 resident runtime builder 与 Agent Session interaction
builder；两者可以独立使用，也可以在 Studio Host process 内配套构造。interaction
transport 直接复用 `@pinpawo/agent-session` contract，不再为 Studio 定义第二套 Agent
message contract。
Pet graph/runtime 的构造也属于 `host-runtime`。local-agent 分别构造 `ResidentPet` 与
`ResidentPetInteraction`，再由 `ResidentPetHost` 配套持有；Studio 只取得并保存
`PetDispatchPort`，不取得 interaction、不读取 checkpoint，也不构造 LangGraph command。
TUI 通过 local-agent 的 Agent Session adapter 消费 conversation，不连接 Studio
control plane。完整契约见
[Resident Pet Host Ports](../agent-runtime/resident-pet-host-ports.md)。

package 依赖方向固定为：

```text
local-agent (Chat + shared surface)  ←  @pinpawo/studio  ←  concrete Plugins
                                      ↑ resolver 注入
                              application composition root
```

Studio 不 import kanban 或任何具体 Plugin。配置中的 Plugin id 由外部
`StudioPluginResolver` 解析；未安装 resolver 或找不到 Plugin 时 fail fast。Plugin 是
Studio control-plane lifecycle 的扩展单元。Plugin 可定义 Agent Toolkit；Host 将 definitions
与其他来源一起放入统一 inventory，再由 Agent Capability 选择。Plugin lifecycle 只通过
dispatch/event/hook 与 Studio 交互，不参与 Capability 选择或 Pet runtime 装配。详见
[Plugin control-plane boundary](plugin-control-plane-boundary.md)。

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
- 所有配置 Pet 都 eager start；任一 resident Pet 或其配套 interaction adapter 启动失败，
  整个 Host 启动失败并关闭本轮已创建的全部资源。不存在 `lazy`、`disabled` 或兼容回退。
- Pet 启动和关闭不定义顺序；Host 必须等待所有 close settle。
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

### 2.3 Transport、registry 与关联

- Studio core 不构造 Agent Session service 或 conversation handler。Studio Host 的外层
  composition 使用 local-agent interaction builder 为每个 resident Pet 配套构造并启动
  Agent Session WebSocket；该 listener 只与内部 Pet runtime 交互。
- Studio registry 只持有 `PetDispatchPort`。Resident Pet 的 conversation surface 与
  Agent Session adapter 由 local-agent 装配，不进入 Studio package 或 Plugin context。
- Studio control plane 通过 HTTP Plugin 暴露 dispatch、event 与 Plugin hook；目标形态不再
  保留内置 Studio WebSocket/stdio transport。
- `listPets()` 只返回 Host runtime registry 中当前存活的 Pet，并把 Studio 配置中的
  registration metadata 与 runtime liveness 合并；不返回 Capability summary、lazy 或
  disabled 状态。
- 每次已接收 dispatch 的 receipt 提供 invocation-scoped observer，并回放已知最新状态。
- transport 先发 `studio.accepted`，再订阅该 receipt；producer-owned `metadata` 不携带
  route id 或其他 transport 私有状态。
- Plugin event 保持进程内全局总线语义，request transport 不隐式把它归到某个
  peer/delivery。未来的外部 event feed 需要显式 subscription/replay 契约。
- invocation 通过 receipt observer 投射为 `studio.invocation` progress；
  到达 completed/waiting/failed/cancelled 后释放本次 transport route。

### 2.4 HITL

LangGraph 已经把 interrupt、pending continuation 与 thread state 持久化到 checkpoint；
waiting 不是 Chat Host 的进程内状态。Pet adapter 保留 review 能力：

```ts
reviewCapabilities = {
  humanReview: true,
  sessionAuthorization: true,
}
```

需要人工确认的 Toolkit operation 可以产生 checkpointed interrupt；dispatch 只把本次
invocation 收口为 `waiting`，不投射 interrupt identity/payload，也不会删除 checkpoint
state。Dispatch 是发后不管的单向入口，不提供 resume。

pending interrupt 由同一 resident Pet 的 Agent Session conversation 投射与恢复；review、
interrupt 与 session/thread 切换直接复用 `@pinpawo/agent-session` contract。Studio core、
Studio HTTP transport 与 Plugin 都不解释 continuation，不构造 LangGraph resume，也不持有
checkpoint。checkpoint 持久化保证等待状态不依赖 Host 内存；重连后的用户投射由 Agent
Session snapshot 恢复。

## 3. 验收测试

- shutdown 后 queued dispatch 不 invoke；active operation 按 resident lifecycle contract 收口；
  pending interrupt 不阻塞 shutdown。
- plugin partial-start failure 逆序 rollback。
- 同一 checkpoint root 的第二个 Host writer lease 被拒绝；owner 释放或 dead-owner 安全恢复后
  才能启动。两个 `FileSaver` 实例并发 `putWrites` 不丢 sibling writes。
- Studio invocation 通过 receipt observer 精确归属；producer metadata 无 transport 私有字段。
- Studio dispatch contract 不包含 resume；Agent Session conversation 继续负责 typed
  interrupt/review control。
- Studio Pet invocation 保留 human review/session authorization capability，使 interrupt 可落入 checkpoint。
- conversation 切换 active thread 后，尚未开始的 dispatch 在执行时沿用新 thread。
- active operation 非抢占；空闲时 conversation queue 严格优先于 dispatch queue。
- 任一 Pet 启动失败使整个 Host 启动失败；`listPets()` 只返回当前存活 Pet。
- `StudioHost` success/failure init 均按所有权顺序释放资源。

## 4. 尚未纳入

- `ResidentPetHost` 双 port 的代码迁移；当前 `PetAgentRuntime.invoke()` 仍是 dispatch
  port 的过渡实现。
- local-agent resident interaction builder 与 Agent Session WebSocket 的代码迁移。
- durable event log 与断线重放。
- scheduler 与 Plugin discovery；这些仍由 #638/#645 继续设计。
  独立进程入口见
  [standalone process draft](standalone-process.md)。

Kanban 持久化和 dispatch result 投射由可选 Plugin 自己实现，见
[Kanban Plugin durable state](kanban-plugin-durable-state.md)。它不改变上述 Studio
Host 边界。
