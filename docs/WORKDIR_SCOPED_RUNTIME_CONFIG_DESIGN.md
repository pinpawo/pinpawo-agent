# Workdir Scoped Runtime Config Design

## 背景

当前 local-agent 的配置分成两类来源，但边界还不清晰：

- `~/.pinpawo/config.json` 和环境变量提供 LLM、API、actor、`workdir` 等进程级配置。
- 普通 chat/pet runtime 会把 `config.workdir` 注入 graph prompt 和部分运行产物路径。
- Studio runtime 固定读取 `~/.pinpawo/studio.json`、`~/.pinpawo/pets/` 和 `~/.pinpawo/studio-wiki/`。
- local file/git/shell/browser 工具内部仍有不少地方直接读取全局 `config.workdir`。

这会导致两个问题：

1. 服务启动时即使动态指定了 `workdir`，Studio 配置仍然是全局的，无法按项目/工作区切换 Studio。
2. 普通 pet runtime 的 prompt 可能看到一个 workdir，但工具解析相对路径时仍可能落到旧的全局 `config.workdir`。

目标是让普通 pet runtime 和 Studio runtime 都可以跟随服务启动时指定的 `workdir`，并把工作区级配置和运行产物收敛到同一个工作区根目录下。

## 目标

- 支持服务启动时动态指定 `workdir`。
- 普通 chat/pet runtime 的 prompt、tool path resolution、artifact root、checkpoint root 使用同一个 effective workdir。
- Studio 配置、pet 配置、wiki 和 Studio 运行产物默认跟随 effective workdir。
- 保留全局账号/密钥配置，不把 token、LLM key、Hasura/JWT 等复制到工作区。
- 支持平滑迁移旧的 `~/.pinpawo/studio.json` 和 `~/.pinpawo/pets/`。
- 设计可迭代，每一阶段都能独立验证和回滚。

## 迭代推进（当前）

- 已完成：
  - 本地协议 `studio_request` 支持 `runId` / `conversationId` 扩展，返回也回传 `runId`、`conversationId`、`idempotencyKey`、`workdir`。
  - `LocalServerStudioHandler` 将 `runId` 透传到 `StudioRunService`，并以会话 id 派生 trace。
  - `@pinpawo/pet-agent` 新增 `StudioDueRun*` 契约（构建、状态机、重试判断）及导出，供 App/API scheduler 落地时复用。
  - 常规路径层面：普通 chat/pet 与 Studio 已通过现有 `LocalAgentRuntimeConfig` 在同一 workdir 作用域内组装（包含 prompt、工具、artifact、checkpoint 与 studio assets）。

- 下一步：
  - 在 API/scheduler 服务层落地 `studio_due_runs` 持久表，使用 `idempotencyKey` 做去重和并发领取（`pending -> claimed -> running -> success/failed`）。
  - 为 scheduler 增加重试策略与 `workdir` 映射、告警可观测指标（claim 延迟、失败原因、重试次数）。
  - 将 `/runtime` 与 App 客户端展示中的运行来源（legacy_home/workdir-scoped）与 scheduler trace 打通，形成可追溯链路。

## 非目标

- 不在这一轮引入多 workdir 同进程并发运行。第一阶段按“一个 local-agent 服务进程绑定一个 effective workdir”处理。
- 本地 WebSocket 上的 Studio 调度现在是**同会话串行化**：同一个连接连续发起新的 `studio_request` 会按队列顺序逐个执行，不会并行执行多个 Studio turn。
- 不改变 `@pinpawo/pet-agent` 的核心 agent 接口。`workdir` 继续作为 host 传入 runtime 的配置项。
- 不把全局登录态、浏览器 session、插件安装目录全部迁入 workdir。它们可以后续单独评估。
- 不解决 Studio 同一 conversation 并发写 wiki 的问题。该问题由 Studio run/concurrency 设计单独处理。

## 配置分层

### Global Home

仍使用用户级目录：

```text
~/.pinpawo/
├── config.json
├── .env
├── local-server-token
├── capabilities/
├── plugins/
└── sessions/
```

Global Home 存放机器/用户级配置：

- API endpoint、agent token、Hasura JWT。
- LLM API key、base URL、默认模型。
- 用户安装的 capability/plugin。
- 本机浏览器 session 和 local server token。

### Workdir State Root

effective workdir 下新增工作区级目录：

```text
<workdir>/.pinpawo/
├── studio.json
├── pets/
│   ├── planner.json
│   └── writer.json
├── studio-curator.md
├── studio-wiki/
├── capability-artifacts/
├── checkpoints.json
├── checkpoints-tui.json
└── tui-sessions.json
```

Workdir State Root 存放工作区级配置和产物：

- Studio 拓扑配置。
- Studio 内 pet 配置。
- Studio wiki。
- 普通 pet runtime 和 Studio runtime 的能力产物。
- 本工作区的 chat/TUI checkpoint 和会话状态。

## Effective Workdir 解析

启动时解析出唯一的 effective workdir：

```text
CLI --workdir
> PINPAWO_WORKDIR
> ~/.pinpawo/config.json#workdir
> process.cwd()
> homedir()
```

默认优先 `process.cwd()`，因为用户通常是在项目目录中启动 local agent。
只有在没有可用 cwd 的极端情况下才回落到 `homedir()`。

解析规则：

- `~` 展开到 `homedir()`。
- 相对路径以当前启动进程的 `process.cwd()` 为基准解析成绝对路径。
- 服务启动后 effective workdir 不再改变。
- `/runtime` HTTP endpoint 返回 effective workdir，供 TUI 和 companion 显示。

## Runtime Config 对象

新增一个显式的 runtime config 对象，避免代码在运行中到处 import 全局 `config.workdir`：

```ts
type LocalAgentRuntimeConfig = {
  workdir: string;
  stateRoot: string;          // <workdir>/.pinpawo
  studioConfigPath: string;   // <stateRoot>/studio.json
  petsDir: string;            // <stateRoot>/pets
  studioWikiBaseDir: string;  // <stateRoot>/studio-wiki
  checkpointPath: string;     // <stateRoot>/checkpoints.json
  tuiCheckpointPath: string;  // <stateRoot>/checkpoints-tui.json
  tuiSessionPath: string;     // <stateRoot>/tui-sessions.json
  capabilityArtifactRoot: string; // <stateRoot>/capability-artifacts
};
```

所有 runtime、server、toolkit、Studio 装配函数都从这个对象拿路径，而不是直接读取 `config.workdir`。

## 普通 Pet Runtime 路径

普通 chat/pet runtime 需要统一四个位置：

1. Prompt 中的工作目录。
2. Graph configurable 中的 `workdir`。
3. local tools 解析相对路径时使用的默认目录。
4. artifact/checkpoint 落盘路径。

目标调用链：

```text
run --workdir
  -> resolveRuntimeConfig()
  -> LocalAgentRuntime(runtimeConfig)
  -> startLocalServer(deps.runtimeConfig)
  -> buildLocalChatAgentInput({ workdir: runtimeConfig.workdir })
  -> graph configurable.workdir
  -> local toolkits use runtimeConfig.workdir
```

需要避免的形态：

```ts
import { config } from './config';
resolve(config.workdir, userPath);
```

推荐改成 toolkit factory：

```ts
createBashToolkit({ workdir: runtimeConfig.workdir });
createGitToolkit({ workdir: runtimeConfig.workdir });
createBrowserToolkit({ workdir: runtimeConfig.workdir });
```

或者在每次 tool invoke 时从 LangGraph configurable 读取 `workdir`。第一阶段优先使用 toolkit factory，因为 local-agent 当前是服务进程级 workdir，改动面更小。

## Studio Runtime 路径

Studio 默认从 Workdir State Root 读取：

```text
<workdir>/.pinpawo/studio.json
<workdir>/.pinpawo/pets/*.json
<workdir>/.pinpawo/studio-wiki/
```

`BuildStudioInput` 扩展为：

```ts
type BuildStudioInput = {
  workdir: string;
  studioConfigPath?: string;
  petsDir?: string;
  wikiBaseDir?: string;
  // existing fields...
};
```

默认解析：

```ts
const stateRoot = path.join(input.workdir, '.pinpawo');
const studioConfigPath = input.studioConfigPath ?? path.join(stateRoot, 'studio.json');
const petsDir = input.petsDir ?? path.join(stateRoot, 'pets');
const wikiBaseDir = input.wikiBaseDir ?? path.join(stateRoot, 'studio-wiki');
```

Studio 内每个 pet runtime 也必须收到同一个 workdir：

```ts
createPetAgentRuntime({
  // existing config...
  workdir: input.workdir,
});
```

`StudioOrchestratorConfig` 也应增加 `workdir`，每次 dispatch 显式透传给 pet invoke：

```ts
createStudioOrchestrator({
  // existing config...
  workdir: input.workdir,
});

agent.invoke({
  brief,
  wikiRoot,
  workdir: config.workdir,
});
```

这样 Studio 内 pet 的 prompt、tool path resolution、artifact root 与普通 pet runtime 保持一致。

## 兼容与迁移

第一阶段保留旧路径 fallback，但必须可观测：

```text
primary:  <workdir>/.pinpawo/studio.json
fallback: ~/.pinpawo/studio.json
```

如果命中 fallback：

- 打印 warning。
- `/runtime` 返回 `studio_config_source: "legacy_home"`，并给出
  `studio_config_active_path`。
- 后续提供迁移命令或 setup 提示。

迁移命令可以后续补：

```bash
pinpawo-agent studio migrate --workdir /path/to/project
```

迁移内容：

```text
~/.pinpawo/studio.json       -> <workdir>/.pinpawo/studio.json
~/.pinpawo/pets/             -> <workdir>/.pinpawo/pets/
~/.pinpawo/studio-wiki/      -> <workdir>/.pinpawo/studio-wiki/
```

默认不删除旧文件。

当前 local-agent 已提供该迁移命令。默认跳过已有目标文件，传 `--force`
时才覆盖目标 workdir 下的 Studio 配置、pets 配置和 wiki 目录。
`/runtime` 也会返回 `studio_config_source`、`studio_config_active_path` 和
`legacy_studio_config_path`，TUI runtime info 会显示实际使用的 Studio 配置路径
及来源（工作区 / 旧全局 / 缺失）。

## CLI 和服务启动

`run` 命令新增：

```bash
pinpawo-agent run --workdir /path/to/workspace
```

`tui` 命令不直接决定 workdir。TUI 连接 local server 后从 `/runtime` 读取当前服务的 effective workdir 并展示。

如果未来需要 TUI 自动启动 local server，则 TUI 再把 `--workdir` 透传给 run 进程。

CLI 实现注意点：

- `config.ts` 当前在 import 时读取环境变量和 stored config。
- 如果用 CLI option 覆盖 workdir，必须在 import `commands/run` 或任何间接 import `config` 之前设置 override。
- 更稳的方式是把 `config` 从 import-time singleton 逐步改为 `loadLocalAgentConfig(overrides)`。

## App/API 和 Scheduler 接入

App/API 侧也应传递同样的 workdir 概念，但第一阶段只做 local-agent 服务级绑定。

后续如果 API scheduler 要执行 Studio run：

```text
 studio_schedule
  -> resolve owner/studio workdir or workspace root
  -> StudioRunService(runtimeConfig)
  -> invoke Studio turn
```

本地协议建议返回至少三项字段，供 scheduler 做幂等与回放：

- `runId`: 本次 Studio run 的唯一 id（对应 `requestId`）。
- `conversationId`: 工作会话 id（默认同 `runId`，如客户端显式传入则沿用）。
- `idempotencyKey`: `studio:{conversationId}:run:{runId}`。
- `workdir`: 本次 run 使用的运行时工作目录（`runtimeConfig.workdir`）。

这样 scheduler 可以按 `idempotencyKey` 做唯一约束，避免同一 due-run 被重复触发时写入双份 wiki/产物；
同时也能按 `conversationId` 聚合同一会话里多轮历史，并以 `workdir` 做路径归属与回放审计。

约束：

- scheduler 不直接读 `studio.json`。
- scheduler 不直接调用 pet runtime 或 capability。
- scheduler 只创建 due run 并交给 StudioRunService。

### Scheduler V1 交付协议（推荐）

为避免并发写入冲突，建议 scheduler 在服务端把 `studio_request` 作为**外部任务**处理，按以下规则落地：

- 数据建模：
  - `studio_due_runs`（或已有任务表的扩展）至少包含：
    - `idempotency_key`（唯一索引）：`studio:{conversationId}:run:{runId}`
    - `run_id`
    - `conversation_id`
    - `workdir`
    - `status`: `pending | claimed | running | success | failed | canceled`
    - `attempt`（重试计数）
    - `error_code` / `error_detail`
    - `request_payload`（含 `userRequest`、`conversationId`、`ownerUserId`）
    - `result`（可选：`finalDispatchId`、`reply`、`created_at`）
    - `updated_at`（处理窗口）
- 触发入库：
  - 每次外部发起都先写一条 `status=pending` 记录。
  - `idempotency_key` 冲突时，返回已有任务行并复用现有 `run_id`，不重复入列。
- 领取执行：
  - worker 每轮 `select ... where status='pending' order by created_at for update skip locked` 领取一条；
  - 领取时 `status=claimed`, `attempt + 1`，`claimed_at` 打点，避免多实例双执行。
- 执行路径：
  - 只允许 `claimed`→`running`→`finished` 的状态机，任何失败走 `failed` 并可重试。
  - 每次回调 `local-agent` 时透传：
    - `runtimeConfig`: `{workdir,studioConfigPath,petsDir,studioWikiBaseDir,...}`
    - `runId`
    - `conversationId`
    - `ownerUserId`
- 重试规则：
  - 对于 `failed` 且 `attempt < retryLimit` 的行，可在 `run_at` 回退后自动重试（scheduler 自持久化）。
  - 重试前再次校验 `workdir` 目录是否可用；不可用则标记失败并暂停该 workdir 的后续运行。
- 幂等约束：
  - `idempotency_key` 决定是否复用任务，不以 user message 文案做主键。
  - `runId` 继续做任务执行 trace 的主键，`conversationId` 做会话聚合。

### 需要避免的 anti-pattern

- scheduler 直接读 `~/.pinpawo/studio.json` 作为运行时来源。
- 同一 `conversationId` 并发投递多个 `studio_request` 且不做 `FOR UPDATE SKIP LOCKED`。
- 仅在内存里保留“是否有在跑中”标记，导致进程重启后重跑重复任务。

## 迭代计划

### Phase 0: 文档和审计

目标：明确所有全局 workdir 读取点。

任务：

- 新增本设计文档。
- 用 `rg "config\\.workdir|~/.pinpawo|studio.json|pets"` 建立迁移清单。
- 标注哪些路径必须保持 Global Home，哪些必须迁到 Workdir State Root。

验收：

- 文档列出目标布局、优先级和迁移阶段。
- 没有代码行为变化。

### Phase 1: 启动时动态 workdir

目标：服务进程可以通过 CLI/env/stored config 解析 effective workdir。

任务：

- `run` 增加 `--workdir`。
- 新增 `resolveRuntimeConfig()`。
- `LocalServerDeps` 增加 `runtimeConfig` 或明确路径字段。
- `/runtime` 返回 `workdir` 和 `stateRoot`。

验收：

- `pinpawo-agent run --workdir /tmp/a` 后 `/runtime.workdir === /tmp/a`。
- 不影响旧的 `PINPAWO_WORKDIR` 和 config.json#workdir。

### Phase 2: 普通 pet runtime 跟随 workdir

目标：普通 chat 的 prompt、tools、artifact 和 checkpoint 使用同一个 effective workdir。

任务：

- `buildLocalChatAgentInput` 不再直接读取 `config.workdir`，改用调用方传入的 workdir。
- `buildRuntimeEnvironmentSummary` 接收 workdir 参数。
- local file/search/git/shell/browser path resolver 改成 toolkit factory 或 runtime-aware resolver。
- capability artifact root 改为 `<workdir>/.pinpawo/capability-artifacts`。
- chat checkpoint 从 `~/.pinpawo/checkpoints.json` 迁到 `<workdir>/.pinpawo/checkpoints.json`。

验收：

- 同一个相对路径在 prompt、file tool、git tool、shell tool 中解析一致。
- 两个不同 workdir 启动的服务不会共享 checkpoint 和 capability artifacts。

### Phase 3: Studio 配置跟随 workdir

目标：Studio 默认读取 `<workdir>/.pinpawo/studio.json` 和 `<workdir>/.pinpawo/pets/`。

任务：

- `BuildStudioInput` 增加 `workdir`、`petsDir`。
- `loadPetLocalConfigs()` 支持 caller 传入 petsDir，local handler 传 `<workdir>/.pinpawo/pets`。
- `wikiBaseDir` 默认 `<workdir>/.pinpawo/studio-wiki`。
- Studio 内 `createPetAgentRuntime` 传入 workdir。
- 旧 `~/.pinpawo/studio.json` fallback 加 warning。

验收：

- 在两个不同 workdir 下放不同 `studio.json`，同一个 local-agent 版本分别启动后读取各自 Studio。
- Studio 内 pet 使用相同 workdir 解析工具相对路径。

### Phase 4: TUI 状态和迁移工具

目标：用户能看见当前 workdir，并能迁移旧 Studio 配置。

任务：

- TUI runtime info 展示 effective workdir。
- `setup` 检查 `<workdir>/.pinpawo/studio.json` 是否存在。
- 可选新增 `studio migrate` 或在 `init --dir` 中生成 workdir-scoped Studio scaffold。

验收：

- 用户不需要猜当前读取的是哪个 studio config。
- 旧配置可复制到新工作区，不自动删除旧配置。

当前实现：

- TUI 从 local server `/runtime` 读取 effective workdir 和
  `<workdir>/.pinpawo/studio.json` 路径并展示。
- `setup --workdir <dir>` 检查该 workdir 下的 Studio 配置，缺失时提示迁移命令。
- `studio migrate --workdir <dir> [--force]` 将旧 `~/.pinpawo` Studio 三件套复制到
  `<workdir>/.pinpawo/`。

### Phase 5: API/Scheduler 工作区化

目标：App/API scheduler 调用 Studio run 时也使用明确 workspace/runtime config。

任务：

- StudioRunService 接收 runtime config。
- scheduled Studio run 记录 `workdir` 或 workspace id。
- 副作用使用 `runId` 和 idempotency key。

验收：

- scheduler 不直接读全局 Studio 配置。
- 不同 workspace 的 scheduled runs 互不污染 wiki、artifact、checkpoint。

当前 repo 状态：`pinpawo-agent` 只包含 local-agent 和 shared pet-agent runtime，
没有 App/API scheduler 服务代码。local-agent 已通过 `LocalAgentRuntimeConfig` 和
`/runtime` 暴露 workdir-scoped 路径；API/Scheduler 落地时应复用同一 runtime config
契约，而不是重新引入全局 `~/.pinpawo/studio.json` 读取。

当前 local-agent 可交付边界：

- 新增 `StudioRunService`，输入显式包含 `LocalServerDeps.runtimeConfig`、`runId`、
  `conversationId`、review bridge 和事件回调。
- `LocalServerStudioHandler` 只保留 WebSocket、inflight 和 review routing 逻辑，
  实际 Studio turn 交给 `StudioRunService`。
- `StudioRunService` 使用 `runId` 作为 Studio `turnId`，并派生稳定
  `studio:<conversationId>:run:<runId>` idempotency key，供未来 scheduler/job 表持久化使用。

- 这套派生逻辑在 `@pinpawo/pet-agent` 中集中为
  `buildStudioRunIdentity({ runId, conversationId? })`，App/API 与 local-agent
  scheduler 接入时应复用该共享 helper，避免重复实现。
- 未来 App/API scheduler 接入时，应由 scheduler 解析 workspace/workdir 后构造
  `LocalAgentRuntimeConfig`，再调用 `StudioRunService`；不要直接调用 `buildStudioForTurn()`。

当前 repo 之外仍未完成：

- scheduled Studio run 表需要记录 workspace id 或 workdir。
- due-run claim、retry、去重和 idempotency key 持久化需要在 App/API scheduler 服务实现。
- scheduler 侧 side effect 需要以 `runId` 和 idempotency key 做幂等保护。

## 测试计划

单元测试：

- `resolveRuntimeConfig()` 覆盖 CLI/env/stored/default 优先级。
- `loadStudioLocalConfig()` 和 `loadPetLocalConfigs()` 覆盖 workdir-scoped 路径。
- local path resolver 覆盖相对路径、绝对路径、`~`。
- `buildLocalChatAgentInput()` 覆盖 input.workdir。

集成测试：

- 启动 local server with temp workdir，调用 `/runtime`。
- 构造 temp workdir 的 `.pinpawo/studio.json` 和 `pets/`，发送 `studio_request`，断言 buildStudio 收到正确路径。
- 同一测试中创建两个 temp workdir，分别验证 Studio config 和 artifact root 不共享。

回归测试：

- 未传 `--workdir` 时保留现有默认行为。
- 旧 `~/.pinpawo/studio.json` fallback 仍能启动 Studio，但有 warning。

## 风险和注意事项

- import-time singleton `config` 是最大风险。只改 CLI option 但不处理 import 顺序，会让 `--workdir` 看似存在但不生效。
- prompt workdir 和 tool workdir 必须同时改，否则模型看到的工作目录和工具实际目录会不一致。
- checkpoint 迁移会影响历史会话可见性。迁移期应允许读取旧 checkpoint 或明确提示“这是新的工作区会话”。
- capability/plugin 安装目录先不跟 workdir 迁移，避免用户在不同项目重复安装同一 capability。
- 浏览器 session 先保留全局，避免同站点登录态被工作区切分。若后续需要项目级浏览器 session，再单独加 `browserSessionRoot`。

### 下一步可交付

- 优先级 1：连接级收敛
  - 在断连场景明确队列内待执行的 `studio_request` 处理策略（默认快速失败）。
  - 增加本地集成测试：断连后不会继续执行尚未开始的排队请求。
- 优先级 2：可观测性
  - `/runtime` 暴露 `studio_config_source`、`studio_config_active_path`、`legacy_studio_config_path`。
  - 记录 `studio_request` 入队/出队时延与 `interrupted`、`failed` 明细。
- 优先级 3：Scheduler 落地前置
  - 在 App/API 侧约定 `studio_due_runs` 的 `idempotencyKey` 唯一键与重试行为。
  - 使用 `workdir` 做任务路由分层，避免不同工作区交叉执行 side effect。

## 推荐决策

短期推荐采用“服务进程级 effective workdir”：

```text
one local-agent process -> one effective workdir -> one Workdir State Root
```

这已经满足当前需求，并且改动可控。等 App/API 需要一个进程同时承载多个 workspace 时，再升级到 per-run runtime config。届时普通 pet runtime 和 Studio runtime 的接口不用大改，只需要把 `LocalAgentRuntimeConfig` 从进程级依赖变成每次 run 的输入。
