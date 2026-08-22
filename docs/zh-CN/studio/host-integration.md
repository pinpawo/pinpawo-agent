# Studio 本地宿主集成

[English](../../studio/host-integration.md)

> **状态：当前 local-agent 行为。** 本页描述已实现的本地适配，不替代
> `@pinpawo/studio` 的传输无关 API。

Studio core 契约不依赖文件系统或 transport；`@pinpawo/studio` package 同时导出
具体的本地 Host adapter，文件读取和 runtime 构造属于该 adapter，wire transport
由 local-agent 的可选 adapter 提供。

```text
<workdir>/.pinpawo/{studio.json,pets/*.json,pets/<petId>/capabilities/*/CAPABILITY.md}
      ↓ resolveStudioHostConfig() + Host Toolkit inventory + buildStudio()
Studio + PetAgentRuntime[] + 已配置插件
      ↓ StudioRequestHandler
studio_request → dispatch(entryPetId) → studio_response（确认）
                                      ↘ studio.progress（插件事件）
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
Pet runtime 据此判断一次 `invoke()` 是否仍有待继续
的执行，从而报告 `open`、`waiting` 或 `blocked` gate。Studio 自身不读取、也不解释
checkpoint。Pet runtime 保留 human review 能力，因此 LangGraph 可以持久化 interrupt，
并让 gate 停在 `waiting`。这个状态不依赖 Chat Host 的内存，可以一直等待外部控制面恢复
同一个 thread。

内建 Studio transport 不接收 Chat 的 review/session 消息。独立 Studio plugin 或 Host
adapter 可以读取 pending action、向用户交互层发 event，再通过 Host-owned graph 与
checkpointer 恢复同一 thread；该控制能力不进入 Studio core 契约。

## 协议语义

收到 `studio_request` 后，handler 将用户文本派给 `studio.entryPetId`。请求进入
Studio 的 per-pet 队列后，立即返回空 `reply` 的 `studio_response`。这只是
**已接收确认**，不是最终答复或任务完成信号；当前 wire message 虽使用
`outcome: 'done'`，消费者也不应将其解释为完成。

handler 会把 dispatch gate 变化投射为 `studio.progress`。插件事件只有显式携带该请求的
correlation 时才会转发；无关联的全局事件不会跨 peer 广播。该事件流是进程内
best-effort 通知，不能用作持久审计或可靠完成协议。

每次请求都会得到不可碰撞的 transport route id，并作为 dispatch correlation。多个工作流
或多个 peer 并发时，事件不会再归到另一个请求。没有显式 correlation 的插件事件保持
领域全局语义，不附着到任何 request。

## 关闭

server 关闭时 `StudioHost.shutdown()` 会停止常驻 Studio。Studio 随后拒绝新 dispatch、逆序停止插件、清理订阅，
并释放等待 gate 的队列。尚未开始的 queued dispatch 不会在 shutdown 后调用 pet；插件
启动失败也会逆序回滚已启动前缀。宿主拥有的 Toolkit runtime manager 仍由
宿主负责更大的生命周期。

完整实现约束与可插拔 HITL 控制边界见
[Studio 独立 Host runtime 草案](../../design/studio/independent-host-runtime.md)。

参阅[配置](configuration.md)和[Studio API（中文）](../reference/api/studio.md)。
