# Resident Pet Host Ports

> 状态：Accepted，implemented
> 更新：2026-08-27
> 关联：[Studio 独立 Host runtime](../studio/independent-host-runtime.md)、
> [Agent Session projection](../../reference/runtime/session-projection.md)

本文固化 resident Pet 在本地 Host 中的两个访问面，以及 Studio、TUI 与
`local-agent` 之间的所有权边界。它替代“一个 `PetAgentRuntime.invoke()` 同时代表
Pet 的全部外部入口”这一隐含假设。

## 1. 决策

同一个 resident Pet 可以同时被两类调用者使用，但两类调用不是同一个概念：

```text
                         local-agent composition
                                  │
                         ResidentPetHost
                         ┌────────┴─────────┐
                         │                  │
                PetDispatchPort   ResidentPetInteraction
                         │                  │
                      Studio       Agent Session contract
                                               │
                                 local Agent Session WebSocket
                                               │
                                              TUI
```

- `PetDispatchPort` 是工作派发面。Studio 只持有这一面。
- `ResidentPetInteraction` 是人与同一个 Pet 持续对话的 adapter。TUI 通过 local-agent
  已有的 Agent Session projection 与 wire adapter 使用它。
- 两个入口不是平级能力：conversation 在功能上覆盖 dispatch，并额外拥有观察、控制、
  session/thread 切换与中断；调度上 conversation 永远高于 dispatch。
- 两个 surface 共享 Agent Session 当前选择的 thread。Resident Pet 不绑定一条永不变化
  的 thread；conversation 切换 session/thread 后，后续 dispatch 沿用新的 active thread。
- 两个 port 的创建、共享 Agent runtime、线程隔离和整体关闭均由
  `pinpawo/host-runtime`（位于 `services/local-agent`）封装。
- `@pinpawo/studio` 不拥有 conversation registry，不注册 TUI，不依赖
  `@pinpawo/agent-session`，也不向 TUI 暴露 Studio WebSocket。Studio control plane
  只通过 HTTP Plugin 暴露 dispatch、event 与其他 Plugin route。
- Studio Plugin 仍只使用 dispatch、event、hook，并可定义 Toolkit；它不参与
  Pet 的构造、conversation 或 Agent Session。
- 配置中的 Pet 在对应 Host 启动时全部构造成 resident runtime；port contract 不表达
  `lazy` 或 `disabled`。

`ResidentPetHost` 是 local-agent 的装配结果，不是 Studio 的新领域对象。Studio Host
启动时可以调用 local-agent 工厂完成装配，但只能把 `resident.dispatch` 交给 Studio
registry；`interaction` 留在 local-agent 的 Agent Session adapter/registry 中。

## 2. 词汇约束

| 词汇 | 唯一含义 | 不应表示 |
| --- | --- | --- |
| dispatch | 向 Pet 单向交付一次 request | transport delivery、长期会话、continuation resume |
| conversation | 用户与 Pet 的持续交互入口 | Studio dispatch queue、一次模型调用 |
| invocation | 一次已接收 dispatch 所产生的执行实例 | 对外 port、长期 session |
| session | 客户端 projection、恢复与 wire 相关的技术对象 | Pet 的领域入口名称 |
| thread | LangGraph checkpoint 的持久连续性范围 | socket 连接、单次 invocation |
| connection | WebSocket/stdio 等 transport 生命周期 | conversation 或 checkpoint |

因此 dispatch 公共接口不命名为 `AgentSessionPort` 或 `InvocationPort`。interaction
一侧也不另建同构的 `PetConversationPort` contract，而是继续直接使用
`@pinpawo/agent-session` 的 client/server contract；它是客户端 projection/wire
contract，不是 resident Pet 的领域模型。

## 3. 目标 TypeScript 契约

这些类型由 `pinpawo/host-runtime` 导出。Studio 不再复制同构的 runtime 类型。

```ts
export interface ResidentPet {
  readonly dispatch: PetDispatchPort;
  close(): Promise<void>;
}

export interface ResidentPetInteraction {
  connect(peer: AgentSessionPeer): Promise<void> | void;
  handle(peer: AgentSessionPeer, message: AgentClientMessage): Promise<void>;
  disconnect(peer: AgentSessionPeer): Promise<void> | void;
  close(): Promise<void>;
}

export interface AgentSessionPeer {
  isConnected(): boolean;
  send(message: AgentServerMessage): boolean;
}

export interface ResidentPetHost {
  readonly resident: ResidentPet;
  readonly interaction: ResidentPetInteraction;
  close(): Promise<void>;
}

export interface PetDispatchPort {
  getState(): PetDispatchState;
  onStateChange(listener: (state: PetDispatchState) => void): () => void;
  onDispatchLifecycle(listener: (event: PetDispatchLifecycleEvent) => void): () => void;
  dispatch(request: PetDispatchRequest): Promise<void>;
}

export type PetDispatchRequest = {
  request: string;
  /** Caller-owned opaque correlation only; the runtime does not interpret it. */
  dispatchId?: string;
};

export type PetDispatchState = 'open' | 'busy' | 'waiting' | 'blocked';

export type PetDispatchLifecycleEvent = {
  dispatchId: string;
  request: string;
  state: 'queued' | 'running' | 'waiting' | 'completed' | 'interrupted' | 'failed';
  requestId?: string;
  error?: string;
};
```

两个访问面都不提供 `describe()`。Pet identity、Studio registration 和 Agent
Capability inventory 是不同的观察面，不能为了复用当前 descriptor 把它们合成一个
port 返回值。若 Agent Host 需要公开 Capability 编译/诊断信息，应使用独立的 Host
diagnostics surface，而不是让 Studio dispatch 或 TUI conversation 依赖它。

`AgentClientMessage` 已包含 message、review、interrupt、session new/list/resume、model
selection 等 conversation 行为；`AgentServerMessage` 与 `AgentSessionSnapshot` 继续是
唯一 client projection。Resident adapter 不再定义 `PetConversationSnapshot`、自定义
conversation event 或另一套 resume payload。`AgentSessionPeer` 只保留 per-connection
reply/event routing，不定义新 wire message；因此带 `requestId` 的 response 不会被错误
广播给其他 TUI connection。

多 Pet Host 在 **connection 建立阶段**选择 interaction，而不是在
`AgentClientMessage` 中增加 `petId`。local-agent Agent Session listener 使用
`/agent-session/pets/:petId` route 解析并校验 `petId`，从 Host-owned
registry 取得当前存活 Pet 的 `ResidentPetInteraction`，再把该 connection 绑定给它。
connection 建立后不能切换 Pet；未知或未存活的 Pet 在 upgrade/bind 阶段拒绝。后续所有
message 和 server projection 继续原样复用 `@pinpawo/agent-session` contract。这个 route
属于 local-agent transport，不属于 Studio protocol，也不进入 Studio config 或 Plugin
hook。

`ResidentPet` 与 `ResidentPetInteraction` 必须由两个独立 factory 构造，`ResidentPetHost`
只是 Host composition 持有的配套资源句柄；不能要求构造 runtime 时必须先构造 transport。
两个 factory 共享一个 local-agent 私有的 Coordinator/session service 引用，不把该引用
暴露给 Studio。

Thread identity、session registry 与 active thread pointer 沿用 local-agent 现有 Agent
Session service。Host 启动 interaction 时提供中性的 Host/Pet namespace，并在进入 ready
之前复用现有 `ensureActiveTuiSession()` 的语义：恢复持久化的 active session；不存在时
立即创建默认 session，而不是等第一个 TUI 连接。目标 Host service 可以收敛该名称，但
不能假装存在另一套 `ensureActiveSession()` API。`session.new` / `session.resume` 后续更新
同一个 Pet-scoped active pointer。dispatch 不缓存 threadId，而是在真正从队列开始执行时
通过共享 service 读取 active thread；因此排队期间的 conversation thread 切换会自然影响
它。

同样，构造输入只包含 Agent 执行真正需要的 actor、models、Capability、Toolkit、
checkpointer、Agent Session state store、workdir 与 runtime limits。Chat Host 与 Studio
Host 都从 composition root 注入自己的 store/root；公共 builder 不推导 Studio identity
或路径。它不接收 `StudioHostConfig`、`studioConfigPath`、Plugin、Studio registration 或
invocation/receipt 配置。`dispatchId` 只是调用方提供的 opaque correlation，runtime
不把它解释为 Studio identity，也不将它写入 Agent/checkpoint。`dispatch` 在这里是中性的
工作交付动作，不表示 Studio protocol。

## 4. Studio 映射

Studio 对外仍只有 `Studio.dispatch(StudioDispatchRequest)`。Studio registry 保存的是
上层 binding，而不是要求 lower port 携带 Studio registration：

```ts
type StudioPetBinding = {
  dispatch: PetDispatchPort;
  registration: {
    petId: string;
    name: string;
    role?: string | null;
    serviceSummary?: string | null;
  };
};
```

其中 `StudioPetBinding` 与 public registration status 只定义在 `@pinpawo/studio`。
出现在 binding 中的 Pet 已经由 Studio Host 启动并常驻；未配置的 Pet 不进入 registry，
不再用 `lazy/disabled` port 表达“尚未启动”。Studio 自己负责：

1. 由 `petId` 选中当前存活的 target；
2. 创建 `invocationId` 与 admission receipt；
3. 把 `{ request, dispatchId: invocationId }` 交给 `PetDispatchPort.dispatch()`；
4. 将 port 的只读 lifecycle observation 投影为 live Studio event。

`invocationId`、producer `metadata`、idempotency 与 transport delivery identity 不成为
Pet port 的领域语义。Studio 可把自己的 `invocationId` 原样作为 opaque `dispatchId` 传入，
以关联只读 lifecycle event；receipt 仍只证明 resident queue 已接纳本次 dispatch，不是
Agent execution handle，也没有 completion、output、waiting 或 cancellation API。Studio
也不把当前 Agent Session thread 复制成 Studio identity；
dispatch 真正开始时选择哪条 thread 是 resident runtime 内部行为。

旧 `PetAgentRuntime.invoke()` adapter 已移除；所有调用方统一使用上述 dispatch port，
不能据此为 TUI 或 Plugin 增加另一种 Studio message。

## 5. Thread、continuation 与 Coordinator

Resident Pet 使用 Agent Session 当前选择的 thread，而不是每个 Pet 一条不可切换的固定
thread：

- thread registry、active thread pointer、`session.new` 与 `session.resume` 都由
  `@pinpawo/agent-session` 对应的 local-agent service 管理；
- active pointer 是 Host 内 Pet-scoped 状态，不是某个 WebSocket peer 的 UI focus。多个
  Agent Session client 连接同一 Pet 时，共享并观察同一个 active selection；切换操作按
  conversation FIFO 串行；
- conversation 切换 active thread 后，后续 dispatch 沿用这个结果；
- dispatch 在排队和接收时不捕获 threadId；Coordinator 选中该 dispatch、把它从 queued
  变成 active 时，在同一临界区内读取一次 active thread，并把选择固定在该 operation
  内部；
- 已经开始的 graph execution 在它选定的 thread 上完成。排队中的 conversation thread
  切换随后生效，再影响之后的 dispatch；
- Studio invocation 只表示一次单向派发，不成为 thread 或 session identity。

Dispatch 不提供 resume，也不返回 continuation payload。Pet 处于 `waiting` 时，conversation
snapshot 投射 Agent Session 已有的 pending interrupt；用户通过 conversation 的 typed
review/interrupt input 恢复。
普通 conversation 文本是否允许以及如何报错，继续遵循 Agent Session/runtime contract，
Studio、dispatch 与 Plugin 均不解释 continuation，也不构造 checkpoint command。

两个入口共享一个由 `ResidentPetHost` 持有的简单 Coordinator。它不是 workflow engine，
也不拥有重试、历史、Studio invocation 或 transport request：

1. 同一个 resident runtime 同时最多执行一个 graph operation；
2. active operation 是非抢占的：无论来源是 conversation 还是 dispatch，都先自然完成；
3. runtime 空闲时，先取 conversation 队列，再取 dispatch 队列；两个队列内部均为 FIFO；
4. 新到达的 conversation 排在所有尚未开始的 dispatch 之前，但不会取消正在运行的
   dispatch；
5. conversation 连接处于 idle 不算 pending operation，因此不阻塞 dispatch；
6. Agent Session message 是否有效由现有 parser/handler 判断。Coordinator 不先定义一种
   “有效 conversation”来降低其优先级；被接收的 conversation operation 始终先于 dispatch；
7. 严格优先级允许持续 conversation 使 dispatch 饥饿，这是本阶段明确接受的语义。

Dispatch gate 是这个协调过程的原子状态，不是供上层“先读后写”的并发锁：

- `open`：没有 active operation，也没有 checkpoint wait 阻止普通 dispatch；
- `busy`：已有 operation 在运行，新的 dispatch 继续排队；
- `waiting` / `blocked`：普通 dispatch 保持排队，只有 Agent Session conversation 可以通过
  它已有的 control input 消化 pending state；
- `getState()` 与 `onStateChange()` 只用于观察。是否开始下一项由 Coordinator 在同一个
  临界区内决定。

dispatch 调用方不持有 Agent execution。Promise resolve 只表示 request 已进入 resident queue；
调用方可以观察 gate，以及同一 dispatch 的只读 `queued`/`running`/terminal lifecycle，
但不会得到 output、continuation payload 或 cancellation API。执行期错误仍由 resident
runtime 投射成 Agent Session runtime event；Studio 仅将相同 dispatch 的失败事实作为
live observation 转发，不把它重新包装成 invocation result。

resident runtime 内部的所有 Agent turn 统一经过 local-agent Agent Session turn runner。
无论输入来自 conversation peer 还是 Host 持有的单向 dispatch，runner 都产生相同的
message/tool/plan/review runtime event。已连接同一 Pet interaction 的 Agent Session peer
是当前 session 的观察者：idle 连接不阻塞 dispatch，但会从 `run.started` 开始实时投射
之后发生的 turn。运行中才接入的 peer 不要求事件重放，但 startup snapshot 必须包含 resident
当前 `activeRun`，使后续实时事件仍能投射到同一个 run；snapshot 读取不排在 active dispatch
后面。没有 peer 时 Agent Session event 可以丢弃；checkpoint 仍是持久权威。与之分离的
`PetDispatchPort.onDispatchLifecycle()` 是没有模型内容的 invocation observation，可由
Studio 转发到 Plugin event bus，供 Console 显示 queued/running/failed。Console 只能为自己
直接经 HTTP 发起的失败输入提供重试入口；Plugin-owned dispatch 必须由来源 Plugin 的领域
control/history 处理。它不替代 Agent Session stream，也不提供执行控制。

## 6. 生命周期与所有权

local-agent 必须把 resident runtime 构造与 interaction adapter 构造拆成两个可组合步骤。
普通 Chat Host 可以只选用它需要的组合；Studio Host composition 则为每个配置 Pet 同时：

1. 完成模型、Capability、Toolkit、Toolkit Runtime 与 checkpointer 装配；
2. 创建并持有 resident runtime/Coordinator；
3. 基于同一个 resident runtime 创建 Agent Session interaction adapter；
4. 只把 `PetDispatchPort` 注册给 Studio core；
5. 由 local-agent 启动独立的 Agent Session WebSocket listener，供 TUI 与内部 Pet 交互；
6. 由 Studio HTTP Plugin 启动 control-plane HTTP route，承载 dispatch、event 与 Plugin hook。

第 5 步的 WebSocket 可以与 Studio Host 运行在同一进程，但它不是 Studio protocol，也不经过
Studio core。Studio 对外没有另一个内置 WebSocket/stdio conversation transport。

所有配置 Pet 都 eager start。Host 只有在全部 resident runtime 与配套 interaction adapter
启动成功后才进入 ready；任意一个失败都使整个 Host 启动失败，并关闭本轮已经创建的全部
资源。启动和关闭不定义 Pet 顺序，也没有 `lazy`、`disabled` 或兼容回退语义。

创建 Resident Pet 的 Host 是其唯一 lifecycle owner。Studio Host 可以持有完整
`ResidentPetHost` 资源句柄，但 Studio core 只借用 dispatch port；conversation 的装配仍
封装在 local-agent adapter 中，Studio core 不解释它。关闭时 owner 先停止接受新请求，
再关闭全部 `ResidentPetHost`；不同 Pet 之间不要求顺序，但必须等待全部 close settle。单个
Pet 内部 interaction/runtime 如何释放由 `ResidentPetHost.close()` 封装，不成为外层 Host
contract。任一 consumer 都不能自行关闭底层 runtime。

`Studio.listPets()` 返回当前存活的 resident Pet。配置只定义期望 Pet 及其 registration
metadata；Host-owned runtime registry 提供实际存活情况。初次 ready 时，由于启动是
all-or-nothing，列表应与本次成功配置一致；运行期间已经退出的 Pet 不再作为可 dispatch
target 返回。Capability inventory 不进入该列表。

## 7. Package 边界

| Package/surface | 可以知道 | 不可以知道 |
| --- | --- | --- |
| `pinpawo/host-runtime` | resident Pet、两个访问面、Coordinator、graph/checkpoint/toolkit 装配 | Studio registration metadata、Studio Plugin、TUI view、具体 wire route |
| `@pinpawo/studio` | `PetDispatchPort`、Pet registry、dispatch admission、Plugin event | conversation、Agent Session、Chat/TUI message |
| `services/local-agent` Agent Session adapter | resident interaction 构造、`@pinpawo/agent-session` contract 与 WebSocket listener | Studio dispatch/invocation、Plugin hook |
| TUI | Agent Session wire/projection | Studio protocol、Pet graph/checkpoint |
| Studio Plugin | Studio dispatch/event/hook、可定义 Toolkit | Pet construction、conversation、Agent Session |

## 8. 已完成迁移与验收

以下顺序已经落地；它同时保留为后续变更不得回退的验收清单：

1. 在 `pinpawo/host-runtime` 定义上述共享类型，消除 Studio 与 local-agent 的重复类型。
2. 把 resident runtime/Coordinator 构造与 Agent Session interaction 构造收进公共
   host-runtime/local-agent surface，并保持两者可独立组合；不再由 Studio 构造固定 Pet
   thread identity。
3. Studio 构造改为注入 `PetDispatchPort`，不再读取 `threadId`、构造 Pet graph/runtime
   或解析 checkpoint identity。
4. 从两个访问面移除 `descriptor()`；Studio registration 留在 Studio binding，
   Capability inventory/diagnostics 留在 Agent Host diagnostics，并移除 resident Pet
   的 `lazy/disabled` runtime binding。
5. 从通用 `LocalAgentRuntimeConfig`、diagnostics 与 local HTTP projection 移出
   `studioConfigPath`；Studio Host 自己从 workdir 解析其配置位置。
6. 在 `ResidentPetHost` 中收敛一个共享的非抢占 Coordinator；conversation 队列严格优先
   于 dispatch 队列，移除各入口对 graph 互斥的独立所有权。
7. local-agent 提供可独立构造的 Agent Session interaction adapter 与 Pet-scoped WebSocket
   route；Studio Host composition 将它与 resident runtime 配套启动，但 Studio core
   不可见。route 在 connection 建立时选择 Pet，不修改 Agent Session message schema。
8. 把历史 `studio:<studioId>:pet:<petId>` fixed checkpoint namespace 显式迁移到 Host/Pet
   Agent Session registry；迁移必须保留可恢复的 active session、thread 和 pending
   interrupt，不能仅切换 thread-id builder 后留下孤儿 checkpoint。
9. 用至少两个 Pet 验证 route 隔离、snapshot、typed review/interrupt resume 和重连恢复。
   该验收通过后才删除了旧 dispatch continuation/resume adapter。
10. 第 9 步通过后，移除 dispatch resume 与 Studio receipt/event 中的稳定 `threadId`；
    pending continuation 只通过 Agent Session conversation 恢复。
11. Studio control plane 收敛到 HTTP Plugin；内置 Studio WebSocket/stdio 作为过渡实现移除。
12. 配置 schema 删除 `lazy/disabled`；所有 Pet eager start，任一失败使 Host 全部失败；
    `listPets()` 只返回 Host runtime registry 中当前存活的 Pet。
13. 完成消费者迁移后移除 `PetAgentRuntime.invoke()` 过渡类型。
14. 从 `PetDispatchPort` 与 Studio receipt 移除 execution result、completion observer 与
    caller cancellation；Studio 只负责接纳，resident Coordinator 持有队列和 gate。Port 仅
    允许暴露不含模型内容的 dispatch lifecycle observation，Studio 可转发它供 Console 显示
    状态；Console 只可重试自己直接经 HTTP 发起的输入，完整执行观察仍走 Agent Session event。

现有测试与 package 边界必须持续证明：

- Studio package 无 Agent Session、TUI 或 conversation import；
- TUI 无 Studio message、Studio WebSocket 或 `composerTarget = studio`；
- `pinpawo/host-runtime` 的 public types 无 `Studio*`、Plugin、receipt、invocation、
  idempotency、producer metadata、`studioConfigPath`、Studio registration 或
  Capability summary 字段；
- 一个 Resident Pet 只装配一次底层 runtime，两个 surface 共享其静态 Agent 配置；
- 多 Pet Agent Session listener 在 connection 阶段选择唯一 Pet；wire message 不增加
  `petId`，未知 Pet 不会连接到默认 interaction；
- conversation 切换 Agent Session active thread 后，尚未开始的 dispatch 使用新 thread；
- 同一个 resident runtime 不发生并发 graph operation；
- active operation 不被抢占；空闲选项始终先取 conversation，再取 dispatch；idle
  conversation connection 不阻塞 dispatch；
- dispatch contract 不包含 resume，Studio receipt/event 不暴露固定 Pet `threadId`；
- 删除 dispatch resume 前，Pet-scoped Agent Session route 已通过 waiting checkpoint 的
  snapshot、typed resume 与重连 E2E；
- dispatch 调用方不拥有执行 handle 或最终结果；它只获得接纳确认并可观察 gate；
- conversation 与 Host 单向输入共用 Agent Session turn runner；已连接同一 Pet 的 peer
  能观察任一来源后续产生的 run/message/tool/plan/review event；
- 运行中接入的 peer 从 startup snapshot 取得当前 `activeRun` 并继续投射后续 event；不要求
  Studio 保存或重放 Agent event；
- Studio Host 任一 Pet 启动失败时整体失败；`listPets()` 只包含当前存活 Pet；
- Studio control plane 只有 HTTP，Agent Session WebSocket 属于同进程 local-agent
  interaction adapter 而非 Studio protocol；
- 任一 surface 的连接断开不关闭 resident Pet，Host shutdown 只关闭一次；
- Plugin 不通过 Toolkit、hook 或 event 获得 Pet runtime/conversation 引用。

## 9. 非目标

- 不把 TUI 变成 Studio client；
- 不为 Studio core 增加 WebSocket 或 Agent Session 协议；HTTP 由 Studio HTTP Plugin 提供；
- 不把普通 conversation message 自动解释为 waiting continuation 的回答；
- 不为 `@pinpawo/agent-session` wire contract 增加 Studio、invocation 或 Plugin 概念；
- 不把 `ResidentPetHost` 放进 `packages/pet-agent`：它是本地 Host 装配，而不是
  runtime-independent Agent 领域能力。
