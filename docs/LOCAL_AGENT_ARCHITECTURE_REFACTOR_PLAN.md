# Local Agent Architecture Refactor Plan

> 状态：Draft v2
> 日期：2026-05-29
> 更新：local-agent runtime/TUI/app-facing WS 出口已经切到 `LocalAgentEvent` / `operation` first；本仓库不再派发旧运行态兼容消息。剩余跨仓库迁移见 issue #19。

## 1. 文档目标

这份文档用于对齐 `services/local-agent/` 的重构方向，明确边界、事件模型和迁移步骤。

local-agent 的定位是：

- 运行在用户电脑上的本地 agent host。
- 连接 app / TUI / macOS companion 等客户端。
- 装配本地 tools、toolkits、capabilities、LLM config 和用户本地状态。
- 对外输出稳定的 local-agent 事件，而不是泄漏 agent 框架内部事件。

这份文档重点解决三个问题：

1. local-agent 的分层边界应该是什么。
2. app / TUI 应该消费什么事件。
3. tool/capability 的展示语义应该由谁定义。

## 2. 历史问题与剩余风险

重构前代码能跑，但结构不适合继续堆功能。PR #18 已解决 agent run activity 主链路的事件模型问题；以下问题用于说明设计动机和仍待收敛的风险。

### 2.1 对外协议曾泄漏内部 tool call

旧协议曾直接对外暴露工具名、工具输入输出和工具生命周期。这会让 app / TUI 被迫理解内部 `read_file`、`grep_search`、`run_shell` 等工具名和输入输出结构。

问题不在于 formatter 放在哪个文件，而是协议层没有稳定的 local-agent event。只要协议仍然暴露内部 tool call，presentation 层就会自然变成内部工具 formatter。当前 local-agent runtime/TUI/app-facing WS 已改为 `LocalAgentEvent` / `operation`；本仓库不再保留 legacy wire compatibility layer。

### 2.2 local-agent 承担了过多职责

local-agent 仍然包含多类职责：

- CLI/TUI command
- websocket/http server
- chat runtime
- studio bridge
- capability loading / rescan
- local tools implementation
- human review / interrupt
- protocol parsing
- presentation formatting

这些职责分散在少量大文件里，尤其是 `localServer.ts`、`runtime.ts`、`commands/tui.tsx`、`plugins/localTools.ts`，边界不够清楚。

### 2.3 endpoint 能力渗入工具运行层

当前 `chatInterface.ts` 通过 thread id 推断 `tui` / `app-chat`，再决定是否支持 human review、session authorization。

这说明“客户端类型”和“工具执行策略”已经耦合。长期看，接口能力应该由 session/interface context 显式提供，而不是通过 thread id 字符串推断。

### 2.4 presentation 不是根因

把 `commands/tuiFormatters.ts` 移到 `presentation/` 只能降低 TUI 文件复杂度，但不能解决根本问题。

真正要建立的是：

```txt
agent runtime/internal stream
  -> local-agent event normalizer
  -> LocalAgentEvent
  -> protocol serializer
  -> app / TUI adapters
```

presentation 只能面向 `LocalAgentEvent`，不能面向内部 toolName。

## 3. 设计原则

### 3.1 local-agent 拥有 event envelope，不拥有所有工具语义

local-agent 可以定义稳定的事件外壳：

```ts
type LocalAgentEvent = {
  type: string;
  requestId: string;
  timestamp?: string;
}
```

local-agent 不应该维护全局固定的工具语义枚举，例如：

```ts
type LocalAgentOperationKind =
  | 'file.read'
  | 'file.write'
  | 'search.grep'
  | 'shell.run';
```

这会把 local-agent 变成“所有 tools/capabilities 语义的中央表”，和当前 formatter 知道内部工具名的问题本质相同。

### 3.2 toolkit / capability 拥有 operation metadata

工具展示语义应该由提供工具的一方声明。

对于内置 toolkit：

```ts
const bashToolkit = {
  name: 'bash',
  tools: [readFileTool, grepSearchTool, runShellTool],
  operations: {
    read_file: {
      kind: 'file.read',
      title: '读文件',
      summarizeInput: (input) => ({ target: input.path }),
    },
    grep_search: {
      kind: 'search.grep',
      title: '搜内容',
      summarizeInput: (input) => ({
        target: input.path,
        summary: input.query,
      }),
    },
  },
};
```

对于用户 capability：

```ts
const capability = {
  name: 'calendar',
  createRuntime: () => ({
    tools: [createCalendarEventTool],
    operations: {
      create_calendar_event: {
        kind: 'calendar.event.create',
        title: '创建日程',
        summarizeInput: (input) => ({ summary: input.title }),
      },
    },
  }),
};
```

local-agent 只负责收集这些 metadata，建立 registry：

```txt
toolName -> operation metadata
```

然后把内部 tool event normalize 成 stable local-agent event。

### 3.3 adapter 拥有渲染

不同客户端可以消费同一个事件，但渲染不同。

- TUI：渲染成紧凑文本、active operation line、system message。
- App：渲染成结构化 run state、pet gif、compact activity strip。
- macOS companion：通过 `/health` 读取 agent run 和 active operation 摘要，pet 动画按 `operation.kind/title/target/summary` 映射。
- Logs/debug：保留 JSON。

adapter 可以有自己的 i18n / copy，但不能重新解析内部 tool input/output。

### 3.4 协议采用 `type: 'event'`，旧消息不再作为本仓库协议

新协议使用统一 server message：

```ts
type LocalAgentEventMessage = {
  type: 'event';
  requestId: string;
  event: LocalAgentEvent;
};
```

旧运行态消息已经从本仓库 wire protocol 中移除，并且不再作为本仓库的兼容输出。若 app/API 仍有依赖，应在 `pinpawo-app` 仓库迁移到 `type: 'event'` envelope，而不是在本仓库恢复兼容层。

当前迁移边界：

1. runtime / server 内部产出 `LocalAgentEvent`。
2. TUI 本地链路直接消费 `type: 'event'`。
3. app-facing WS 发送出口只发送 `LocalAgentEvent`。
4. app/API 在 `pinpawo-app` 仓库消费新 envelope 并完成端到端验证。

## 4. 目标分层

建议最终结构：

```txt
services/local-agent/src/
  core/
    LocalAgentRuntime.ts
    ChatSessionService.ts
    CapabilityRegistry.ts
    InterfaceSession.ts
    HumanReviewBroker.ts

  events/
    LocalAgentEvent.ts
    AgentStreamNormalizer.ts
    OperationRegistry.ts

  protocol/
    clientMessages.ts
    serverMessages.ts
    codec.ts

  server/
    httpServer.ts
    websocketServer.ts
    routes/
      health.ts
      capabilities.ts
      chat.ts

  adapters/
    tui/
      TuiApp.tsx
      renderEvent.ts
      inputController.ts
      interruptSelector.tsx
    app/
      appEventAdapter.ts

  tools/
    local/
      fileTools.ts
      searchTools.ts
      shellTool.ts
      networkTools.ts
    policy/
      shellPolicy.ts
      reviewPolicy.ts

  studio/
    studioRuntime.ts
    studioBridge.ts
    studioConfig.ts
```

这不是要求一次性搬完，而是后续 PR 的目标方向。

## 5. LocalAgentEvent 草案

事件 envelope 由 local-agent 定义，operation 语义开放。

```ts
type LocalAgentEvent =
  | LocalAgentRunEvent
  | LocalAgentMessageEvent
  | LocalAgentOperationEvent
  | LocalAgentHumanReviewEvent
  | LocalAgentStudioEvent
  | LocalAgentSystemEvent;
```

### 5.0 LangGraph stream 到 LocalAgentEvent 的映射

local-agent 内部可以参考 LangGraph `astream` 的返回形态，但不能把它原样暴露给客户端。

当前 chat session 已经消费这些 stream mode：

```txt
messages -> assistant token stream
tools    -> tool start/event/end/error
values   -> final graph state 或 interrupt state
```

目标映射：

```txt
astream messages
  -> LocalAgentEvent message.delta

astream values final messages
  -> LocalAgentEvent message.completed

pet/subagent onToolEvent
  -> LocalAgentEvent operation

astream values __interrupt__
  -> LocalAgentEvent human_review.requested

studio runtime progress
  -> LocalAgentEvent studio.progress
```

local-agent 对外只发送 `LocalAgentEvent` envelope。`pinpawo-app` app/API 旧路径需要在 app 仓库迁移到该 envelope 后再对接；本仓库不再从 `LocalAgentEvent` 派生旧运行态消息。

原则：

- LangGraph stream 是 runtime internal API。
- `LocalAgentEvent` 是 local-agent 对 app/TUI/macOS companion 的 public event API。
- `sendLocalAgentMessage` 和 `sendLocalAgentEvent` 不接受 legacy 输出开关。
- `parseLocalAgentServerMessage` 只解析新协议 event/control message；local-agent 不再提供通用 legacy server message parser，避免 TUI 或新客户端重新依赖 legacy wire shape。

### 5.1 Operation event

```ts
type LocalAgentOperationEvent = {
  type: 'operation';
  requestId: string;
  phase: 'started' | 'updated' | 'completed' | 'failed' | 'interrupted';
  operation: {
    id?: string;
    kind: string;
    title?: string;
    target?: string;
    summary?: string;
    details?: Record<string, unknown>;
    source?: {
      provider: 'toolkit' | 'capability' | 'runtime';
      name: string;
      callId?: string;
    };
  };
  raw?: {
    input?: unknown;
    output?: unknown;
    error?: unknown;
  };
};
```

说明：

- `kind` 是开放字符串，由 toolkit/capability metadata 提供。
- pet-agent subagent 层通过 `SubagentToolEventTracker` 规范 `onToolEvent` 的 `toolCallId`，并在 subagent 自然完成、limit reached、异常时关闭仍 active 的 tool event。
- local-agent 运行层通过 `ToolOperationTracker` 保证发给客户端的 operation 有稳定 `id`；当上游缺失 `toolCallId` 时按 request 生成 synthetic id。
- request 正常完成、异常、中断或等待人工时，tracker 会关闭仍 active 的 operation，避免客户端 `activeOperations` 泄漏。
- `title` / `target` / `summary` 是已经归一化后的展示信息，adapter 可以直接使用。
- `source` 只用于 debug 和兼容，不应该成为 UI 主要判断依据。
- `raw` 默认不面向普通 UI，可用于 debug、日志或诊断。

### 5.2 Chat message event

```ts
type LocalAgentMessageEvent =
  | {
      type: 'message.delta';
      requestId: string;
      role: 'assistant';
      text: string;
    }
  | {
      type: 'message.completed';
      requestId: string;
      role: 'assistant';
      text: string;
      metadata?: {
        mood?: string | null;
        topic?: string | null;
        tags?: string[];
      };
    };
```

### 5.3 Human review event

```ts
type LocalAgentHumanReviewEvent = {
  type: 'human_review.requested';
  requestId: string;
  prompt: string;
  payload: Record<string, unknown>;
  actor?: {
    petId?: string;
  };
};
```

### 5.4 Studio event

Studio event 也应该走 local-agent event envelope。短期可以包一层：

```ts
type LocalAgentStudioEvent = {
  type: 'studio.progress';
  requestId: string;
  event: Record<string, unknown>;
};
```

后续如果 Studio 事件稳定，再细分成 `studio.plan_set`、`studio.dispatch_started` 等 typed event。

## 6. Operation Metadata 草案

operation metadata 由 toolkit / capability 暴露。

```ts
type OperationMetadata = {
  kind: string;
  title?: string;
  titleKey?: string;
  summarizeInput?: (input: unknown) => OperationSummary | null;
  summarizeOutput?: (output: unknown) => OperationSummary | null;
  summarizeError?: (error: unknown) => OperationSummary | null;
};

type OperationSummary = {
  target?: string;
  summary?: string;
  details?: Record<string, unknown>;
};
```

Registry 由 local-agent 建立：

```ts
type OperationRegistry = {
  resolveToolOperation(toolName: string): OperationMetadata | null;
};
```

重要约束：

- local-agent 可以为内置 local toolkit 提供 metadata。
- 第三方/user capability 可以提供自己的 metadata。
- 没有 metadata 时，local-agent 生成 generic operation：`kind: 'tool.execute'`，`title: toolName`。
- adapter 不应该回退解析 raw input/output。

## 7. 迁移阶段

### 阶段 0：冻结现状

状态：已完成。

目标：明确当时行为，避免重构时破坏 app/TUI。旧协议 baseline tests 已在 wire compatibility 删除后移除，保留 `parseLocalAgentServerMessage` 拒绝旧消息的回归测试。

工作项：

- 记录当前 websocket server messages。
- 明确 app 旧实现依赖哪些字段。
- 明确 TUI 旧实现依赖哪些字段。

产出：

- 协议样例文档。
- baseline tests。

### 阶段 1：引入事件模型并切换 local-agent 出口

状态：已完成。runtime 主链路产出 `LocalAgentEvent`。

目标：新增 `LocalAgentEvent` 和 normalizer，并开始输出 `type: 'event'`。

工作项：

- 新增 `events/LocalAgentEvent.ts`。
- 新增 `events/OperationRegistry.ts`。
- 新增 `events/AgentStreamNormalizer.ts`。
- 运行链路改为走 `onToolEvent -> LocalAgentOperationEvent`，chat 顶层 stream 不再订阅 `tools` mode。
- 内置 local tools 注册 operation metadata。

约束：

- 不让 legacy messages 继续成为 primary event model。
- 不让 presentation 直接读内部 toolName。

### 阶段 2：TUI 切到 LocalAgentEvent

状态：已完成。TUI 本地路径消费 `LocalAgentEvent`，operation activity 使用 `operation` 展示语义。

目标：TUI 不再对内部 toolName 做 formatter。

工作项：

- TUI 本地 server 只发送 `type: 'event'` agent run activity。
- TUI active operation state 消费 `operation.title/target/summary`。
- 删除或降级当前面向 toolName 的 presentation registry。

产出：

- `commands/tui.tsx` 只处理 TUI 状态和输入。
- `adapters/tui/renderEvent.ts` 面向 `LocalAgentEvent`。

### 阶段 3：App/API 切到 LocalAgentEvent

状态：本仓库侧已完成 local-agent 发送出口切换；`pinpawo-app` app/API 仍需要迁移，见 issue #19。

迁移仓库：`~/Develop/src/pinpawo/pinpawo-app`。本仓库只维护 local-agent 新协议和迁移说明；app/API 代码迁移在 `pinpawo-app` 侧单独推进。

目标：app 不再依赖旧运行态消息，只消费 `LocalAgentEvent` envelope。

工作项：

- app websocket/API 消费 typed local-agent events。
- app run state 基于 `message.delta`、`operation.*`、`human_review.requested`。

产出：

- app 和 TUI 共享同一事件语义。

### 阶段 4：拆分 server/runtime

状态：进行中。已抽出 shared inflight operation run lifecycle，`localServer.ts` 和 `runtime.ts` 不再各自直接维护 `ToolOperationTracker` 创建、operation activity 记录和 dangling operation 收尾。`localServer.ts` 的 tool stream 到 operation 事件发送逻辑已拆为 server adapter，并有专项测试覆盖单次 emit 与 human review interrupt 转换。Studio human review response routing 已抽为独立 router，WS server 只负责调用路由器和连接生命周期清理。TUI session/history orchestration 已抽为 `LocalServerTuiSessionService`，`localServer.ts` 不再直接持有 session registry、history summary 或 checkpoint reset 细节。app WS 与 TUI local server 的 inflight request replace/interrupt/cleanup 逻辑已收敛为 `InflightRequestController`，避免两条路径各自维护 request slot、interrupt timer 和 terminal operation 收尾。local TUI WebSocket parse/dispatch/connect/close 逻辑已抽为 `attachLocalServerWebSocketTransport`，`localServer.ts` 通过 callbacks 连接 transport 与 chat/studio handlers。TUI chat request execution、`/allow` 授权、human-review fallback 和 tool-protocol recovery 已抽为 `LocalServerChatHandler`。Studio turn execution、Studio HITL routing 和 disconnect cleanup 已抽为 `LocalServerStudioHandler`。app-facing WebSocket connect/ping/reconnect/message dispatch 已抽为 `LocalAgentAppWsClient`，app chat request execution、checkpoint reset、thread routing 和 app operation emit 已抽为 `LocalAgentAppChatHandler`，scheduled heartbeat / next-tick / crawler / daily post execution 和 run stats 已抽为 `LocalAgentScheduledJob`，`runtime.ts` 不再直接持有 app WS timer、parser dispatch、app chat execution 或 scheduled post execution 细节。

目标：把 transport、session orchestration、runtime execution 分离。

工作项：

- `localServer.ts` 拆出 websocket server、HTTP routes、chat handlers。
- `runtime.ts` 收敛为 runtime/session service。
- human review broker 从 TUI/app 逻辑中独立。
- interface capabilities 从 thread id 推断改为 session context 显式传入。

产出：

- server 只处理 transport。
- runtime 不关心具体客户端。

### 阶段 5：拆分 tools/policy/capability registry

目标：让 local tools 和 capability 管理可维护。

工作项：

- `plugins/localTools.ts` 拆成 file/search/shell/network。
- shell policy 从 tool implementation 中拆出。
- capability loader/rescan/runtime state 收敛进 registry。
- toolkit/capability operation metadata 与工具注册一起装配。

产出：

- 工具实现、权限、人类审批、展示 metadata 分离。

### 阶段 6：清理 legacy

状态：本仓库 wire protocol 兼容层已清理；本阶段剩余工作集中在 app 仓库迁移验证、历史数据迁移代码确认、文档表述收敛、内部 formatter 和 interface context 收敛。

目标：删除过渡层。

工作项：

- 确认 app/API 不再引用旧运行态消息。
- 删除面向内部 toolName 的 formatter 或降级为 debug-only。
- 清理通过 thread id 推断 endpoint capability 的逻辑，改为显式 interface context。
- 更新 AGENTS.md 和开发文档。

## 8. PR 拆分建议

建议不要做一个大 PR。

推荐拆分：

1. `docs: add local-agent architecture refactor plan`
2. `events: introduce LocalAgentEvent and operation registry`
3. `events: normalize LangGraph astream events and emit type:event`
4. `tui: render operation events instead of internal tool logs`
5. `protocol: expose typed local-agent events for app`
6. `server: split websocket/http handlers from runtime`
7. `tools: split local tools and register operation metadata`
8. `cleanup: remove legacy tool formatter and old protocol references`

每个 PR 都必须保持：

- `npm run typecheck -w pinpawo-local-agent`
- `npm run test:unit -w pinpawo-local-agent`
- `npm run build -w pinpawo-local-agent`

## 9. 非目标

这次重构不应该顺手做这些事：

- 不重写 pet-agent orchestrator。
- 不改变 capability/subagent 的核心执行模型。
- 不在本仓库恢复旧协议兼容输出。
- 不把 app UI 重写和 local-agent 重构混在同一个 PR。
- 不把所有工具语义写进 local-agent 的全局枚举。

## 10. 待确认问题

已确认：

1. 新协议使用 `type: 'event'` message，agent run activity 以 `LocalAgentEvent` 为 primary event model。
2. local-agent 不再发送旧运行态消息；`pinpawo-app` app/API 迁移是剩余跨仓库工作。
3. LangGraph `astream` 的 `messages/tools/values` 只作为 internal stream source，不能作为 app/TUI public protocol。

仍待确认：

1. app 是否需要接收 `raw.input/output`，还是只在 debug mode 开启。
2. operation metadata 应该挂在 toolkit runtime、tool wrapper，还是 local-agent host registry。
3. user capability 的 metadata manifest 形态是否需要进入公开 capability contract。
4. i18n 是 metadata 直接给 `title`，还是给 `titleKey` 由 adapter locale 渲染。
