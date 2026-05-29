# Local Agent TUI Architecture

> 状态：Draft v1
> 日期：2026-05-29

## 1. 文档目标

这份文档用于对齐 `services/local-agent/` 中 TUI 的后续重构方向。当前基线是：TUI 以 `type: 'event'` 的 `LocalAgentEvent` 作为 agent run activity 的主事件输入。

后续重构先明确以下设计事实，再进入拆分实现：

1. TUI 在 local-agent 架构中的职责边界。
2. TUI 如何消费 `LocalAgentEvent`，以及如何维护自己的 UI 状态。
3. app / TUI / macOS companion 未来共享哪些协议与运行态语义。
4. command、keymap、composer、approval、history、status、diff 等模块应如何分阶段落地。

本文中的 agent 指 local-agent 中运行的 agent runtime / studio runtime / capability runtime 组合。TUI 和 app 都是这个本机 agent host 的客户端。

架构参考：

- 本文参考的是 OpenAI Codex 开源仓库中的 [`codex-rs/tui`](https://github.com/openai/codex/tree/main/codex-rs/tui) 和 [`codex-rs/tui/src`](https://github.com/openai/codex/tree/main/codex-rs/tui/src)。
- 参考重点是模块边界：bottom pane、composer、keymap、slash command、history cell、status、approval、resume picker、diff renderer 等 terminal client 能力被拆成独立模块。
- PinPawo 沿用自己的 TypeScript / Ink 技术栈和 local-agent 协议；Codex Rust 实现只作为 terminal client 分层参考。

## 2. 当前基线

当前 TUI 入口是：

```txt
services/local-agent/src/commands/tui.tsx
```

当前已具备：

- WebSocket 连接 local-agent server。
- 支持 chat / studio 请求。
- 消费 `LocalAgentEventMessage`：
  - `message.delta`
  - `message.completed`
  - `operation`
  - `human_review.requested`
  - `studio.progress`
  - `system.notice`
  - `error`
- 支持 `interrupting` / `interrupted` / `studio_response` / `studio_error` 这些 session control message。
- 有基础 input、slash commands、active tool line、system message、interrupt selector。

当前重构入口：

- `commands/tui.tsx` 聚合了连接、协议处理、状态维护、输入、命令、按键、渲染、布局和 HITL 选择器。
- `commands/tuiEventRenderer.ts` 已经面向 `LocalAgentEvent`，后续适合移动到 TUI render adapter 边界内。
- slash command 适合收敛为 registry，统一承载 help metadata、enabled state 和补全入口。
- key handling 适合收敛为 keymap，统一表达 global、composer、approval 三类快捷键。
- message history、active operation、pending review、studio mode、connection state 适合收敛为统一的 TUI state model。
- formatter 目前是 TUI 临时文本渲染。后续可以演进为 TUI render adapter，并与 app 的移动端 run state 保持同一事件语义。

## 3. 设计原则

### 3.1 TUI 是 local-agent 的 terminal client

TUI 是 local-agent 的 terminal client。它负责终端交互、键盘输入、布局、历史展示和当前运行态展示。

```txt
agent runtime / studio runtime / capability runtime
  -> LocalAgentEvent
  -> local-agent protocol
  -> TUI client
  -> terminal UI state
  -> Ink components
```

TUI 的输入边界：

- `LocalAgentEvent`
- local-agent server message
- TUI 自己的 UI state
- terminal 输入和布局

以下信息属于 local-agent normalizer 上游输入，进入 TUI 前会收敛为 `LocalAgentEvent`：

- pet-agent 内部节点名
- LangGraph stream 原始结构
- 具体 tool 的 raw input/output 结构
- capability 内部实现细节

### 3.2 LocalAgentEvent 是协议边界

`LocalAgentEvent` 是 local-agent 对 app / TUI / macOS companion 的 public event API。它是 agent run 对外可观察状态的稳定边界，负责承载 assistant token、最终回复、operation、human review、studio progress、system notice 和 error。

统一流向：

```txt
pet-agent runtime / studio runtime / capability runtime
  -> local-agent event normalizer
  -> LocalAgentEvent
      -> local-agent WebSocket
          -> TUI
      -> API-facing adapter / bridge
          -> app API stream
          -> mobile app
      -> macOS companion adapter
          -> desktop companion
```

### 3.3 Agent 到 TUI

TUI 路径是本机直连路径：

```txt
local-agent runtime
  -> LocalAgentEventMessage { type: 'event', requestId, event }
  -> WebSocket ws://127.0.0.1:<localServerPort>
  -> TUI state
  -> Ink UI
```

TUI 可以额外处理少量 control message，例如 `interrupting`、`interrupted`、`studio_response`、`studio_error`。这些 control message 表示 transport/session 控制结果，`LocalAgentEvent` 仍然是 agent run activity 的主事件模型。

### 3.4 Agent 到 API 到 App

app 路径通过 API-facing adapter / bridge 转发：

```txt
local-agent runtime
  -> LocalAgentEvent
  -> API-facing adapter / bridge
  -> app API stream envelope
  -> mobile app run state
```

API 层负责用户、pet、session、鉴权和网络 envelope。它可以把 `LocalAgentEvent` 包进 HTTP/SSE/WS 响应格式，但应保留这些语义字段：

- `requestId`
- `event.type`
- `message.delta` / `message.completed`
- `operation.phase`
- `operation.kind` / `title` / `target` / `summary`
- `human_review.requested`
- `system.notice`
- `error`

这样 TUI 和 app 可以拥有不同 UI，但对 agent run 的理解保持一致。

### 3.5 LocalAgentEvent 协议约束

`LocalAgentEvent` 作为边界协议时，需要保持这些约束：

- `type: 'event'` 是 agent run activity 的统一 server message envelope。
- `requestId` 贯穿 TUI 直连路径和 API 转发路径，用于忽略迟到事件、关联 interrupt / approval / final response。
- `event.type` 是客户端分发的 discriminant，命名进入协议后按版本策略演进。
- `message.delta` 表示 assistant token 增量，`message.completed` 表示本轮 assistant 最终文本。
- `operation` 表示工具、capability 或 runtime activity，`phase` 表示生命周期，`operation` 字段承载展示摘要。
- `human_review.requested` 表示 agent 主动等待用户确认或补充，approval UI 和 app HITL UI 都基于它进入 waiting_human。
- token usage / context usage 是 session 级可观测数据，可以通过 message metadata 或后续独立 usage event 进入 TUI/app 状态。
- API 层可以包一层自己的 HTTP/SSE/WS envelope，但保留 `LocalAgentEvent` 的事件语义。

### 3.6 Operation 展示语义

原则：

- `operation.title` / `target` / `summary` 是 adapter 可直接消费的展示语义。
- `operation.source` 和 `raw` 面向 debug、日志或诊断场景。
- 某个工具需要更好的展示文案时，由 toolkit / capability operation metadata 提供 `kind`、`title`、`target`、`summary` 和 `details`。

### 3.7 UI reducer 是 TUI 状态 reducer

后续如果引入 reducer，文档中统一使用 `tuiStateReducer.ts` 作为建议命名。这个命名强调 reducer 的输入可以包含 local-agent event、control message 和用户输入动作，输出是 TUI state。

```txt
tuiStateReducer.ts
```

它的职责是把 local-agent event、control message 和用户输入动作合并成 TUI state：

```txt
LocalAgentEvent / ServerControlMessage / UserInputAction
  -> TuiAction
  -> TuiState
```

职责边界：

- WebSocket JSON 解析属于 protocol/controller。
- 协议版本适配属于 protocol adapter。
- agent runtime stream normalization 属于 local-agent event normalizer。
- terminal 文案格式化属于 TUI render adapter。

### 3.8 多端共享事件语义，各端拥有自己的展示

app / TUI / macOS companion 可以共享：

- `LocalAgentEvent` 类型。
- operation metadata 语义。
- active run 阶段模型。
- approval / interrupt 的结构化协议。

各端各自拥有：

- 终端专用 copy。
- Ink layout。
- TUI slash commands。
- 终端快捷键。
- app gif / compact activity strip / mobile copy。
- macOS companion 的菜单栏、窗口和通知行为。

如果后续抽出共享展示层，优先抽象成 run presentation model 或 activity model。TUI formatter 保持 terminal adapter 定位。

## 4. 建议目标结构

短期建议聚焦整理 TUI 目录，server/runtime 拆分保留给 local-agent 架构阶段：

```txt
services/local-agent/src/
  commands/
    tui.tsx                  # thin entry: actor selection + render TuiApp

  tui/
    TuiApp.tsx               # app shell: compose hooks/components
    TuiRuntimeController.ts  # websocket/http side effects, send commands

    state/
      tuiState.ts            # TuiState / TuiAction types
      tuiStateReducer.ts     # local-agent events + UI actions -> TuiState
      selectors.ts           # derived display state

    input/
      commandRegistry.ts     # slash commands, help, enabled state
      keymap.ts              # global/composer/approval key bindings
      composerModel.ts       # cursor, history navigation, paste handling

    render/
      eventToActivity.ts     # LocalAgentEvent -> TUI activity/update
      operationText.ts       # terminal text for normalized operation fields
      studioText.ts          # terminal text for studio.progress
      copy.zh-CN.ts          # TUI copy keys, later可扩 i18n

    components/
      MessageHistory.tsx
      HistoryCell.tsx
      Composer.tsx
      StatusLine.tsx
      ActiveOperations.tsx
      ApprovalPanel.tsx
      ConnectionNotice.tsx

    session/
      historyAdapter.ts      # load / restore / new session UI state bridge
```

关键约束：

- `commands/tui.tsx` 最终收敛为 CLI entry。
- `tui/render/*` 面向 normalized event fields。
- `tui/state/*` 保持纯状态计算。
- `TuiRuntimeController` 负责 local-agent server 通信和发送 client message。

## 5. TUI State 草案

建议 TUI state 明确区分“历史消息”和“当前运行态”：

```ts
type TuiState = {
  connection: {
    status: 'initializing' | 'connecting' | 'ready' | 'disconnected' | 'error';
    message: string;
  };
  actor: {
    petName: string;
    petSummary: string;
  };
  session: {
    mode: 'chat' | 'studio';
    studioConversationId?: string;
    tokenUsage: {
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      contextWindow?: number;
      updatedAt?: string;
    } | null;
  };
  history: HistoryCellModel[];
  activeRun: null | {
    requestId: string;
    phase: 'thinking' | 'using_tool' | 'streaming' | 'waiting_human' | 'interrupting';
    assistantDraft: string;
    activeOperations: ActiveOperationModel[];
    pendingReview?: ApprovalRequestModel;
    startedAt: number;
    charCount: number;
  };
  input: {
    value: string;
    focused: boolean;
  };
};
```

规则：

- 用户消息和最终 assistant 回复进入 `history`。
- operation start/update 默认只更新 `activeRun.activeOperations`。
- operation failed / interrupted / important completed event 可以按摘要方式进入 system history。
- `message.delta` 更新 `assistantDraft` 和 phase。
- `message.completed` 将 final assistant message 写入 history，并结束 active run。
- `human_review.requested` 进入 `waiting_human`，由 `ApprovalPanel` 接管输入区域。
- 用户主动 interrupt 进入 `interrupting`，迟到事件按 requestId 忽略。
- `session.tokenUsage` 记录当前会话可观察到的 LLM token usage / context usage；这里的 token 是模型用量统计，不保存鉴权 token、API key 或本地 secret。

## 6. Command / Keymap / Composer

### 6.1 Command Registry

slash command 后续通过 registry 管理命令定义、别名、帮助文案、参数解析和 enabled state。

建议：

```ts
type TuiCommand = {
  name: string;
  aliases?: string[];
  description: string;
  parse(args: string): TuiCommandInvocation;
  isEnabled(state: TuiState): boolean;
};
```

第一批命令：

- `/help`
- `/new`
- `/studio [task]`
- `/chat`
- `/allow`
- `/quit`

后续可以自然接入 command popup、补全和 help 列表。

### 6.2 Keymap

按键应集中定义，再由不同区域解释：

- global：`Ctrl+C` interrupt / exit，`Esc` clear / interrupt。
- composer：Enter submit，方向键历史导航，左右移动，Ctrl+A/E/K/U/W。
- approval：上下选择，Enter 确认，Esc 关闭选择器进入自由输入。

这样可以让多个 `useInput` 的优先级和职责更明确。

### 6.3 Composer

Composer 是 terminal 输入系统的承载层。后续需要支持：

- command popup。
- 输入历史。
- paste burst。
- 多行输入。
- file mention / path search。
- approval 自由回复。

## 7. Approval / HITL

当前 `InterruptSelector` 能完成基础选择。后续 `ApprovalPanel` 作为更完整的 HITL 组件，承载这些能力：

- 展示 request prompt。
- 展示结构化 action requests。
- 展示允许的 decisions。
- 支持 approve / reject / respond。
- 支持 `/allow` 这类 session authorization。
- 支持自由输入作为 resume message。

注意：approval panel 可以根据 `human_review.requested.payload` 生成候选动作。展示所需信息应来自 server 输出的 approval payload，TUI 只消费已经归一化后的请求结构。

## 8. Rendering / i18n

短期 TUI 文案可以继续放在 `tui/render/copy.zh-CN.ts` 或相近位置，先建立 copy 集中管理入口。

render adapter 的职责：

- 消费 normalized `LocalAgentEvent` 字段。
- 集中维护 TUI 终端文案。
- 为后续 i18n 留出 copy key。
- 保持 TUI 文案与 app 文案独立演进。

建议分层：

```txt
LocalAgentEvent
  -> TUI activity/update model
  -> zh-CN terminal copy
  -> Ink components
```

app 后续可以有自己的：

```txt
LocalAgentEvent
  -> mobile run state
  -> app copy / gif / compact activity strip
```

## 9. Session / Resume / Diff

这些能力重要，建议排在第一轮结构拆分之后。

后续阶段再做：

- resume picker：展示可恢复会话，选择后加载 transcript。
- transcript model：区分 durable messages 和 run activity。
- diff renderer：文件修改 / shell patch / capability 变更需要可审查的 diff。
- file search / mention：提高 TUI 输入效率。

这些模块都依赖前面的 state、command 和 composer 边界，应该排在后面。

## 10. 分阶段计划

### 阶段 0：文档对齐

本阶段只提交文档，TUI 行为保持不变。

产出：

- `docs/LOCAL_AGENT_TUI_ARCHITECTURE.md`

### 阶段 1：无行为变化拆分

目标：降低 `commands/tui.tsx` 复杂度，用户体验保持不变。

工作项：

- 新增 `src/tui/` 目录。
- `commands/tui.tsx` 变成 thin entry。
- 移出 `MessageBlock`、`SmartTextInput`、`InterruptSelector`、layout helpers。
- 移动 `tuiEventRenderer.ts` 到 `tui/render/`，保持只面向 `LocalAgentEvent`。
- 保持现有命令、按键、消息渲染行为不变。

验收：

- `npm run typecheck -w pinpawo-local-agent`
- `npm run test:unit -w pinpawo-local-agent`

### 阶段 2：引入 TUI state reducer

目标：把 WebSocket event handling 和 UI state transition 分开。

工作项：

- 新增 `tui/state/tuiState.ts`。
- 新增 `tui/state/tuiStateReducer.ts`。
- 将 `LocalAgentEvent`、control message、user action 映射成 `TuiAction`。
- 保持 network side effects 在 controller/hook 中。

验收：

- 给 reducer 加 unit tests。
- 覆盖 message.delta/completed、operation、human_review、interrupt、error。

### 阶段 3：Command registry + keymap + composer

目标：把输入系统产品化。

工作项：

- 新增 command registry。
- 新增 keymap。
- 把 `SmartTextInput` 升级为 composer model + component。
- `/help` 从 registry 生成。

验收：

- 命令 parse 有 unit tests。
- keymap 保持现有快捷键语义。

### 阶段 4：Presentation model 和 ApprovalPanel

目标：让 TUI 渲染从事件处理路径中独立出来。

工作项：

- `LocalAgentEvent -> TUI activity/update model`。
- active operation、status line、system notice、studio progress 统一走 render adapter。
- `InterruptSelector` 升级为 `ApprovalPanel`。
- TUI copy 集中到 `tui/render/`。

验收：

- 只消费 normalized operation/event 字段。
- approval 行为与当前版本一致。

### 阶段 5：高级 TUI 能力

目标：补齐 terminal client 的产品能力。

工作项：

- resume picker。
- diff renderer。
- file mention / path search。
- richer status line。
- transcript export / debug view。

## 11. 非目标

本轮 TUI 重构的边界：

- 继续使用 Ink。
- local-agent server 只按必要接口适配，完整 server 拆分归入后续 local-agent 架构阶段。
- pet-agent runtime 保持现状。
- app chat UI 通过 `LocalAgentEvent` 语义对齐，页面重做归入 app 侧独立阶段。
- TUI formatter 保持 terminal adapter 定位。
- 新 TUI 路径以 `LocalAgentEvent` 为主事件模型。

## 12. 下一步建议

合并本文档后，下一 PR 做“阶段 1：无行为变化拆分”。

第一轮拆分必须小心控制范围：

- 只移动代码，命令语义保持不变。
- reducer 语义留到阶段 2。
- WebSocket protocol 保持不变。
- `/studio` / `/chat` / `/new` / `/allow` 行为保持不变。
- 每个文件拆分都必须能通过 typecheck 和 unit tests。
