# Studio API

[English](../../../reference/api/studio.md)

> **状态：当前编程契约。** 权威导出位于
> [`packages/studio/src/index.ts`](../../../../packages/studio/src/index.ts)、
> [`studioContract.ts`](../../../../packages/studio/src/studioContract.ts) 和
> [`types.ts`](../../../../packages/studio/src/types.ts)。

Studio 是轻量的多 Pet dispatch 底座；它不提供 run/task snapshot、取消、自动重试、
结果聚合、scheduler 或 shared wiki API。

## 构造与核心 API

```ts
const studio = await createStudio({
  studioId: 'content-studio',
  entryPetId: 'planner',
  pets: [plannerRuntime, writerRuntime],
  plugins: [kanbanPlugin],
});

const { threadId } = await studio.dispatch({
  petId: 'writer',
  request: 'Draft the article.',
  correlationId: 'task-42',
});
```

`createStudio()` 会拒绝重复的 `petId`，以及不在 `pets` 中的 `entryPetId`。
插件按传入顺序启动；任何插件启动失败都会使构造失败。

`dispatch()` 接收向已配置且未 disabled Pet 的投递，并**立刻**返回新的
`threadId`。这只表示请求已进入投递队列，不表示任务已经完成。只有 Studio 已关闭、
Pet 不存在或 Pet disabled 时才会抛错；busy Pet 会排队而非被拒绝。

公共 `Studio` 还提供：

- `notify(event)`：广播完整 `StudioEvent`；Studio 不校验、持久化、重放或关联
  payload。
- `subscribe(handler)`：订阅当前进程内事件；单个 handler 失败不会影响其他订阅方。
- `listPets()`：返回 Pet descriptor，不返回 runtime 引用。
- `shutdown()`：拒绝后续 dispatch、按逆序停止插件并清理订阅。

## 插件 context 与 gate

`StudioPlugin` 是带可选 `studio.start(context)` / `stop()` 钩子的
`AgentToolkit`。启动时拿到的 context 提供 `dispatch`、`notify`、
`subscribe`、`listPets` 和 `onDispatchGate`。context 会自动补 event 的
`source` 与 `occurredAt`。

`onDispatchGate` 只接收**本插件发起的**投递的状态变化：

```ts
type PetGateState = 'open' | 'busy' | 'waiting' | 'blocked';
```

它是点对点的进度回路，不是任务结果协议，也没有持久化或重放保证。Studio 依赖
runtime 的 `gate()` / `onGateChange()` 决定何时放行同一 Pet 的下一项；runtime
必须在待继续工作真正完成后报告 `open`。

更多类型与精确语义见[英文 API 参考](../../../reference/api/studio.md)。本地文件配置见
[Studio 配置](../../studio/configuration.md)。

