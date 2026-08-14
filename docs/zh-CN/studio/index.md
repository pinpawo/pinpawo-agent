# Studio

[English](../../studio/index.md)

> **状态：当前契约。** Studio 是多 Pet 的轻量协调底座，不是工作流编排器。

Studio 维护可派发 Pet 的注册表、每个 Pet 的 FIFO 队列和插件事件总线。一次
`dispatch()` 返回 `threadId` 只表示请求已经被接收；任务结果、进度、依赖、
重试、超时和持久化由插件或宿主负责。

```text
plugin ── notify(event) ──> Studio ── dispatch(request) ──> pet
```

## 建议阅读顺序

- [推模型与边界](push-model.md) — dispatch、队列 / gate、事件和插件生命周期。
- [配置](configuration.md) — `studio.json`、Pet 文件、校验与内置 Kanban 插件。
- [本地宿主集成](host-integration.md) — workdir 装配、WebSocket 确认和事件转发。
- [Studio API（中文）](../reference/api/studio.md) — 导出的类型和精确语义。

## Studio 负责什么

- 校验 Pet 注册表与默认 `entryPetId`；
- 接收可派发请求并按 Pet 串行化，同时允许不同 Pet 并行；
- 根据 runtime gate（`open` / `busy` / `waiting` / `blocked`）决定何时放行下一项；
- 按配置顺序启动插件、逆序停止插件，并广播插件通知而不解释内容。

任务如何拆分、依赖和进度如何保存、何时重试、scheduler / webhook / UI / 传输如何
工作，都不属于 Studio。内置 `kanban` 是典型的双面插件：Pet 通过其 Toolkit
读写看板，插件自身根据看板状态派活或发事件。

## 运行限制

队列与事件订阅都只存在于当前进程内。Studio 不提供持久化确认、背压、自动重试、
超时或终态结果 API。需要这些能力的插件必须自行建模并持久化相应状态。修改配置后
需重启 local host，才能重新装配该 workdir 的 Studio。

旧的 run controller、due-run scheduler 和 shared wiki 方案已经移到
[Studio 历史记录](../../history/studio/)，不再代表当前行为。

