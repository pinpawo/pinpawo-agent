# Studio 契约：插板与推模型

[English](../../studio/push-model.md)

> **状态：当前契约。** 以
> [`studioContract.ts`](../../../packages/studio/src/studioContract.ts)、
> [`studioInvocation.ts`](../../../packages/studio/src/studioInvocation.ts) 和
> [`createStudio.ts`](../../../packages/studio/src/createStudio.ts) 为准。
>
> **已接受目标差异：** 下文固定 Pet thread、typed dispatch resume、lazy/disabled
> registration 与内建 Studio wire 是过渡实现。目标见
> [Resident Pet Host Ports](../../design/agent-runtime/resident-pet-host-ports.md)。

Studio 是 Plugin 与常驻 Pet runtime 之间的插板。它提供 typed dispatch 通道、
彼此独立的通用 event 总线，以及已安装 Plugin 之间的不透明装配通道：

```text
Plugin ── dispatch(input) ──> Studio ── serialized invocation ──> Pet thread
Plugin ── notify(event)  ──> Studio ── fan-out ────────────────> Plugins
Plugin ── contribute ──────> Plugin-owned hook（Studio 只匹配生命周期）
```

Studio 不定义任务、依赖、排期、重试、Plugin 持久化或 Capability。Plugin 是高于
Toolkit 的扩展，可以定义 Toolkit，但本身不是 Toolkit；Capability 始终属于 Agent。

## 1. Thread 是连续性，invocation 是一次调用

```ts
const receipt = await studio.dispatch({
  petId: 'writer',
  input: { kind: 'request', request: '写一篇文章。' },
  metadata: { producerRef: 'external-job-42' },
});

const unsubscribe = receipt.onInvocation((event) => {
  // 只观察本次 invocation；订阅时会回放最新状态。
});
```

dispatch 返回 receipt 只表示 Studio 已接收，不等待模型执行：

- 一个 `(studioId, petId)` 对应一个确定且稳定的 `threadId`；
- 每次接收的 dispatch 创建一个新的 `invocationId`；
- Pet-owned `continuationId` 只标识 checkpoint 当前等待；
- 外部 producer 若需要关联自己的请求，可以把私有引用放在不透明 `metadata` 中；
  它只随 Studio receipt/event 返回，不会进入 Pet runtime。

同一个 Pet 同时最多运行一个 active invocation，不同 Pet 可以并行。receipt 的
`completion` 最终得到：

- `completed`：本次 graph invocation 完成；
- `waiting`：已持久化等待，本次 invocation 结束；
- `failed`：runtime 执行失败；
- `cancelled`：调用方或 Studio shutdown 取消。

显式 `idempotencyKey` 用来去重同一个 Pet 在当前 Host generation 内的重试。它与
taskId、threadId、invocationId 都不是同一个概念。

## 2. Durable continuation 不占住 invocation 队列

```text
request invocation A1 ──> waiting(continuation-7)
resume invocation  A2 ──> 同一个 Pet thread ──> completed
```

LangGraph checkpoint 保存 interrupt、continuation 与 thread state。发生 interrupt 时，
A1 以 `waiting` 结束并释放 active queue slot，但 thread 仍然等待。没有交互
Plugin 时，它可以一直停在那里，并不会因为 Studio 内存里没有 waiting object 而丢失。

独立 interaction Plugin 或 Host adapter 可以观察 opaque continuation 投射，把它交给用户界面，
随后提交新的 typed dispatch：

```ts
await studio.dispatch({
  petId: 'writer',
  input: {
    kind: 'resume',
    continuationId: 'continuation-7',
    payload: { response: 'Pet-defined value' },
  },
});
```

Studio core 只搬运 input/result，不解释 payload，也不构造 graph resume command。Pet runtime
读取权威 checkpoint，校验 `continuationId` 与 Pet-defined payload，再构造 keyed LangGraph
Command。stale resume 会失败且不会修改 checkpoint。

这条链路不复用 Chat 的 session、route cache 或 `human_review_response` handler。Chat 与
Studio 不共享 review-specific contract；只有 Pet runtime 解释该 payload。

## 3. 每 Pet 串行，不按 waiting 挂住 dispatch

Studio 的队列只序列化正在执行的 invocation。一个 invocation 到达 completed、
waiting、failed 或 cancelled 后，队列就可以接收下一次调用。

若 checkpoint 仍有 pending continuation：

- 普通 request 由 Pet runtime 拒绝；
- matching `resume` 可以继续；
- stale interrupt 或不支持的 continuation 会失败，不修改 checkpoint。

因此并发完整性与持久化等待分开：Studio 负责同一 Pet 不并发 invoke；Pet runtime
负责判断下一次 typed input 是否能作用于当前 checkpoint。`gate()` 仍可用于 Host
诊断，但不再代表“一次 dispatch 必须一直占住内存队列”。

## 4. Invocation 观察与 Plugin event 是两条通道

`receipt.onInvocation()` 只观察一次已接收 invocation，并在订阅时回放其最新状态。
它是 request transport 的关联边界；Studio 不再往 producer metadata 中塞私有 route id。

Studio/Plugin 上的 `onInvocation()` 是更广的 live control-plane 投射：

- 公共 Studio 订阅看到所有 invocation；
- Plugin context 只看到自己发起的 invocation；
- event 携带 `petId`、`threadId`、`invocationId`、status、metadata，以及可选的
  `pendingContinuation` / error；
- event 不持久化、不重放，interrupt 是否存在仍以 checkpoint 为准。

`notify()` / `subscribe()` 则是完全独立的 Plugin event 总线：

```ts
context.notify({
  type: 'task.completed',
  metadata: { taskId: 'task-42' },
  payload: { summary: '文章已保存。' },
});
```

Studio 补 `source` 与 `occurredAt`，异步扇出，但不解释 payload、不推断它对应哪个
dispatch，也不把全局 Plugin event 附着到某个 transport delivery，更不负责持久化
和重试。领域结果是否落盘、如何展示，仍由 Plugin 决定。

## 5. Plugin、Toolkit、Capability 边界

```ts
type StudioPlugin = {
  name: string;
  toolkits: readonly AgentToolkit[];
  start(context: StudioPluginContext): Promise<void> | void;
  stop?(): Promise<void> | void;
};
```

Plugin 可以定义零个或多个 Toolkit。Toolkit 在 resident Pet 构建前进入 Host 的统一
inventory，由 Agent 侧处理 availability、Runtime 与 `Capability.uses` 选择。Studio 与
Plugin 都不注册或附带 Capability；Studio Host 按 Pet 约定目录加载 Capability。

Plugin 按顺序启动、逆序停止，启动失败会回滚已启动前缀。Plugin 只能通过 dispatch
派活；`listPets()` 只返回 descriptor，不暴露 runtime 引用。

Plugin hook 不替代 event：event 通知运行时事实，hook 负责装配已安装的功能。hook
值与类型由提供方拥有；Studio 只按 `targetPluginName + hookName` 连接双方、兼容任意
启动顺序，并在任一 Plugin 停止时卸载贡献。这样 HTTP Plugin 可以暴露 route 注册，
Kanban Plugin 可以贡献自己的 route，而 HTTP 不依赖 Kanban，Studio core 也不出现
HTTP 类型。

## 6. 边界检查表

| Studio | Plugin、Pet runtime 或 Host |
| --- | --- |
| Pet registry 与 dispatch 合法性 | task schema、依赖、排期、重试 |
| 稳定 Pet thread 与每 Pet invocation 串行 | checkpoint 解释与 resume command |
| invocation identity 与 live observation | 交互 UI、授权、durable pending index |
| 不透明 event 扇出 | event 含义与持久化 |
| 不透明 Plugin hook 匹配与清理 | hook 值、route schema、贡献行为 |
| Plugin lifecycle | Plugin 领域状态与存储 |

当前刻意保留的限制包括：内存 invocation 队列、Host generation 内幂等记录、无
backpressure、无 durable event replay、没有内建 interaction Plugin。Pet checkpoint
的持久化不依赖这些内存机制。
