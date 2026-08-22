# Studio API

[English](../../../reference/api/studio.md)

> **状态：当前编程契约。** 权威导出位于
> [`studioContract.ts`](../../../../packages/studio/src/studioContract.ts)、
> [`studioInvocation.ts`](../../../../packages/studio/src/studioInvocation.ts) 和
> [`types.ts`](../../../../packages/studio/src/types.ts)。

Studio 是轻量的多 Pet dispatch 底座。它不定义任务结构、依赖、调度、重试、
Plugin 状态持久化或 Capability；这些分别属于 Plugin 与 Agent。

## 构造与 dispatch

```ts
const studio = await createStudio({
  studioId: 'content-studio',
  entryPetId: 'planner',
  pets: [plannerRuntime, writerRuntime],
  plugins: [kanbanPlugin],
});

const receipt = await studio.dispatch({
  petId: 'writer',
  input: { kind: 'request', request: 'Draft the article.' },
  metadata: { taskId: 'task-42' },
});

const result = await receipt.completion;
```

接收 dispatch 后会立即返回 receipt，不等待 graph 完成：

```ts
type StudioDispatchReceipt = {
  petId: string;
  threadId: string;
  invocationId: string;
  metadata?: JsonObject;
  onInvocation(handler: StudioInvocationEventHandler): () => void;
  completion: Promise<StudioDispatchResult>;
};
```

每个 `(studioId, petId)` 只有一个稳定、可持久化的 `threadId`；每次接收的
dispatch 有不同的 `invocationId`。同一个 Pet 的 active invocation 串行，不同 Pet
可以并行。`completion` 最终得到 `completed`、`pending_interrupt`、`failed` 或
`cancelled`。显式 `idempotencyKey` 在当前 Host generation 内按 Pet 去重。

`metadata` 完全由 producer 所有，Studio 只透传。任务号、关联号或来源可以放在
其中，但不能替代 `petId`、`threadId`、`invocationId` 或 `interruptId`。

`receipt.onInvocation()` 只观察这一次 invocation，订阅时会立即回放已知的最新
event。因此 transport 可以先发 `studio.accepted`，再安全订阅 progress，无需向
producer metadata 注入私有 route id。

## interrupt 与 resume

持久化 interrupt 会结束当前 invocation，但不会结束 Pet thread。后续交互层通过
一次新的 dispatch 恢复同一 thread：

```ts
await studio.dispatch({
  petId: 'writer',
  input: {
    kind: 'resume_interrupt',
    interruptId: 'interrupt-7',
    payload: {
      kind: 'human_review_response',
      responses: [{ interactionId: 'review-1', selectedOptionId: 'approve' }],
    },
  },
});
```

Studio core 只搬运 typed input 与公开 pending 投射，不解释 review 选项，也不构造
LangGraph Command。Pet runtime 读取权威 checkpoint、校验 interrupt 与 response，
再执行 resume。过期 interrupt 会失败且不修改 checkpoint。

Studio 不复用 Chat 的 session、route cache 或 review message。独立 interaction Plugin
或 Host adapter 可以观察 pending event、与用户交互，再提交上面的 typed resume。

### 与 transport 无关的 dispatch 解析

`parseStudioDispatchRequest(value)` 校验 `StudioDispatchRequest` 的 JSON 表示。它接收
`petId`、typed request/resume input、兼容 JSON 的 `metadata` 与 `idempotencyKey`，但
有意排除仅存在于当前进程的 `AbortSignal`。Studio wire transport 与可选的
[HTTP Plugin](../../studio/http-plugin.md) 共用这个解析器，避免不同 transport 各自定义
一套 dispatch 形状。

## 公共观察与事件总线

- `onInvocation(handler)`：Host 观察所有 invocation 的 `busy` 与终态事件；Plugin
  context 只收到自己发起的 invocation。事件包含 Pet/thread/invocation identity、
  metadata 与可选 pending 投射，但不持久化、不重放。
- `notify(event)` / `subscribe(handler)`：独立的通用 Plugin event 总线。Studio
  不解释、关联或持久化 payload。
- `listPets()`：只返回 descriptor，不暴露 runtime 引用。
- `shutdown()`：拒绝新 dispatch、取消 active invocation、等待已接收队列收口，
  再逆序停止 Plugin。

interrupt 是否存在由 checkpoint 决定，不由 `onInvocation` 的内存订阅决定。

Pet runtime 的单次 invoke 输入只携带 typed request/resume、`threadId` 和 cancellation
signal。`invocationId` 只属于 Studio 协调/投射 envelope，不进入 Pet graph。Capability、Toolkit、workdir 与 Agent execution
context 都在 Host 构建 resident Pet 时确定，Studio 不能通过 dispatch 临时注入。

## Plugin、Toolkit 与 Capability

`StudioPlugin` 是高于 Toolkit 的 Studio 扩展，不是 Toolkit 本身：

```ts
type StudioPlugin = {
  name: string;
  toolkits: readonly AgentToolkit[];
  start(context: StudioPluginContext): Promise<void> | void;
  stop?(): Promise<void> | void;
};
```

Plugin 可以定义零个或多个 Toolkit。它们在 resident Pet 构建前进入 Host inventory。
Capability 完全属于 Agent；Studio 与 Plugin 都不注册 Capability。Studio Host 根据
Pet 约定目录加载 Capability，并由 `Capability.uses` 选择 Toolkit。

更多运行时语义见[英文 Pet Runtime API](../../../reference/api/pet-runtime.md)，配置见
[Studio 配置](../../studio/configuration.md)。
