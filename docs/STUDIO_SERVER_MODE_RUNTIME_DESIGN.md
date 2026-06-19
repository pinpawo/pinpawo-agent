# Studio Server Mode Runtime Design

本文定义 Studio 从 TUI `/studio` 临时入口迁移到 server 启动模式的目标设计。

相关文档:

- `docs/STUDIO_RUN_CONTROLLER_DESIGN.md`: Studio run controller 内部模型。
- `docs/WORKDIR_SCOPED_RUNTIME_CONFIG_DESIGN.md`: workdir 作用域配置。

## 背景

当前本地 TUI 通过 `/studio` 命令把一次普通 chat session 临时切到 Studio request。这个模型适合早期验证,但已经和新的 Studio run controller 目标冲突:

- Studio runtime 生命周期跟单个 turn 绑定,容易反复装配 orchestrator、queue store 和 pet runtimes。
- run queue recovery 容易被每个 turn 重复触发。
- pet 是否忙碌缺少稳定的进程内归属点。
- TUI 需要在 chat mode 内维护一套 `/studio` / `/chat` 切换状态。
- server 启动时无法清晰表达"这个进程就是 Studio host"。

新的方向是让 server 启动时选择运行模式:

```bash
pinpawo-agent server --mode chat
pinpawo-agent server --mode studio
```

`chat` 是默认模式。`pinpawo-agent run` 可以继续作为 `server` 的兼容别名,但长期文档和用户入口应收敛到 `pinpawo-agent server`。

## Goals

- server 启动时确定运行模式,而不是由 TUI slash command 临时切换。
- Studio mode 下创建一个 workdir-scoped `StudioRuntimeHost`,后续请求复用同一个 host。
- Studio mode 下的 pet runtime registry、run queue store、orchestrator、wiki root 和 pet busy state 都归属于这个 host。
- TUI 在 Studio mode 下默认把普通输入发送为 `studio_request`。
- Chat mode 下不再提供 `/studio` 入口;`/studio` 和配套 `/chat` toggle 都应删除。
- Studio request 不再触发 per-turn fresh orchestrator / fresh pet runtime 组装。

## Non-goals

- 不在本设计里改变 worker pet 内部的 ReAct / capability / tool 调用机制。
- 不让 planner 负责执行或调度。planner 仍只负责通过 `studio_plan.enqueue_tasks` 往 queue 塞 task。
- 不保留 TUI `/studio` 作为兼容入口。
- 不支持同一个 server 进程同时以 chat 和 studio 两种主模式服务同一个 TUI。
- 不做 Studio config hot reload。V1 配置变化需要重启 server。

## Mode Contract

```ts
type LocalServerMode = 'chat' | 'studio';
```

### Chat Mode

默认模式:

```bash
pinpawo-agent server
pinpawo-agent server --mode chat
```

行为:

- 初始化普通 chat runtime。
- 不要求 `<workdir>/.pinpawo/studio.json` 存在。
- TUI 普通输入发送 `chat_request`。
- server 收到 `studio_request` 时返回明确错误,例如 `studio mode is not enabled`。
- TUI 不显示 `/studio` 命令。

### Studio Mode

显式模式:

```bash
pinpawo-agent server --mode studio
```

行为:

- 启动时解析当前 `LocalAgentRuntimeConfig`。
- 从 `<workdir>/.pinpawo/studio.json` 和 `<workdir>/.pinpawo/pets/` 加载 Studio 配置。
- 创建一个 `StudioRuntimeHost`。
- 如果 Studio 配置缺失或非法,启动失败并给出明确错误;不静默降级到 chat。
- TUI 普通输入发送 `studio_request`。
- server 收到 `chat_request` 时返回明确错误,例如 `chat mode is not enabled`。
- TUI 不显示 `/chat` toggle。需要 chat 时重启 server 为 chat mode。

`/runtime` 应返回:

```json
{
  "server_mode": "studio",
  "workdir": "...",
  "studio_config_path": "...",
  "pets_dir": "...",
  "studio_wiki_base_dir": "..."
}
```

TUI 只根据 `server_mode` 决定默认 request 类型,不再自己持有"从 chat 切进 Studio"的长期模式状态。

## Runtime Host Shape

server 启动后只创建一种主 host:

```ts
type LocalRuntimeHost =
  | ChatRuntimeHost
  | StudioRuntimeHost;

type StudioRuntimeHost = {
  mode: 'studio';
  runtimeConfig: LocalAgentRuntimeConfig;
  resolvedStudio: ResolvedStudio;
  petRegistry: StudioPetRegistry;
  orchestrator: StudioOrchestrator;
  runQueueStore: StudioRunQueueStore;
  wikiBaseDir: string;
};
```

`StudioRuntimeHost` 是 workdir-scoped:

```text
host key = runtimeConfig.workdir + studioId
```

同一 host 内:

- run queue recovery 只执行一次。
- pet registry 只装配一次。
- orchestrator 只创建一次。
- due-run scheduler 如果存在,也通过同一个 host submit Studio runs。

这会替代当前 `buildStudioForTurn()` 的 per-request 装配模型。

## Pet Runtime Lifecycle

Studio mode 下"启动多个 agent runtime"是合理的,但要明确两层状态:

1. **Runtime availability**
   - server 启动时创建或装配 pet runtime。
   - 这些 runtime 处于 standby,表示这个 pet 可以被 Studio 使用。
   - standby 不等于正在执行任务。

2. **Invocation busy**
   - 某个 task 被 runner dispatch 给 pet 后,Studio registry 给该 pet 加 lease。
   - lease 存在期间该 pet 是 busy/running。
   - worker invoke 完成、失败或取消后释放 lease。

因此 Studio mode 可以在启动时为 studio 下所有 pets 建立 runtime registry:

```ts
type StudioPetRegistry = {
  listPets(): StudioPetDescriptor[];
  getRuntime(petId: string): PetAgentRuntime | null;
  isAvailable(petId: string): boolean;
  isBusy(petId: string): boolean;
  acquire(petId: string, taskId: string): PetLease | null;
};
```

runner dispatch 规则:

```text
if task deps not done -> wait
if target pet unavailable -> block
if target pet busy -> wait
lease = registry.acquire(petId, taskId)
invoke worker once
release lease on settlement
```

## Human Review Bridge

当前代码里 `createPetAgentRuntime(...)` 会接收 `humanReviewer`,而 TUI/WebSocket review bridge 是 request/connection scoped。把 pet runtime 提前创建到 server startup 时,不能再把某个 requestId/ws 绑定进长期 runtime。

目标改法是把 reviewer 从 runtime 构造期移动到 invocation 期:

```ts
type PetRuntimeInvocationContext = {
  requestId: string;
  connectionId?: string;
  humanReviewer?: HumanReviewer;
  signal?: AbortSignal;
};

type PetAgentRuntime = {
  descriptor(): PetAgentRuntimeDescriptor;
  invoke(input: PetAgentInvokeInput, context: PetRuntimeInvocationContext): Promise<PetAgentInvokeResult>;
};
```

过渡期如果 pet runtime 还不能接受 invocation context,`StudioRuntimeHost` 可以先缓存 runtime factories,但最终目标是长期复用 runtime object,并在每次 invoke 传入 request-scoped bridge。

这点是 Studio host 迁移的关键约束。否则提前创建 runtime 会把第一个 TUI request 的 reviewer 错误复用到后续 request。

## Request Routing

### TUI

TUI 初始化流程:

```text
GET /runtime
  -> read server_mode
  -> mode=chat   : ordinary input sends chat_request
  -> mode=studio : ordinary input sends studio_request
```

删除:

- command registry 中的 `/studio`。
- command registry 中的 `/chat` toggle。
- `submitCurrentInputFromController` 中依赖 `studioModeRef` 的 slash-command 切换逻辑。
- "进入 Studio 模式 / 退出 Studio 模式" 文案。

保留:

- `/new`: 新建当前模式下的新会话。Studio mode 下应重置 `conversationId`。
- `/resume`: 恢复当前模式兼容的会话。
- `/help`、`/export`、`/edit`、`/quit`。

### WebSocket Server

server transport 可以继续接受两种消息类型,但 handler 必须按 mode gate:

```text
mode=chat:
  chat_request   -> handle
  studio_request -> studio_error("studio mode is not enabled")

mode=studio:
  studio_request -> handle
  chat_request   -> error("chat mode is not enabled")
```

这样协议层不需要立刻删字段,但产品入口已经不再暴露 `/studio` 临时切换。

## StudioRuntimeHost Submit Flow

```text
server --mode studio
  -> create StudioRuntimeHost once
  -> recover open runs once
  -> TUI input
  -> studio_request
  -> host.submitRequest({ userRequest, conversationId, request bridge })
  -> orchestrator.submitRequest()
  -> planner pet invoke
  -> planner enqueue_tasks
  -> runner dispatches worker tasks by FIFO + deps + pet lease
  -> worker completion updates wiki
  -> run_finished response
```

`StudioRunService` should become a thin adapter over `StudioRuntimeHost`, or be removed once all callers use the host directly. It should not create a fresh Studio runtime per request.

## Persistence And Recovery

`StudioRuntimeHost` owns:

- `studio-run-queue.json`
- run recovery
- task queue snapshots
- wiki root

Rules:

- Recovery runs once during host startup.
- Recovery is for process restart, not for every request.
- Restored terminal runs must be reconciled and finalized before scheduling new work.
- Restored running tasks cannot be assumed to still have live worker invocations; they should be reconciled to blocked/queued according to run controller policy.

## Iteration Plan

### Iteration 1: Mode Contract

Deliver:

- Add `pinpawo-agent server --mode chat|studio`.
- Keep `chat` as default.
- Return `server_mode` from `/runtime`.
- TUI reads `server_mode` and defaults ordinary input to the matching request type.

This is the migration bridge. It does not yet finish long-lived Studio host.

### Iteration 2: Remove TUI `/studio`

Deliver:

- Remove `/studio` from TUI command registry, palette, help text and tests.
- Remove `/chat` toggle if its only purpose is leaving `/studio`.
- Remove `studioModeRef` as a user-controlled toggle.
- Chat mode rejects `studio_request`.
- Studio mode rejects `chat_request`.

Expected result:

- Users choose mode at server startup.
- TUI no longer has in-session chat/studio switching.

### Iteration 3: Decouple Request-bound Review Bridge

Deliver:

- Move `humanReviewer` binding from pet runtime construction to pet invoke context.
- Keep pet runtime reusable across requests.
- Studio host passes request/connection scoped reviewer into each planner/worker invoke.

Expected result:

- Startup-created pet runtimes are safe across many TUI requests.
- HITL routing remains request-scoped.

### Iteration 4: Create StudioRuntimeHost At Startup

Deliver:

- Add `createStudioRuntimeHost(runtimeConfig, deps)`.
- Load Studio config and all pet configs at server startup in Studio mode.
- Fail fast when Studio mode is requested but config is missing.
- Move run queue store and recovery into host startup.
- Stop calling `buildStudioForTurn()` from normal Studio request handling.

Expected result:

- one process/workdir/studio has one long-lived Studio runtime host.
- queue recovery cannot double-drive live runs inside the same process.

### Iteration 5: Pet Lease And Busy State

Deliver:

- Add pet lease tracking to `StudioPetRegistry`.
- Runner checks lease before dispatch.
- Lease released on worker completion/failure/cancel.
- `studio_plan.list_pets` reports availability plus invocation busy state.

Expected result:

- concurrent Studio requests cannot double-dispatch to the same busy pet.
- pet "running" means active invocation, not merely runtime object exists.

### Iteration 6: Collapse Per-turn Adapters

Deliver:

- Remove or shrink `StudioRunService` per-turn construction.
- Delete `buildStudioForTurn()` or turn it into startup-only host builder.
- Align due-run scheduler and app WebSocket Studio entry to submit through the same host.

Expected result:

- Studio request path has one owner for queue, pet registry, orchestrator and wiki.

## Open Decisions

- Whether `pinpawo-agent run` should remain documented as an alias or become hidden.
- Whether Studio mode should support a `/new` conversation reset with an explicit Studio conversation id shown in UI.
- Whether app WebSocket path should enforce server mode immediately, or only after TUI migration lands.
