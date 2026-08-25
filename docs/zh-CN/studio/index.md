# Studio

[English](../../studio/index.md)

> **状态：当前契约。** `@pinpawo/studio` 是独立 Studio Host/runtime package；
> 它通过 local-agent 的公共 `host-runtime` surface 复用本机 Host 装配能力；具体的
> local wire adapter 来自独立的 `local-server-transport` surface，不进入 Chat 启动链路。
> `pinpawo-studio` 可执行入口也直接位于 `packages/studio`；具体 Plugin
> 仍通过 `StudioPluginResolver` 从外部注入。
>
> **已接受目标差异：** 固定 Pet thread、dispatch resume 与内建 Studio
> WebSocket/stdio 都是过渡实现。目标 dispatch 是单向的；Agent Session conversation
> 负责 active thread 切换与 continuation 恢复。见
> [Resident Pet Host ports](../../design/agent-runtime/resident-pet-host-ports.md)。

Studio 维护可派发 Pet 的注册表、每个 Pet 的 invocation 串行通道和 Plugin 事件总线。
`dispatch()` 立即返回稳定 Pet thread 与新 invocation identity；receipt 的 completion
随后收口本次调用。任务结构、依赖、重试和 Plugin 持久化仍由 Plugin 或 Host 负责。

```text
plugin ── notify(event) ──> Studio ── dispatch(request) ──> pet
```

## 建议阅读顺序

- [推模型与边界](push-model.md) — 过渡期当前实现的 thread/invocation、durable resume、事件和 Plugin 生命周期。
- [Resident Pet Host ports](../../design/agent-runtime/resident-pet-host-ports.md) —
  Studio dispatch 与 Pet 直接对话之间的 local-agent 装配边界。
- [配置](configuration.md) — `studio.json`、Pet 文件、校验与 Plugin 注入。
- [本地宿主集成](host-integration.md) — workdir 装配、WebSocket 确认和事件转发。
- [HTTP Plugin](http-plugin.md) — 直接 dispatch 与 SSE live Plugin event。
- [Studio API（中文）](../reference/api/studio.md) — 导出的类型和精确语义。

## Studio 当前负责什么

- 校验 Pet 注册表与默认 `entryPetId`；
- 接收可派发请求并按 Pet 串行化，同时允许不同 Pet 并行；
- 为每个 Pet 提供稳定 durable thread，为每次 dispatch 分配 invocation identity；
- 投射 invocation 的 busy 与终态，包括 presentation-safe pending interrupt；
- 按配置顺序启动插件、逆序停止插件，并广播插件通知而不解释内容。

任务如何拆分、依赖和进度如何保存、何时重试、scheduler / webhook / UI / 传输如何
工作，都不属于 Studio。Pet 直接对话、Agent Session projection 与 TUI transport 也由
local-agent 负责。可选 `@pinpawo-plugin/kanban` package 提供一个 Plugin：它定义供 Pet
使用的 Kanban Toolkit，并在自己的生命周期内根据看板状态派活或发事件。Plugin 本身
不是 Toolkit。

可选 `studio-http` package 是另一个具体 Plugin。它不定义 Toolkit，只把
`context.dispatch()` 和 `context.subscribe()` 投射成带鉴权的 loopback HTTP/SSE
边界。

在已接受目标中，Host 只注册当前存活且 eager-start 的 Pet；Studio 不再报告
lazy/disabled Pet，也不公开 Agent Session active thread identity。HTTP Plugin 成为 Studio
control-plane transport；同一 Host 进程内另行运行 local-agent Agent Session WebSocket，
负责直接 Pet conversation，但不进入 Studio core。

## 运行限制

队列、幂等记录与事件订阅都只存在于当前进程内。Studio 不提供背压、自动重试、
超时、durable event replay 或内建 interaction Plugin。Pet checkpoint 与稳定 thread
identity 不依赖这些内存投射，可以跨 Host 重启恢复。

旧的 run controller、due-run scheduler 和 shared wiki 方案已经移到
[Studio 历史记录](../../history/studio/)，不再代表当前行为。
