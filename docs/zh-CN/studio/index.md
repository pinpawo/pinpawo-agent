# Studio

[English](../../studio/index.md)

> **状态：当前契约。** `@pinpawo/studio` 是独立 Studio Host/runtime package；
> 它通过 host 的公共 `host-runtime` surface 复用本机 Host 装配能力；具体的
> Pet Agent Session adapter 来自独立的 `wire` surface，不进入 Chat 启动链路。
> `pinpawo-studio` 可执行入口也直接位于 `packages/studio`；具体 Plugin
> 仍通过 `StudioPluginResolver` 从外部注入。

Studio 维护可派发 Pet 的注册表和 Plugin 事件总线。`dispatch()` 在 resident port 接纳输入后
返回 invocation identity；receipt 不跟踪 Agent execution，也没有 completion/result。
队列与 gate 属于 resident runtime，任务结构、依赖、重试和持久化由 Plugin 负责。

```text
Plugin A ── notify(event) ──> Studio event bus ── subscribe ──> Plugin B
Plugin   ── dispatch(request) ──> Studio ── PetDispatchPort ──> Pet
```

## 建议阅读顺序

- [Independent Host runtime](../../design/studio/independent-host-runtime.md) —
  Host、进程、Plugin、dispatch 与 interaction 所有权。
- [Resident Pet Host ports](../../design/agent-runtime/resident-pet-host-ports.md) —
  Studio dispatch 与 Pet 直接对话之间的 host 装配边界。
- [配置](configuration.md) — `studio.json`、Pet 文件、校验与 Plugin 注入。
- [Studio API](../../reference/api/studio.md) — 导出的类型和精确语义。
- [HTTP Plugin 设计](../../design/studio/http-plugin.md) — 唯一 HTTP/SSE control plane
  与 Plugin route 边界。

## 职责与限制

Studio 校验存活 Pet 和 entryPetId、接纳输入并分配 invocation identity、管理 Plugin
生命周期与事件广播。resident 拥有运行槽/队列、对话、checkpoint 与 session 恢复；
Plugin 拥有领域历史、调度与知识投影。精确接口以 API 为准，进程内幂等和 live 事件
不提供执行结果、自动重试、超时或持久重放。

Channel 的唯一[当前设计](../../design/studio/channel-addressing-and-execution.md)定义
目标/消息、参与者寻址、默认 Reply、可信来源与固定 session。
Scheduler/Trigger 仍为独立 Plugin；[队列巡检](../../design/studio-dispatch-queue-notices.md)
是可选策略，不把队列所有权交给 Channel。
HTTP Plugin 提供 control plane；同进程独立的 Host Pet listener 提供 Agent Session
HTTP/SSE 与 WebSocket/TUI，不进入 Studio core。

旧设计与阶段验收留在[历史目录](../../history/index.md)。init 不升级已有工作区，
迁移按[配置指引](../../studio/configuration.md#retired-kanban-workdirs)显式进行。
