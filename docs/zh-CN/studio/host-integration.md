# Studio 本地宿主集成

[English](../../studio/host-integration.md)

> **状态：当前 local-agent 行为。** 本页描述已实现的本地适配，不替代
> `@pinpawo/studio` 的传输无关 API。

```text
<workdir>/.pinpawo/{studio.json,pets/*.json}
      ↓ buildStudio()
Studio + PetAgentRuntime[] + 已配置插件
      ↓ LocalServerStudioHandler
studio_request → dispatch(entryPetId) → studio_response（确认）
                                      ↘ studio.progress（插件事件）
```

这是与 Chat 相同的 `Host -> Agent Runtime -> Capability -> Toolkit` 领域模型。
Studio 只改变一个 Host 如何配置、常驻并 invoke 多个 Pet runtime，不引入另一套
Toolkit 或 Toolkit Runtime。完整约束见
[领域关系设计](../../design/host-agent-capability-toolkit.md)。

## 装配与生命周期

本地宿主根据 workdir 读取 Studio 与 Pet 配置，构造每个 `PetAgentRuntime` 并
装配插件。server 会按 workdir 缓存已构造的 Studio，而不是每个请求重建；一次构造
失败不会缓存，修复配置后下一次请求会重新尝试。

宿主可注入共享 checkpointer。Pet runtime 据此判断一次 `invoke()` 是否仍有待继续
的执行，从而报告 `open`、`waiting` 或 `blocked` gate。Studio 自身不读取
checkpoint，也不处理人工审核的 payload。

## 协议语义

收到 `studio_request` 后，handler 将用户文本派给 `studio.entryPetId`。请求进入
Studio 的 per-pet 队列后，立即返回空 `reply` 的 `studio_response`。这只是
**已接收确认**，不是最终答复或任务完成信号；当前 wire message 虽使用
`outcome: 'done'`，消费者也不应将其解释为完成。

插件调用 `notify` 时，handler 才会转发 `studio.progress`。单纯 dispatch 不会
产生 progress。该事件流是进程内 best-effort 通知，不能用作持久审计或可靠完成协议。

同一连接上的事件桥会把事件关联到该 peer 最近一次 Studio request ID。若需要同时运行
多个可可靠区分的工作流，集成方必须在插件领域状态或事件 payload 中携带并持久化自己的
关联标识。

## 关闭

server 关闭时会停止缓存的 Studio。Studio 随后拒绝新 dispatch、逆序停止插件、清理订阅，
并释放等待 gate 的队列，而非无限等待人工输入。宿主拥有的 Toolkit runtime manager 仍由
宿主负责更大的生命周期。

参阅[配置](configuration.md)和[Studio API（中文）](../reference/api/studio.md)。
