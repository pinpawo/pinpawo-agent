# 架构

> **状态：当前概念指南。** 类型与协议细节由 [Reference](../reference/index.md) 中的页面维护。

[English](../../concepts/architecture.md)

PinPawo Agent 将编排、任务权限、工具执行、人工审核和持久状态分开，使每个边界可以独立演进并保持可观察。

## 设计目标

1. **用户保持控制：** 本地工具和浏览器 session 不离开运行 Agent 的机器；高风险操作可等待审核。
2. **权限可见：** Capability 静态声明 Toolkit 依赖，单个任务的工具面是明确的。
3. **支持多步骤工作：** checkpoint、结构化事件和 session snapshot 支持断线、审核与恢复。
4. **无需 fork runtime 即可扩展：** Markdown Capability 与 typed Toolkit 分别承载领域意图和执行实现。
5. **从单 Agent 扩展到协作：** Studio 提供共享 dispatch 通道与插件边界，而不是建立全局 prompt 或共享私有 scratchpad。

## 系统地图

```text
用户 / TUI / desktop / stdio client
  → local-agent host
  → pet-agent orchestrator → Capability lane → Toolkit tools
  → checkpoint + artifact refs
  → 可选 Studio runtime（多 Pet 协调）
```

local-agent host 是机器集成边界：解析配置、启动 Toolkit runtime、暴露 HTTP/WebSocket 或 JSONL stdio，并组装 Capability registry。与机器无关的编排在 `packages/pet-agent/`；本地集成留在 `services/` 与 `toolkits/`。

独立 Studio 进程由 `services/studio-app/` 组合：它提供 `pinpawo-studio` 入口并持有
installed optional-module catalog；`packages/studio/` 仍不依赖 Kanban 等具体 module。

领域所有权链是 `Host -> Agent Runtime -> Capability -> Toolkit`。
`ToolDefinition` 与 Toolkit Runtime 从属于 Toolkit；orchestrator 与 subagent lane
属于 Agent 内部实现。Browser 等 package factory 不能因此形成平级架构层。完整的
accepted constraints 见[领域关系设计](../../design/host-agent-capability-toolkit.md)。

## 状态归属

| 状态 | Owner | 规则 |
|---|---|---|
| 对话消息和待继续执行 | LangGraph checkpoint | resume 与审核的持久权威。 |
| 当前客户端视图 | Session projection | 物化视图，不是第二份对话存储。 |
| Capability 草稿与工具过程 | Subagent lane | 私有、短生命周期。 |
| 跨 lane 输出 | Artifact store | 通过引用传递，不复制进每条消息。 |
| 本地配置 | local host + workdir | 在创建 runtime 前解析。 |
| Studio dispatch 投递 | Studio 的 per-Pet queue + runtime gate | 仅进程内投递；工作流状态属于插件或宿主。 |

## 下一步

- [快速开始](../guides/getting-started.md)
- [核心概念](core-concepts.md)
- [API 参考](../reference/api/index.md)
- [Studio](../studio/index.md)
