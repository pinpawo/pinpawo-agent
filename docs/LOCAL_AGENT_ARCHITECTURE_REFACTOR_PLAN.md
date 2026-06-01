# Local Agent Architecture Refactor Plan

> 状态：Draft v1
> 日期：2026-05-29

## 1. 文档目标

这份文档用于对齐 `services/local-agent/` 的重构方向。当前先不继续改实现，先明确边界、事件模型和迁移步骤。

local-agent 的定位是：

- 运行在用户电脑上的本地 agent host。
- 连接 app / TUI / macOS companion 等客户端。
- 装配本地 tools、toolkits、capabilities、LLM config 和用户本地状态。
- 对外输出稳定的 local-agent 事件，而不是泄漏 agent 框架内部事件。

这份文档重点解决三个问题：

1. local-agent 的分层边界应该是什么。
2. app / TUI 应该消费什么事件。
3. tool/capability 的展示语义应该由谁定义。

## 2. 当前问题

当前代码能跑，但结构已经不适合继续堆功能。

### 2.1 对外协议泄漏内部 tool call

当前 `localAgentProtocol.ts` 对外暴露：

```ts
{
  type: 'tool_log',
  phase: 'start' | 'event' | 'end' | 'error',
  toolName: string,
  input?: string,
  output?: string,
  error?: string
}
```

这会让 app / TUI 被迫理解内部 `read_file`、`grep_search`、`run_shell` 等工具名和输入输出结构。

问题不在于 formatter 放在哪个文件，而是协议层没有稳定的 local-agent event。只要协议仍然暴露内部 tool call，presentation 层就会自然变成内部工具 formatter。

### 2.2 local-agent 承担了过多职责

目前 local-agent 同时包含：

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

- TUI：渲染成紧凑文本、active tool line、system message。
- App：渲染成结构化 run state、pet gif、compact activity strip。
- Logs/debug：保留 JSON。

adapter 可以有自己的 i18n / copy，但不能重新解析内部 tool input/output。

### 3.4 协议采用 `type: 'event'`，旧消息只做兼容

新协议使用统一 server message：

```ts
type LocalAgentEventMessage = {
  type: 'event';
  requestId: string;
  event: LocalAgentEvent;
};
```

旧消息短期保留，但只作为兼容层：

- `tool_log`
- `chat_token`
- `chat_response`
- `human_interrupt`
- `studio_turn_event`

这些 legacy messages 在代码里需要明确标注 `@deprecated compatibility only`。等 app / TUI / macOS companion 全部切到 `type: 'event'` 后删除。

迁移策略：

1. 新增 `LocalAgentEvent`。
2. runtime / server 内部优先产出 `LocalAgentEvent`。
3. TUI 本地链路直接消费 `type: 'event'`。
4. app/API 旧链路在发送出口由 `LocalAgentEvent` 派生 legacy messages。
5. 全部客户端迁移完成后删除 legacy messages。

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
    LegacyProtocolAdapter.ts

  protocol/
    clientMessages.ts
    serverMessages.ts
    codec.ts
    compatibility.ts

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

astream tools
  -> LocalAgentEvent operation

astream values __interrupt__
  -> LocalAgentEvent human_review.requested

studio runtime progress
  -> LocalAgentEvent studio.progress
```

兼容输出是独立的发送层行为：PinPet app/API 旧路径尚未完成 `LocalAgentEvent` 迁移前，可以由 `LocalAgentEvent` 派生 `chat_token` / `chat_response` / `tool_log` / `human_interrupt` / `studio_turn_event`。TUI 本地路径不应依赖这些 legacy messages。

原则：

- LangGraph stream 是 runtime internal API。
- `LocalAgentEvent` 是 local-agent 对 app/TUI/macOS companion 的 public event API。
- legacy messages 只能从 `LocalAgentEvent` 派生，不能继续作为 primary event model。

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
- `title` / `target` / `summary` 是已经归一化后的展示信息，adapter 可以直接使用。
- `source` 只用于 debug 和兼容，不应该成为 UI 主要判断依据。
- `raw` 默认不面向普通 UI，可用于 debug、日志或兼容层。

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
  resolveTool(name: string): OperationMetadata | null;
};
```

重要约束：

- local-agent 可以为内置 local toolkit 提供 metadata。
- 第三方/user capability 可以提供自己的 metadata。
- 没有 metadata 时，local-agent 生成 generic operation：`kind: 'tool.execute'`，`title: toolName`。
- adapter 不应该回退解析 raw input/output。

## 7. 迁移阶段

### 阶段 0：冻结现状

目标：明确当前行为，避免重构时破坏 app/TUI。

工作项：

- 记录当前 websocket server messages。
- 给 legacy `tool_log`、`chat_token`、`chat_response`、`human_interrupt` 补 baseline tests。
- 明确 app 当前依赖哪些字段。
- 明确 TUI 当前依赖哪些字段。

产出：

- 协议样例文档。
- baseline tests。

### 阶段 1：引入事件模型，不改变对外协议

目标：新增 `LocalAgentEvent` 和 normalizer，并开始输出 `type: 'event'`。legacy protocol 同时保留。

工作项：

- 新增 `events/LocalAgentEvent.ts`。
- 新增 `events/OperationRegistry.ts`。
- 新增 `events/AgentStreamNormalizer.ts`。
- 新增 `protocol/LegacyProtocolAdapter.ts`，从 `LocalAgentEvent` 派生 legacy messages。
- 运行链路改为走 `astream tools -> LocalAgentOperationEvent`，legacy `tool_log` 只从 compatibility adapter 派生。
- 内置 local tools 注册 operation metadata。
- `localAgentProtocol.ts` 中 legacy server message 类型加 `@deprecated compatibility only` 注释。

约束：

- 不改 app/TUI 行为。
- 不删除 `tool_log`。
- 不让 legacy messages 继续成为 primary event model。
- 不让 presentation 直接读内部 toolName。

### 阶段 2：TUI 切到 LocalAgentEvent

目标：TUI 不再对内部 toolName 做 formatter。

工作项：

- TUI 本地 server 只发送 `type: 'event'` agent run activity。
- TUI active tool state 消费 `operation.title/target/summary`。
- 删除或降级当前面向 toolName 的 presentation registry。

产出：

- `commands/tui.tsx` 只处理 TUI 状态和输入。
- `adapters/tui/renderEvent.ts` 面向 `LocalAgentEvent`。

### 阶段 3：App/API 切到 LocalAgentEvent

目标：app 不再依赖 `tool_log`。

工作项：

- app websocket/API 输出 typed local-agent events。
- app run state 基于 `message.delta`、`operation.*`、`human_review.requested`。
- 旧 SSE/WS `tool_log/chat_token/chat_response/human_interrupt` 保持一段兼容期，并继续标注为 deprecated。

产出：

- app 和 TUI 共享同一事件语义。

### 阶段 4：拆分 server/runtime

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

目标：删除过渡层。

工作项：

- 删除或 debug-only 化 legacy `tool_log/chat_token/chat_response/human_interrupt/studio_turn_event`。
- 删除面向内部 toolName 的 formatter。
- 清理 `chatInterface.ts` 中 thread id 推断能力的逻辑。
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
8. `cleanup: remove legacy tool formatter and tool_log dependency`

每个 PR 都必须保持：

- `npm run typecheck -w pinpawo-local-agent`
- `npm run test:unit -w pinpawo-local-agent`
- `npm run build -w pinpawo-local-agent`

## 9. 非目标

这次重构不应该顺手做这些事：

- 不重写 pet-agent orchestrator。
- 不改变 capability/subagent 的核心执行模型。
- 不一次性删除 legacy protocol。
- 不把 app UI 重写和 local-agent 重构混在同一个 PR。
- 不把所有工具语义写进 local-agent 的全局枚举。

## 10. 待确认问题

已确认：

1. 新协议新增 `type: 'event'` message，并保留旧 message 并行兼容。
2. legacy `tool_log/chat_token/chat_response/human_interrupt/studio_turn_event` 要在代码里标注 compatibility only，等其他部分改造完成后删除。
3. LangGraph `astream` 的 `messages/tools/values` 只作为 internal stream source，不能作为 app/TUI public protocol。

仍待确认：

1. app 是否需要接收 `raw.input/output`，还是只在 debug mode 开启。
2. operation metadata 应该挂在 toolkit runtime、tool wrapper，还是 local-agent host registry。
3. user capability 的 metadata manifest 形态是否需要进入公开 capability contract。
4. i18n 是 metadata 直接给 `title`，还是给 `titleKey` 由 adapter locale 渲染。
