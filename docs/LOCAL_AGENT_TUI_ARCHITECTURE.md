# Local Agent TUI Architecture

> 状态：Draft v2
> 日期：2026-05-29

> v2 修订重点：① 明确范围边界——TUI 文档只定义 TUI 客户端如何消费归一化事件、维护 state，并为 studio 留出 state 形状；studio 完整链路归 `PET_AGENT_STUDIO_ORCHESTRATOR_DESIGN.md` / `PET_AGENT_STUDIO_INTERFACES.md`，事件归一化归 `LOCAL_AGENT_ARCHITECTURE_REFACTOR_PLAN.md` §5。② state 改为 session-keyed，为 chat ∥ studio、multi-agent 多 session 留空间（v1 UI 单焦点）。③ 收敛目标目录粒度、去掉冗余中间 model、标注 token usage 来源、写清动画时钟与迟到事件过滤两条 reducer 边界。④ 把 `operation` 事件模型与 tool event 源可靠性、chat/studio 收敛、message token boundary 作为**同一次重构的不同部分**对齐（不是 TUI 等谁的前置依赖，见 §11）。⑤ 分阶段计划压缩为更早交付用户价值的顺序。

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

#### chat 与 studio 是两类不同的 run（TUI 只留空间，不定义内部链路）

TUI 需要知道的，仅限于"消费哪些事件、怎么归类"这一层：

- **chat 是单 pet 的 agent run**：token 级活动通过事件流出——`message.delta`、`message.completed`、`operation`。
- **studio 是被编排的 run**：planner 与各 pet 都是**完整的 PetAgentRuntime**（与 chat 同一套 `OrchestratorGraph`），由 StudioOrchestrator 编排。按 studio 设计，studio 在界面上是**控制面状态层**（编排进度），主交互仍在 pet 面板；TUI 侧 studio 编排进度以 `studio.progress` 流出，最终结果走 `studio_response`（含 `outcome` / `finalDispatchId` 等编排信息）。

> **范围边界。** studio 的完整链路——UI Role Boundary、Turn State Stream、ws 协议、planner/dispatch/wiki、pet 调用契约——定义在 `docs/PET_AGENT_STUDIO_ORCHESTRATOR_DESIGN.md` 与 `docs/PET_AGENT_STUDIO_INTERFACES.md`；事件归一化与 stream→event 映射定义在 `docs/LOCAL_AGENT_ARCHITECTURE_REFACTOR_PLAN.md` §5。本文档**不**复制或定义这些链路，只保证 TUI state 形状为它们留出空间（见 §5 的 session-keyed 模型）。

TUI 这层只需守住两条：

- **不要把 `studio_response` 强行归一化成 `message.completed`**——两者 wire 语义不同，studio 专属字段（`outcome` / `finalDispatchId`）不能丢。收敛点放在 **reducer 的 action 层**：各自保留 wire 形状，但都映射到同一个内部"run 结束"动作，让状态收尾只有一处实现。
- **模型独立 ≠ 运行时并发**：把 chat / studio 建模成不同 run 是模型层面的要求；当前 server 仍是**一个 WS 一个 inflight**（发新请求会 abort 上一个），二者现在不会真正同时运行。独立建模是为并发落地预留，不代表已并发（依赖见 §11，形状见 §5）。

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
- token usage / context usage 是 session 级可观测数据。**当前协议还没有这个字段**——`message.completed.metadata` 现在只有 `mood` / `topic` / `tags`，没有 token 用量。要在 TUI 展示用量，需要先定义来源：要么扩 `message.completed.metadata.usage`，要么加一个独立的 `usage` 事件。在来源落地前，§5 的 `tokenUsage` 字段是预留位，应保持为 `null` 并在 UI 上不展示。
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

短期建议聚焦整理 TUI 目录，server/runtime 拆分保留给 local-agent 架构阶段。

目录粒度的原则：**只为当前已存在的代码建文件，不为想象中的功能预留空目录**。当前 TUI 是 ~1250 行单文件，`tuiEventRenderer.ts` 是 97 行单文件。拆分目标是把这两块按职责切开，而不是一步切成十几个小文件——后者会把 1250 行变成一堆相互跳转的碎片，反而更难读。

```txt
services/local-agent/src/
  commands/
    tui.tsx                  # thin entry: actor selection + render TuiApp

  tui/
    TuiApp.tsx               # app shell: compose hooks/components
    TuiRuntimeController.ts  # 阶段 1C: websocket/http 副作用、发送 client message、session/history 加载

    state/
      tuiState.ts            # TuiState / TuiAction types(session-keyed,见 §5)
      tuiStateReducer.ts     # local-agent events + control + UI actions -> TuiState

    input/
      commandRegistry.ts     # slash commands, help, enabled state
      keymap.ts              # global/composer/approval key bindings

    render/
      eventText.ts           # LocalAgentEvent / studio.progress -> 终端文案(由现 tuiEventRenderer.ts 演进)
      text.ts                # TUI_TEXT: 当前中文 TUI 文本入口；完整 i18n 后续单独设计

    components/
      MessageHistory.tsx
      HistoryCell.tsx
      Composer.tsx           # 含光标/快捷键(由现 SmartTextInput 演进)
      StatusLine.tsx
      ActiveOperations.tsx
      ApprovalPanel.tsx
      ConnectionNotice.tsx
```

相对初稿砍掉/合并的部分，以及理由：

- **去掉 `state/selectors.ts`**：当前没有跨组件复用的派生状态，组件内 `useMemo` 就够；真出现重复再抽。
- **`render/eventToActivity.ts` + `operationText.ts` + `studioText.ts` 合并为 `render/eventText.ts`**：这三件事现在都在同一个 97 行文件里，拆成三个是碎片化。
- **去掉 `input/composerModel.ts`**：在 multiline / paste / mention 都还不存在时拆 model/component 是为想象功能预留。先让 `Composer.tsx` 自带光标和快捷键，等真要做这些能力再拆 model。
- **去掉 `session/historyAdapter.ts` 子目录**：history restore 现在是 `init()` 里 ~30 行内联 fetch，归到 `TuiRuntimeController` 即可，不需要独立子系统。
- **`copy.zh-CN.ts` → `text.ts` / `TUI_TEXT`**：当前只有中文一种，先做 single-locale TUI 文本入口；完整 i18n 的 locale lookup、fallback 和参数协议后续单独设计。

关键约束：

- `commands/tui.tsx` 最终收敛为 CLI entry。
- `tui/render/*` 面向 normalized event fields。
- `tui/state/*` 保持纯状态计算（不含网络副作用，也不含动画时钟，见 §5）。
- `TuiRuntimeController` 在阶段 1C 落地，负责 local-agent server 通信、发送 client message、session/history 加载。

## 5. TUI State 草案

### 5.1 为什么是 session-keyed

初稿把 state 设计成全局单 `activeRun` + 一条扁平 `history`，隐含"同时只有一个运行态"。但 §3.3 已经说明 chat 与 studio 是两类独立的 run；再加上 multi-agent 方向下未来**多个 chat session 会同时工作**——一旦 server 支持并发（见 §11），单 `activeRun` 模型就会出现两个问题：

- 并发 run 互相覆盖，`message.delta` 把 A 的 token 拼进 B 的草稿。
- 迟到事件过滤"requestId ≠ 唯一 activeRun.requestId 就丢"会把另一条合法 run 的事件误杀。

即便当前 server 还是单 inflight、不会真正并发，把"运行态"和"历史"都从全局降到 **session** 维度也是值得的：每个 session 有自己的 history 和至多一个 inflight run，run 的身份是 `requestId`，session 的身份由客户端分配。这样并发能力到位时不必重写 reducer。

> 落地策略（已确认）：**state 形状现在就做成 session-keyed，v1 UI 仍只渲染当前焦点 session、单连接**。今天 `sessions` 里通常只有一个条目；多 session 并行 UI 留到 server 支持并行后再做（见 §11 的跨层依赖）。形状先就位，避免 multi-agent 落地时推倒重写 reducer。

### 5.2 TuiState

```ts
type RunId = string;        // = requestId,一次 run 的身份
type SessionId = string;    // 客户端分配:chat = actor/thread,studio = conversationId

type TuiState = {
  connection: {
    status: 'initializing' | 'connecting' | 'ready' | 'disconnected' | 'error';
    message: string;
  };
  sessions: Record<SessionId, SessionModel>;
  focusedSessionId: SessionId | null;
  // requestId → sessionId 路由表,客户端在发起请求时写入
  runRoute: Record<RunId, SessionId>;
  input: {
    value: string;
    focused: boolean;
  };
};

type SessionModel = {
  id: SessionId;
  kind: 'chat' | 'studio';
  actor: { label: string; summary: string };   // chat=pet;studio=orchestrator
  history: HistoryCellModel[];
  activeRun: ActiveRunModel | null;             // 每个 session 至多一个 inflight run
  // 预留位:协议尚无 usage 字段(见 §3.5),来源落地前保持 null
  tokenUsage: TokenUsageModel | null;
};

type ActiveRunModel = {
  requestId: RunId;
  phase: 'thinking' | 'using_tool' | 'streaming' | 'waiting_human' | 'interrupting';
  assistantDraft: string;
  activeOperations: ActiveOperationModel[];
  pendingReview?: ApprovalRequestModel;
  startedAt: number;
  charCount: number;
};

// 模型用量统计,非鉴权 token / API key / 本地 secret。
// 协议尚无来源字段(见 §3.5):字段先定义好,但来源落地前 session.tokenUsage 恒为 null。
type TokenUsageModel = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  contextWindow?: number;
  updatedAt?: string;
};

// 一条历史条目。v1 故意保持简单,与现实现行为对齐:
// operation 的 completed/failed/interrupted 摘要以 kind:'system' 写入(见 §5.3)。
// 更丰富的 cell(独立的 operation cell / diff cell / 区分 durable vs run activity)
// 属于阶段 4 的 transcript model,这里不预先拆。
type HistoryCellModel = {
  id: string;
  kind: 'user' | 'assistant' | 'system';
  text: string;
  timestamp?: string;
};

// activeRun 期间在途的一个 operation,来自归一化后的 operation 事件字段。
type ActiveOperationModel = {
  key: string;        // 去重键:operation.id ?? source.callId ?? source.name ?? kind
  kind: string;       // operation.kind
  title: string;      // operation.title ?? kind
  detail: string;     // target / summary / details 拼成的展示文案
  startedAt: number;
};

// 一次待处理的 human review,来自 human_review.requested 事件。
// ApprovalPanel 据 payload 生成候选动作(见 §7);TUI 只消费归一化后的请求结构。
type ApprovalRequestModel = {
  requestId: RunId;
  kind: string;                     // payload.kind ?? 'interrupt'
  prompt: string;
  payload: Record<string, unknown>; // 归一化后的 approval payload(actionRequests / reviewConfigs 等)
  petId?: string;                   // studio 路径下触发 HITL 的 pet;chat 路径 undefined
};
```

> 注意：`ActiveRunModel` 里没有 spinner 帧、`now` 时间戳这类动画时钟字段。这些是纯展示状态，应留在组件 local state（一个 `setInterval` tick），**不要进 reducer**——否则 spinner 每 ~120ms 灌一个 action，纯噪音污染状态流，也让 reducer 测试难写。`startedAt` 进 state（用于算 elapsed），但"当前时间"在组件里取。

### 5.3 规则

- 用户消息和最终 assistant 回复进入对应 session 的 `history`。
- **事件路由**：收到 `{ requestId, event }` → `sessionId = runRoute[requestId]` → 落到该 session 的 `activeRun`。
- **迟到 / 陌生事件过滤**（reducer 头等不变量）：`runRoute` 里查不到 `requestId` 的事件直接丢弃。这取代了初稿"对比唯一 requestId"的写法，将来并发时也天然安全。阶段 1B 的 reducer 必须为这条规则单独加测试。
- operation start/update 默认只更新该 session 的 `activeRun.activeOperations`。
- operation failed / interrupted / 重要 completed 事件可以按摘要进入该 session 的 system history。
- `message.delta` 更新对应 session 的 `assistantDraft` 和 phase。
- **run 结束统一收尾**：`message.completed`（chat）、`studio_response`（studio done/stopped）、`studio_error` 都映射到同一个内部"run 结束"动作，作用在各自 session 上——写入 history、清空 `activeRun`、删除 `runRoute[requestId]`、清理 pending review。收尾逻辑只有一处（见 §3.3）。
- `human_review.requested` 让对应 session 进入 `waiting_human`，由 `ApprovalPanel` 接管输入区域。
- 用户主动 interrupt 让对应 session 进入 `interrupting`；该 run 的迟到事件因为后续会从 `runRoute` 移除而被忽略。
- `tokenUsage` 记录当前会话可观察到的 LLM token usage / context usage；这里的 token 是模型用量统计，不保存鉴权 token、API key 或本地 secret。协议字段落地前保持 `null`（见 §3.5）。

### 5.4 history 与 `<Static>` 的交互

当前实现用 Ink 的 `<Static>` 渲染历史（只追加、已渲染项不再重绘），同时用 `MAX_MESSAGES` 裁剪 history 头部。这两者有冲突：**被裁掉的旧消息已经渲染到终端 scrollback，视觉上不会消失**——`<Static>` 只控制新增，裁剪只省内存/state 体积。

所以裁剪要明确定位成"限制 state 内存占用"，而不是"清屏"。session-keyed 之后，裁剪应**按 session 各自的 history 做**，避免一个高频 session 把另一个 session 的历史挤掉。

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

要解决的具体痛点：当前有三个并存的 `useInput`（全局、`SmartTextInput`、`InterruptSelector`），靠在每个里手写 `if (key.ctrl && input === 'c') return; // let parent handle`、`if (key.escape) return;` 这种**穿透 hack** 来协调谁吃哪个键。这很脆——加一个新区域或新快捷键，就要在多个 hook 里同步改穿透条件，漏一处就出现"按键被吞"或"被处理两次"。

keymap 的目标是把按键**集中定义**，再由不同区域按当前 focus 解释：

- global：`Ctrl+C` interrupt / exit，`Esc` clear / interrupt。
- composer：Enter submit，方向键历史导航，左右移动，Ctrl+A/E/K/U/W。
- approval：上下选择，Enter 确认，Esc 关闭选择器进入自由输入。

落地方式建议是"单一 key 分发 + 当前 focus 区域"决定路由，取代分散在多个 `useInput` 里的穿透判断，让优先级和职责显式化。

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

短期 TUI 文案集中到 `tui/render/text.ts` 的 `TUI_TEXT`，先建立 single-locale TUI 文本入口。当前只有中文一种，不在本阶段引入完整 i18n 框架；等真要支持第二语言时，再单独设计 locale lookup、fallback 和参数协议。

render adapter 的职责：

- 消费 normalized `LocalAgentEvent` 字段。
- 集中维护 TUI 终端文案。
- 保持 TUI 文案与 app 文案独立演进。

分层（去掉了初稿里的中间 model）：

```txt
LocalAgentEvent
  -> render adapter(eventText.ts):直接映射成组件 props + 终端文案
  -> Ink components
```

> 初稿在事件和组件之间额外加了一层"TUI activity/update model"。但 §3.6 已经明确 `operation.title` / `target` / `summary` 是 adapter 可直接消费的展示语义——事件进 TUI 前就已归一化。再叠一层中间 model 对当前需求是冗余，render adapter 直接把归一化事件映射成组件 props 即可。等真出现"多个组件共享同一份派生展示结构"的需求，再抽中间 model。

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

> 阶段 1 拆成 1A / 1B / 1C。原因是 `commands/tui.tsx` 当前同时承载组件、事件状态、WebSocket 副作用和命令输入；一次同时拆文件、引入 session-keyed reducer、再抽 controller，review 面会过大。先拆展示边界，再改状态模型，最后抽副作用层。

### 阶段 0：文档对齐

本阶段只提交文档，TUI 行为保持不变。

产出：

- `docs/LOCAL_AGENT_TUI_ARCHITECTURE.md`

### 阶段 1A：无行为变化拆边界

目标：降低 `commands/tui.tsx` 复杂度，但不改变 state 语义、WebSocket 逻辑和用户可见行为。

工作项：

- 新增 `src/tui/` 目录，`commands/tui.tsx` 变成 thin entry。
- 移出 `MessageBlock`、`SmartTextInput`、`InterruptSelector`、status/active operation/layout helpers 到 `tui/components/` 或 `tui/layout`。
- `tuiEventRenderer.ts` 演进为 `tui/render/eventText.ts`，仍只面向 `LocalAgentEvent` / `studio.progress`。
- 保留现有 `useState` / `useRef` / `useEffect` 结构。
- 不引入 `TuiRuntimeController`。
- 不引入 session-keyed reducer。

验收：

- `npm run typecheck -w pinpawo-local-agent`
- `npm run test:unit -w pinpawo-local-agent`
- `/studio` / `/chat` / `/new` / `/allow` 行为保持不变。
- 第一轮 diff 主要是移动代码和 import 调整。

### 阶段 1B：引入 session-keyed reducer

目标：把 WebSocket event handling 与 UI state transition 分开，采用 §5 的 session-keyed state 形状；v1 UI 仍然单焦点、单连接。

工作项：

- 新增 `tui/state/tuiState.ts`、`tui/state/tuiStateReducer.ts`。
- state 采用 `sessions + focusedSessionId + runRoute`，但 `sessions` 通常只有一个当前 session。
- 把 `LocalAgentEvent`、control message、user action 映射成 `TuiAction`。
- chat 的 `message.completed` 与 studio 的 `studio_response` / `studio_error` 收敛到同一个"run 结束"动作。
- 动画时钟（spinner / now）留在组件 local state，不进 reducer。
- network 副作用、session/history 加载、断线后的重连策略暂时保留在现有 effect/controller 位置。

验收：

- `npm run typecheck -w pinpawo-local-agent`
- `npm run test:unit -w pinpawo-local-agent`
- reducer unit tests 覆盖：message.delta/completed、operation、human_review、interrupt、error、studio_response/error。
- **专项测试**：`runRoute` 查不到 requestId 的事件被丢弃（迟到 / 陌生 run）；两条不同 requestId 的 `message.delta` 不会串进同一个 `assistantDraft`。

### 阶段 1C：抽 TuiRuntimeController

目标：在 reducer 稳定后，把 WebSocket / HTTP / session side effects 从 `TuiApp` 中抽出。

工作项：

- 新增 `TuiRuntimeController` 或等价 hook/controller。
- 负责 local-agent health check、WebSocket connect/retry、history restore。
- 负责发送 chat/studio/review/interrupt/new_session client message。
- controller 只 dispatch action，不持有展示逻辑。
- 断线/重连状态通过 reducer 更新 connection state。

验收：

- `npm run typecheck -w pinpawo-local-agent`
- `npm run test:unit -w pinpawo-local-agent`
- TUI reconnect / init / history restore 行为与当前版本一致。

### 阶段 2：Command registry + keymap + composer

目标：把输入系统产品化，并用单一 key 分发取代多个 `useInput` 的穿透 hack（见 §6.2）。

工作项：

- 新增 command registry，`/help` 从 registry 生成。
- 新增 keymap，按当前 focus 区域路由按键。
- 把 `SmartTextInput` 升级为 `Composer.tsx`（自带光标和快捷键，暂不拆独立 model）。

验收：

- 命令 parse 有 unit tests。
- keymap 保持现有快捷键语义，无"按键被吞 / 被处理两次"。

### 阶段 3：render adapter 收敛 + ApprovalPanel

目标：让 TUI 渲染从事件处理路径中独立出来（不引入冗余中间 model，见 §8）。

工作项：

- active operation、status line、system notice、studio progress 统一走 `render/eventText.ts`，直接映射成组件 props。
- `InterruptSelector` 升级为 `ApprovalPanel`。
- TUI 文案集中到 `tui/render/text.ts` 的 `TUI_TEXT`。

验收：

- 只消费 normalized operation/event 字段。
- approval 行为与当前版本一致。

### 阶段 4：高价值用户能力（从初稿阶段 5 提前）

目标：在结构就位后尽早交付用户可感知的能力，而不是连做多个纯重构 PR。

工作项（可按价值再拆小 PR）：

- transcript export / debug view：先提供 `/export [path]`，把当前 session history 导出为 Markdown，作为 transcript model 前的可用调试入口。未传 `path` 时默认写入 TUI 启动目录（`process.cwd()`）；`~/foo.md` 会展开到当前用户 home；有扩展名的 `path` 视为目标文件，无扩展名的 `path` 视为目录并在其下生成默认文件名；显式目标文件已存在时按常规导出语义覆盖。
- diff renderer：文件修改 / shell patch / capability 变更的可审查 diff。
- resume picker：展示可恢复会话，选择后加载 transcript。
- transcript model：区分 durable messages 和 run activity。
- file mention / path search、richer status line。

## 11. 非目标

本轮 TUI 重构的边界：

- 继续使用 Ink。
- local-agent server 只按必要接口适配，完整 server 拆分归入后续 local-agent 架构阶段。
- pet-agent runtime 保持现状。
- app chat UI 通过 `LocalAgentEvent` 语义对齐，页面重做归入 app 侧独立阶段。
- TUI formatter 保持 terminal adapter 定位。
- 新 TUI 路径以 `LocalAgentEvent` 为主事件模型。

与同一次重构对齐的其他部分：

TUI 重构不是孤立的一块。下面这些是**同一次项目重构**的不同部分，归属不同文件/文档，但**一起改、对齐同一份契约**——不是 TUI 等谁、也不是谁等 TUI，重构时一并推进、契约对齐即可。

- **`operation` 事件模型 ↔ tool event 源的可靠性**，是这次重构的两端，一起改：
  - `operation` 现在带 `phase` 生命周期，TUI reducer 把 `activeOperations` 当权威 state（§5）。
  - 对应地，tool event 的**结构化源要做成生命周期完整**——start 必配 terminal、有序、稳定 callId，`operation` 从它直接产出，**退役 `tool_log`**（见 `docs/PET_AGENT_STUDIO_INTERFACES.md` Boundary 2 + Open Question、`docs/LOCAL_AGENT_ARCHITECTURE_REFACTOR_PLAN.md` §5.0）。
  - pet 调用契约同时补 **message token boundary**——现 `PetAgentRuntimeInvokeInput` 只有 `onToolEvent`、没有 token 回调，需扩 INTERFACES 的 Boundary 1，让 pet 的 `message.delta` 在各路径都有出口。
  - chat 与 studio 当前是同一个 `OrchestratorGraph` 的两条投递路径（chat = ws stream + 直推中断；studio = pet runtime + onToolEvent + humanReviewer 桥），这次一并**收敛到同一条**。
  - 对齐点：两端共用 `operation` 的 `phase` 生命周期语义与 `activeOperations` 的 state 语义，源侧产出什么、TUI 侧怎么消费，用同一份契约定义。

- **session-keyed 形状 ↔ run 身份契约**：state 按"run 身份 = `requestId`、session 身份由客户端分配"设计（§5），与 server 端 run 标识对齐。完整 server 拆分（同一连接多 inflight / 一 session 一连接以支持真正并发）按非目标归入后续 local-agent 架构阶段，但 run 身份契约现在就对齐，到时直接契合、无需重写 state。

## 12. 下一步建议

合并本文档后，下一 PR 做"阶段 1A：无行为变化拆边界"。

第一轮必须小心控制范围：

- 只移动/拆分现有 TUI 组件、layout helper 和 render helper。
- 保留现有 `useState` / `useRef` / `useEffect` 状态结构。
- 不引入 session-keyed reducer、`runRoute` 或 `TuiRuntimeController`。
- WebSocket protocol 和 WebSocket 连接逻辑保持不变。
- `/studio` / `/chat` / `/new` / `/allow` 行为保持不变。
- 拆分后必须通过 typecheck 和 unit tests。
- 迟到 / 陌生 requestId 过滤、两个 requestId 不串 `assistantDraft` 等专项 reducer 测试放到阶段 1B。
