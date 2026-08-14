# Agent Timeline Refactor Design

> **Historical design record — superseded 2026-07-14.** Type names and state
> boundaries in this proposal describe an earlier TUI implementation. Use
> [`LOCAL_AGENT_SESSION_PROJECTION.md`](../../reference/runtime/session-projection.md)
> for the current canonical timeline/session contract.

> 状态：Draft v1
> 日期：2026-06-19
> 关联：[#216 Clarify operation metadata contract and TUI rendering semantics](https://github.com/pinpawo/pinpawo-agent/issues/216)

## 1. 文档目标

本文定义 local-agent TUI 中 **AgentTimeline** 的重构方向。

这里的 timeline 不是单纯的 message list，也不是单纯的 tool operation list。它表示一次 agent run 在用户眼前发生的真实执行顺序：

```txt
user message
  -> assistant text segment
  -> tool/operation call
  -> operation result
  -> assistant text segment
  -> tool/operation call
  -> operation result
  -> final assistant text
```

目标是把当前 TUI 中分散的几条 UI 状态流收敛到一个统一的 presentation model：

- user / assistant message
- streaming assistant draft
- active tool operations
- completed / failed operation history rows
- human review waits
- system notice / error / studio progress

AgentTimeline 的职责是**渲染 agent 执行过程**。它不替代 `LocalAgentEvent` 协议，也不重新解析 raw tool payload；它消费已经归一化后的 event display fields，并把它们按 run 顺序组织成用户可读的 timeline。

---

## 2. 当前问题

当前 TUI state 把 run activity 拆成多块：

- `SessionModel.history: HistoryCellModel[]`
  - 保存 user / assistant / system 历史行。
- `ActiveRunModel.assistantDraft`
  - 保存当前 assistant streaming text。
- `ActiveRunModel.activeOperations`
  - 保存正在执行的 operation line。
- terminal operation event
  - completed / failed 时被格式化成 `system` history cell。

这能工作，但带来几个结构性问题。

### 2.1 AI message 与 tool call 不在同一条流中

实际 agent run 是：

```txt
assistant starts reasoning/output
tool call starts
tool call result arrives
assistant continues
```

但当前 TUI 把它拆成：

```txt
assistantDraft         # 单独一块
activeOperations       # 单独一块
history system cell    # terminal operation result
final assistant cell   # run finished 后再追加
```

这会让 UI 很难表达真实顺序，也会让 reducer 必须在多个字段之间协调同一次 run 的状态。

### 2.2 active operation 与 completed operation 是两套模型

运行中 operation 使用：

```ts
type ActiveOperationModel = {
  key: string;
  kind: string;
  title: string;
  detail: string;
  startedAt: number;
};
```

完成后 operation 立刻变成：

```ts
type HistoryCellModel = {
  kind: 'system';
  text: string;
};
```

这意味着 operation lifecycle 在 UI 层断裂了：start/update/end 不是同一个 timeline item 的状态变化，而是 active list 与 history row 之间的转换。

### 2.3 system history 过载

operation result、system notice、subagent output、interrupt/error 都可能进入 `system` cell。它们在 display 上相似，但语义不同。后续想做 compact/expanded operation、review card、studio progress grouping 时，必须再从纯文本中反推类型。

### 2.4 TUI 处理复杂度被人为抬高

当前 reducer 需要同时维护：

- run phase
- assistant draft
- subagent draft
- active operations
- final assistant history
- terminal operation history

如果改成 event-driven presentation timeline，TUI 只需要按 event 顺序 append/update timeline entries，component 负责按 entry type 渲染。

---

## 3. 命名与边界

### 3.1 组件命名

总组件：

```txt
AgentTimeline
```

它渲染一个 session 中的 agent-visible timeline。

建议子组件：

```txt
AgentTimeline
  AgentTimelineItem
  AgentMessageItem
  AgentOperationItem
  AgentReviewItem
  AgentNoticeItem
  AgentErrorItem
```

辅助模型/纯函数：

```txt
tui/timeline/agentTimeline.ts
tui/timeline/agentTimelineReducer.ts
tui/timeline/operationPresentation.ts
tui/timeline/agentTimelineSelectors.ts
```

### 3.2 与 Operation Presentation Contract 的关系

`AgentTimeline` 是组件和 TUI presentation model。

`Operation Presentation Contract` 是 operation display fields 的 producer/consumer 契约，覆盖：

- toolkit/toolset `ToolOperationMetadata`
- local-agent `LocalAgentOperationEvent`
- TUI operation item rendering
- context rewrite / review policy 中对 operation summary 的安全使用

二者关系：

```txt
ToolOperationMetadata
  -> LocalAgentOperationEvent.operation.{title,target,summary,details}
  -> AgentTimelineEntry(type: 'operation')
  -> AgentOperationItem
```

AgentTimeline 不读 `operation.raw` 来补 UI。raw payload 只用于 trusted/debug 场景；timeline 必须依赖 display fields。

---

## 4. 目标模型

### 4.1 AgentTimelineEntry

建议 TUI 内部引入 timeline entry，而不是继续把一切压成 `HistoryCellModel`：

```ts
export type AgentTimelineEntry =
  | AgentMessageEntry
  | AgentOperationEntry
  | AgentReviewEntry
  | AgentNoticeEntry
  | AgentErrorEntry
  | AgentStudioProgressEntry;
```

#### Message entry

```ts
export type AgentMessageEntry = {
  id: string;
  type: 'message';
  role: 'user' | 'assistant' | 'subagent';
  requestId?: string;
  text: string;
  status: 'completed' | 'streaming';
  createdAt?: string;
  updatedAt?: string;
};
```

设计点：

- streaming assistant 不再单独放在 `activeRun.assistantDraft`。
- assistant 在 tool call 前后的输出可以拆成多个 assistant segments。
- `message.completed` 用来 finalize 当前 assistant segment，或者在没有 delta 时创建 completed segment。
- subagent model text 是 `role: 'subagent'` 的 message segment，不是 `system`/`notice` 文本，也不新增 subagent 专用 item component。

#### Operation entry

```ts
export type AgentOperationEntry = {
  id: string;
  type: 'operation';
  requestId: string;
  operationKey: string;
  kind: string;
  title: string;
  phase: 'started' | 'updated' | 'completed' | 'failed' | 'interrupted';
  target?: string;
  summary?: string;
  details?: Record<string, unknown>;
  source?: {
    provider: 'toolkit' | 'toolset' | 'runtime';
    name: string;
    toolName?: string;
    callId?: string;
  };
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
};
```

设计点：

- tool call 和 tool result 是同一个 `operation` entry 的 lifecycle，不是两个互不相关的 history rows。
- start event append entry。
- update/end/error event update same entry。
- 如果 terminal event 先到或 start 缺失，reducer 可以在 terminal event 位置创建 entry。
- operation 的展示信息来自 `LocalAgentOperationEvent.operation`，不从 raw payload 推断。

#### Review / notice / error / studio progress

这些 entry 先保持轻量：

```ts
export type AgentReviewEntry = {
  id: string;
  type: 'review';
  requestId: string;
  reviewId: string;
  status: 'waiting' | 'answered' | 'interrupted';
};

export type AgentNoticeEntry = {
  id: string;
  type: 'notice';
  requestId?: string;
  text: string;
};

export type AgentErrorEntry = {
  id: string;
  type: 'error';
  requestId?: string;
  text: string;
};
```

后续如果 studio progress 需要折叠，可以单独扩展，不影响 message/operation 主线。

### 4.2 SessionModel

目标状态：

```ts
export type SessionModel = {
  id: SessionId;
  kind: 'chat' | 'studio';
  actor: ...;
  runtime: ...;
  timeline: AgentTimelineEntry[];
  activeRun: ActiveRunModel | null;
  tokenUsage: TokenUsageModel | null;
};
```

`history` 可以在迁移期保留并由 `timeline` 派生，最终应由 `timeline` 取代。

### 4.3 ActiveRunModel

目标是让 `activeRun` 只描述 run 控制状态，不再持有展示内容：

```ts
export type ActiveRunModel = {
  requestId: RunId;
  phase: 'thinking' | 'using_tool' | 'streaming' | 'waiting_human' | 'interrupting';
  timelineEntryIds: string[];
  pendingReview?: ApprovalRequestModel;
  startedAt: number;
  charCount: number;
};
```

这些字段应逐步删除：

- `assistantDraft`
- `subagentDraft`
- `activeOperations`

它们对应的信息都应成为 timeline entries。

---

## 5. Reducer 语义

### 5.1 run.start

当前行为：

- append user history cell
- 清空 input
- 创建 activeRun

目标行为：

- append `AgentMessageEntry(role: 'user')`
- 创建 activeRun
- `activeRun.timelineEntryIds` 包含 user entry id

```txt
run.start
  -> timeline += user message
  -> activeRun = { requestId, phase: thinking, timelineEntryIds: [userEntryId] }
```

### 5.2 message.delta

当前行为：

- append 到 `activeRun.assistantDraft`
- 增加 charCount

目标行为：

- 如果当前 request tail 是 streaming assistant entry，则 append text。
- 如果 tail 是 operation/review/notice，创建新的 streaming assistant entry。

```txt
message.delta(\"正在打开页面\")
  -> timeline += assistant streaming segment

operation.started(browser_open)
  -> timeline += operation entry

message.delta(\"页面打开了\")
  -> timeline += new assistant streaming segment
```

这样 timeline 可以自然表达：

```txt
assistant: 正在打开页面
operation: 打开网页 https://...
assistant: 页面打开了
```

`subagent.message.delta` 与 `message.delta` 同属 message timeline：它创建或更新 `AgentMessageEntry(role: 'subagent')`，由 `AgentMessageItem` 按 subagent 样式渲染。不要再把 subagent output 编码进 `system` cell 或 `notice` entry。

### 5.3 operation started/updated/completed/failed

当前行为：

- started -> activeOperations add
- updated -> activeOperations update
- terminal -> activeOperations remove + append system history cell

目标行为：

- started -> append operation entry
- updated -> update operation entry
- terminal -> update operation entry phase/result fields

```txt
operation.started
  -> timeline += operation(started)

operation.updated
  -> timeline[operationId] = operation(updated)

operation.completed
  -> timeline[operationId] = operation(completed)
```

这让 tool call 与 result 保持在同一个 timeline 位置。

### 5.4 message.completed

当前行为：

- run.finish 时 append final assistant history
- 如果 completed text 为空，可能 fall back to assistantDraft

目标行为：

- finalize 当前 streaming assistant segment。
- 如果 completed text 与已有 streaming text 不一致，按安全规则替换或补齐。
- run finish 只负责收尾 run，不再额外创建重复 assistant history。

### 5.5 human review

`human_review.requested` 应成为 timeline entry，同时 activeRun phase 变成 `waiting_human`：

```txt
assistant segment
operation entry
review waiting entry
```

用户回复 review 时，追加 user message 或 update review status，取决于 wire action 的语义。不要把 review response 混成普通 assistant/system text。

### 5.6 interrupted / error

interrupt 和 error 应更新当前 run 中相关 entries：

- running operation -> `phase: interrupted` 或 `failed`
- review -> `status: interrupted`
- run-level error -> append `AgentErrorEntry`

---

## 6. Component 设计

### 6.1 AgentTimeline

组件输入：

```ts
type AgentTimelineProps = {
  entries: AgentTimelineEntry[];
  width: number;
  now: number;
};
```

职责：

- 按 entry 顺序渲染。
- 不维护业务状态。
- 不读取 raw payload。
- 不决定 event merge；只消费 timeline model。

### 6.2 AgentOperationItem

组件输入：

```ts
type AgentOperationItemProps = {
  entry: AgentOperationEntry;
  now: number;
  width: number;
};
```

展示建议：

- 一个 operation lifecycle 对应一个 `AgentOperationItem`，`started/updated/completed/failed/interrupted` 都更新同一个 item。
- 单行显示，正文以 `summary` 为主，必要时补 `target/details/title`，状态作为行尾后缀。
- 宽度不足时截断正文，但保留状态后缀；不要把 start/update/completed 展示成多条日志。

browser 示例：

```txt
打开 https://example.com（开始）
页面：Example Domain · https://example.com（完成）
点击 .login-btn · 页面：Dashboard（进行中 2s）
No active browser page · #result（失败）
```

### 6.3 Busy status line

busy status 不再直接读 `activeOperations`。它可以由 timeline selector 派生：

```ts
selectRunningOperations(entries, requestId)
selectLastTimelineActivity(entries, requestId)
```

这样 status line 是 timeline 的 summary，而不是另一套独立 state。

---

## 7. Operation Presentation 约束

AgentTimeline 依赖 operation display fields，因此需要配套明确 Operation Presentation Contract。

### 7.1 不从 raw payload 兜底

TUI component 不应读取：

```ts
event.raw?.input
event.raw?.output
```

原因：

- remote/app transport 默认 strip raw。
- raw 可能包含敏感信息。
- raw shape 是 tool implementation detail，不是 UI contract。

### 7.2 operation fields 的推荐语义

```txt
title   = 稳定操作名，通常是动词短语
target  = 操作对象，例如 URL / selector / path / cwd / revision
summary = 短动作补充或结果摘要
details = 受控结构化补充，必须适合展示或审核
```

### 7.3 lifecycle merge 应在 normalizer/tracker 层完成

TUI timeline reducer 只接受已经归一化的 `LocalAgentOperationEvent`。

这些规则应在 event 层完成：

- JSON-string input fallback。
- raw string output first。
- terminal event 继承 start target/details。
- error summary 与 target/details 的合并。

TUI 只负责把 event update 到 timeline entry。

---

## 8. 迁移计划

### PR 1：引入 timeline model 与 selectors

新增：

```txt
services/local-agent/src/tui/timeline/agentTimeline.ts
services/local-agent/src/tui/timeline/agentTimelineSelectors.ts
services/local-agent/src/tui/timeline/operationPresentation.ts
```

内容：

- 定义 `AgentTimelineEntry`。
- 提供 legacy `HistoryCellModel -> AgentTimelineEntry` adapter。
- 提供 running operations selectors。
- 不改 UI。

测试：

- entry id 稳定性。
- legacy history adapter。
- running operation selector。

### PR 2：reducer 双写 timeline

在保留 `history / assistantDraft / activeOperations` 的同时，开始写 `timeline`。

目标：

- 降低风险。
- 用测试证明 timeline 能表达当前 UI 全部状态。

测试：

- `run.start` append user entry。
- `message.delta` create/update assistant streaming entry。
- operation lifecycle update same operation entry。
- terminal operation 不再需要额外 system text 才能表达结果。

### PR 3：实现 AgentTimeline component

新增组件：

```txt
tui/components/AgentTimeline.tsx
tui/components/AgentTimelineItem.tsx
tui/components/AgentMessageItem.tsx
tui/components/AgentOperationItem.tsx
```

先以当前 visual 风格渲染 timeline，不做大视觉改版。

测试：

- timeline item render text 不重叠。
- operation item 不读取 raw。
- assistant streaming segment 与 operation 顺序正确。

### PR 4：TuiApp 切换到 AgentTimeline

用 `AgentTimeline` 替换当前 message history + active operation lines 的组合展示。

保留 busy status，但从 timeline selector 派生。

### PR 5：删除重复 state

删除或降级这些字段：

- `assistantDraft`
- `subagentDraft`
- `activeOperations`
- operation-as-system-history 的特殊路径

`history` 迁移为兼容导入/导出层，核心 UI 用 `timeline`。

### PR 6：browser operation UX pass

基于 #216，把 browser metadata + operation item 展示补齐：

- open/click/type/wait/snapshot 的 active/completed/failed 展示。
- sensitive text redaction。
- JSON-string input / raw-string output contract tests。

---

## 9. 验收标准

重构完成后应满足：

1. TUI 可以按真实执行顺序展示：

   ```txt
   assistant -> operation -> operation result -> assistant
   ```

2. operation start/update/end 是同一个 timeline entry 的状态变化。
3. TUI 不再把 completed operation 强行降级为 `system` text cell。
4. active operation UI 可以由 timeline selector 派生。
5. TUI component 不读取 raw tool payload。
6. `LocalAgentEvent` 协议不需要为第一阶段 timeline 重构破坏性改动。
7. browser tool call 的 URL / selector / page title 等关键上下文能稳定展示。
8. message export/resume/history load 有 legacy adapter，不丢旧会话。

---

## 10. 非目标

本次重构不做：

- 不重写 local-agent wire protocol。
- 不把 raw tool payload 暴露给 TUI component。
- 不立即引入 OpenTUI。
- 不把所有 studio progress 设计成完整 timeline DAG。
- 不改 agent runtime 的 tool execution 语义。

---

## 11. 关键设计判断

### 11.1 Timeline 是 presentation model，不是 event log

`LocalAgentEvent` 是协议事件；`AgentTimelineEntry` 是 TUI presentation state。

同一个 protocol event 可以：

- append 一个 timeline entry
- update 一个 timeline entry
- finalize 一个 timeline entry
- 只改变 activeRun phase

因此 timeline 不是 append-only raw event log，而是用户可读的 agent execution transcript。

### 11.2 Operation entry 表示 lifecycle，不表示 raw tool call

名字叫 operation，而不是 tool call，是因为它可能来自：

- toolkit tool
- capability toolset
- runtime activity
- browser/file/shell/git operation

它是 agent 对用户可见的“操作”，不等同于底层 tool call payload。

### 11.3 Assistant message 可以分段

为了表达：

```txt
AI -> tool call -> result -> AI
```

assistant message 不应该强行只有一个最终 cell。它可以在 timeline 中按 run 中断点分段。最终 `message.completed` 仍代表本轮 assistant final text，但 TUI timeline 可以保留分段 presentation。

### 11.4 先兼容，后替换

当前 TUI 已有大量 reducer/render 测试。迁移应先双写 timeline，再替换组件，最后删除重复 state。不要一次性把 `history`、`assistantDraft`、`activeOperations` 全部移除。
