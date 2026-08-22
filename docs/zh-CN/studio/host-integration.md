# Studio 本地宿主集成

[English](../../studio/host-integration.md)

> **状态：当前 local-agent 行为。** 本页描述已实现的本地适配，不替代
> `@pinpawo/studio` 的传输无关 API。

Studio core 契约不依赖文件系统或 transport；`@pinpawo/studio` package 同时拥有
具体的本地 Host adapter 与 Studio wire protocol。local-agent 只提供不理解协议语义的
loopback WebSocket/stdio framing。

```text
<workdir>/.pinpawo/{studio.json,pets/*.json,pets/<petId>/capabilities/*/CAPABILITY.md}
      ↓ resolveStudioHostConfig() + Host Toolkit inventory + buildStudio()
Studio + PetAgentRuntime[] + 已配置插件
      ↓ StudioRequestHandler
studio.dispatch → typed dispatch(petId) → studio.accepted（确认）
                                      ↘ studio.invocation
```

这是与 Chat 相同的 `Host -> Agent Runtime -> Capability -> Toolkit` 领域模型。
Studio 只改变一个 Host 如何配置、常驻并 invoke 多个 Pet runtime，不引入另一套
Toolkit 或 Toolkit Runtime。完整约束见
[领域关系设计](../../design/host-agent-capability-toolkit.md)。

## 装配与生命周期

本地宿主根据 workdir 读取 Studio 与 Pet 配置、解析 Plugin，并先把 Plugin 定义的
Toolkit 送入 Host 的统一 inventory。完成 availability、provenance 与 Toolkit Runtime
初始化后，才构造每个 `PetAgentRuntime` 并装配 Plugin。构造前，Host 会严格加载每个
Pet 的约定目录 `pets/<petId>/capabilities/`；目录成员就是该 Pet 的 Capability 选择，
Plugin 不贡献 Capability。`StudioHost.init()` 在 transport 开始监听前构建并持有 Studio，
请求只 dispatch 到这个常驻实例，不触发装配。Studio 的生命周期由 Host 管理，
不在请求时创建或缓存。

宿主可注入 Studio 自己的 checkpointer。Chat 与 Studio 可作为独立进程启动，因此使用
不同 checkpoint root。每个 Host 启动时会为其 checkpoint root 取得生命周期 writer
lease；已有 Host owner 时直接拒绝启动。`FileSaver` 仍通过 filesystem writer lock
串行化单次 store mutation。
Pet runtime 据此判断 typed request 或 resume 对当前 continuation 是否合法。Studio
自身不读取、也不解释 checkpoint 内容。Pet runtime 保留 human review 能力，因此
LangGraph 可以持久化 interrupt 并返回公开 pending 投射。这个状态不依赖 Chat Host
内存，可以一直等待外部交互层对同一个稳定 Pet thread 提交 resume。

内建 Studio transport 不接收 Chat 的 review/session 消息，但接收 Studio 自己的 typed
`resume_interrupt` dispatch。独立 Studio Plugin 或 Host adapter 可以消费 pending
invocation event、与用户交互，再提交 typed resume。Pet runtime 负责校验 checkpoint
并构造 graph command。

## 协议语义

Studio 自己的 `studio.dispatch` 携带 `petId`、typed request/resume input、不透明
metadata 与可选 idempotency key。接收后立即返回带 `petId`、稳定 `threadId` 和当前
`invocationId` 的 `studio.accepted`；这是**已接收确认**，不是最终答复。历史 Chat
`studio_request` shape 不再接受。

handler 订阅已接收的 receipt，把该 invocation 的 busy 与终态投射为
`studio.invocation`。receipt observer 会回放最新状态，因此即使 progress 与接收确认
并发，也会在 `studio.accepted` 之后投递。

producer metadata 保持原样，不再携带 transport route 状态。Plugin event 继续属于
Studio 独立的进程内事件总线；request transport 不把全局 Plugin event 隐式附着到
某个 delivery。未来若需对外提供 Plugin event feed，需要显式的 subscription/replay
契约。当前 invocation 流仍是进程内 best-effort 通知，pending interrupt 仍以
checkpoint 为权威。

## 关闭

server 关闭时 `StudioHost.shutdown()` 会停止常驻 Studio。Studio 随后拒绝新 dispatch、
取消 active invocation、把 queued invocation 收口为 cancelled，再逆序停止 Plugin 并
清理订阅。durable pending interrupt 不占 active queue slot，也不阻塞 shutdown；插件
启动失败也会逆序回滚已启动前缀。宿主拥有的 Toolkit runtime manager 仍由
宿主负责更大的生命周期。

完整实现约束与可插拔 HITL 控制边界见
[Studio 独立 Host runtime 草案](../../design/studio/independent-host-runtime.md)。

参阅[配置](configuration.md)和[Studio API（中文）](../reference/api/studio.md)。
