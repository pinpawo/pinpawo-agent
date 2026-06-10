# Human Review Approval Refactor Design

> 状态：Draft v2
> 日期：2026-06-09
> 关联：issue #82，PR #76

## 1. 文档目标

这份文档用于重新设计 human review approval 的数据模型和端到端交互流程。

当前 PR #76 尝试把 `/allow` 这种文本魔法改成 typed resume extras，方向是正确的，但也暴露出更大的架构问题：toolkit review policy、graph checkpoint/state、WebSocket 协议、TUI approval UI 之间的边界不清晰。

重构目标不是只修 `ApprovalPanel.tsx`，而是建立一个简单、可扩展、可验证的 review 交互协议：

- review producer 明确给出用户要看的内容。
- review producer 明确给出用户可选择的 options。
- UI 只负责渲染 view 和 options。
- 用户 response 只提交 option id 和必要输入。
- graph/tool runtime 根据当前 interrupt payload / `ReviewResolutionContext` 解析 decision 和 review effects。
- authorization state 写入 graph state/checkpoint，由 tool review policy 在下一次 tool call 前读取。
- local-agent server 只做 transport/session 连接，不拥有 shell 授权语义。

## 2. 当前问题

### 2.1 `ApprovalPanel.tsx` 承担了协议解释

当前 TUI approval 组件会解析 `payload.actionRequests` / `payload.reviewConfigs`，并根据内部 action name 推导 UI options。

问题例子：

```ts
if ((actionName === 'shell' || actionName === 'run_shell') && command) {
  // 构造本次会话授权 option
}
```

这让 TUI 组件知道了 local-agent tool 的名字和参数结构。后续如果 shell tool 改名、插件提供类似 shell 的 action，或 action 参数结构变化，UI 层都会受到影响。

### 2.2 `human_review_response` 曾经混合了多种语义

重构前 response 同时承载：

- 展示给用户看的 message。
- graph resume decision。
- session/thread 路由信息。
- authorization side effect，例如 session shell authorization。

这些语义混在一起后，transport 层会被迫理解 graph/tool runtime 语义，也很难明确判断某个 authorization 是否来自一个有效的、被声明过的 review option。

### 2.3 Toolkit review policy 只覆盖了一部分约定

`ToolkitToolReviewPolicy` 已经定义了：

- 哪些 tool call 需要 human review。
- review request 如何构造。
- edit decision 如何应用。

但它还没有定义：

- 这个 review 给用户哪些可选项。
- 哪些 option 只是普通 graph decision。
- 哪些 option 会触发 graph/tool review effect。
- option 对 UI 的展示文案和危险等级。

因此 UI 只能从 raw payload 里推断。

### 2.4 Authorization state 放错层

session shell authorization 发生在 `LLM -> tool call -> tool execution` 之间，本质上属于 graph/tool runtime 的执行策略，而不是 local-agent server 的 transport 语义。

它应该满足：

- 当前 pending review 声明过这个 option 或 effect。
- 当前用户选择的 option 对应 `approve`。
- 当前 response resume 到同一个 graph thread/checkpoint。
- pending action 仍然是被授权的 action。

这些校验不应该由 UI 保证，也不应该依赖 message 文本。

## 3. 设计原则

### 3.1 Review 是一个可渲染、可选择的交互 spec

human review 不应该只是 `prompt + actionRequests + reviewConfigs`，再让客户端自行推导交互。

更合理的核心对象是 `ReviewSpec`：

```ts
type ReviewSpec = {
  id: string;
  schemaVersion: number;
  view: ReviewView;
  options: ReviewOption[];
};
```

它同时包含：

- 用户要看的 view。
- 用户可以选的 options。
- option 选择后对应的 decision。
- option 可能附带的 review effects。

`ReviewSpec.id` 是一次 pending review 的身份标识，由 graph/tool runtime 在 materialize 并校验 spec 后生成。只要 review 内容发生变化，或者 graph 进入下一次 human review，就必须生成新的 `ReviewSpec.id`。`schemaVersion` 只表示 ReviewSpec 协议版本，不用于 stale 校验；V1 使用 `schemaVersion: 1`，但类型保持 `number`，V2 出现时不需要让所有 producer 端字面量类型断裂。V1 不引入 `reviewVersion`。

### 3.2 Options 可以静态或动态生成，但传输时必须 materialize

review option 的来源可能有三类：

- 代码静态声明。
- 模型生成。
- 函数根据上下文动态生成。

但函数不能跨 WebSocket 传输，模型输出也不能直接交给 UI 自由解释。因此在发送给客户端之前，review producer / graph/tool runtime 必须把 options materialize 成稳定数据：

```ts
type ReviewOptionsSource =
  | ReviewOption[]
  | ((ctx: ReviewContext) => Promise<ReviewOption[]>);
```

传给 UI 的永远是：

```ts
options: ReviewOption[];
```

如果 options 来自模型输出，runtime 必须先做 schema validation 和 capability filtering。模型可以提出普通展示文案或普通 decision option，但不能单独声明 privileged effect，例如 `graph.authorize_tool_action`。这类 effect 必须由 toolkit policy / trusted adapter 代码添加。

### 3.3 UI 不解释 tool 语义

TUI / Studio / Web UI 只消费 `ReviewSpec.view` 和 `ReviewSpec.options`。

UI 不应该知道：

- `run_shell`
- `shell`
- `git_commit`
- `args.command`
- `reviewConfigs.allowedDecisions`

这些都属于 review producer / adapter / runtime 的职责。

### 3.4 Authorization 属于 graph/tool runtime，不属于 transport

“本会话授权”这种状态要跟 graph thread/checkpoint 走。local-agent server/TUI 不应该拥有 shell authorization store，也不应该把 authorization 当成 WebSocket extras 处理。

授权状态的 owner 应该是 graph/tool runtime：

- tool review policy 在 tool 执行前读取 graph state 里的 authorizations。
- 未命中 authorization 时，tool review policy 生成 `ReviewSpec` 并触发 interrupt。
- graph resume 后，根据 selected option 对应的 effect 更新 graph state。
- 当前 tool call 继续按 selected option 的 decision 执行。

这样 TUI、Studio、App 都只是 review UI。无论用户从哪个客户端批准，authorization 都落在同一个 graph thread/checkpoint 上。

### 3.5 `message` 不驱动行为

用户展示文案可以作为 history/display 字段保留，但 runtime 行为必须来自 typed option 和当前 interrupt/checkpoint 持有的 review payload。

也就是说：

- graph resume payload 来自客户端提交的 `selectedOptionId`。
- graph/tool runtime 再从 selected option 解析 decision。
- graph/tool runtime state transition 来自 selected option 的 effects。
- session routing 来自 runtime metadata。

### 3.6 术语定义

后续实现需要统一这些术语：

- `session`：local-agent 的一次聊天会话，对应一个 graph thread/checkpoint 上下文。它不是用户登录 session。
- `request`：一次 agent run / turn 的请求，用 `requestId` 在 WebSocket event、TUI active run、graph thread/checkpoint 路由之间做关联。
- `review`：一次 pending human review 交互。一个 request 运行过程中可以顺序产生多个 review；任意时刻只有当前 pending review 的 `reviewId` 可以被接受。review 的完整 payload 由 LangGraph interrupt/checkpoint 持有，不作为普通业务 state 复制一份。
- `decision`：graph/tool runtime resolve option 后得到的 human review 决策，用于处理当前 pending action。V1 只有 approve、reject、respond；edit 后续必须作为新的 canonical option/input 重新设计。
- `effect`：选择某个 option 后，graph/tool runtime 需要额外应用的状态变更，例如“在当前 graph thread 授权当前 pending shell action”。effect 由 graph/tool runtime 根据 `selectedOptionId` 从 pending `ReviewSpec` 中解析出来；它不是 transport extras，也不是 tool input。

### 3.7 Owner matrix

实现时按下面的 owner 切边界，避免同一个语义在多层重复解释：

| 对象 | Owner | 可读方 | 不允许做的事 |
| --- | --- | --- | --- |
| `ReviewSpec` | trusted review producer + graph runtime materializer | UI、transport、graph runtime | UI 不修改、不补全 option |
| current review payload / `ReviewResolutionContext` | LangGraph interrupt/checkpoint + graph/tool runtime stack frame | graph/tool runtime | client 不提交 pending action |
| `HumanReviewResponseMessage` | client transport | local-agent server、graph/tool runtime | client 不提交 decision/effects/sessionId |
| `ReviewResponseResolution` | graph/tool runtime resolver | graph/tool runtime | transport 不解析 tool args |
| authorization state | graph state/checkpoint | tool review policy / wrapper | local-agent server 不保存 authorization store |
| request/session/thread route | local-agent server runtime metadata | local-agent server | client extras 不参与证明路由 |

这张表是实现边界：如果某层需要读表中“不允许做”的字段，说明设计正在回退到旧耦合。

## 4. V1 范围

第一版只实现最小闭环，不提前做复杂 view blocks。

V1 view schema：

```ts
type ReviewView =
  | { kind: 'plain'; title?: string; body: string }
  | { kind: 'markdown'; title?: string; body: string };
```

V1 option schema：

```ts
type ReviewOptionInput =
  | {
      kind: 'text';
      key: 'message';
      label?: string;
      placeholder?: string;
      required?: boolean;
      multiline?: boolean;
    };

type ReviewOptionDecision =
  | { type: 'approve' }
  | { type: 'reject'; message?: string }
  | { type: 'respond'; messageInputKey: 'message' };

type ReviewOption = {
  id: string;
  label: string;
  description?: string;
  variant?: 'primary' | 'normal' | 'danger';
  input?: ReviewOptionInput;
  decision: ReviewOptionDecision;
  effects?: ReviewEffect[];
};
```

`ReviewOption.id` 是稳定协议 key，不是展示文案。它应该由 trusted builder/materializer 生成，不能从 `label` 翻译文本推导；同一个 `ReviewSpec.options` 内必须唯一。

V1 server event schema：

```ts
type HumanReviewRequestedEvent = {
  type: 'human_review.requested';
  requestId: string;
  review: ReviewSpec;
  actor?: { petId?: string };
};
```

TUI 展示只能读取 `review.view` / `review.options`。raw interrupt payload 不进入 TUI state，也不能驱动 runtime 行为。旧 request interrupt adapter 已移除。

V1 response schema：

```ts
type HumanReviewResponseMessage = {
  type: 'human_review_response';
  requestId: string;
  reviewId: string;
  selectedOptionId: string;
  input?: Record<string, unknown>;
};
```

`input` 在 V1 中用于 `respond` 的文本反馈，约定字段为 `input.message`。`edit` 的结构化输入后续再扩展。

`reviewId` 用于 stale response 校验。客户端必须回传当前 `ReviewSpec.id`；local-agent transport 和 graph/tool runtime 都应拒绝与当前 pending review 不匹配的 `reviewId`。

V1 response 是封闭协议面：除 `type`、`requestId`、`reviewId`、`selectedOptionId`、`input` 外，transport parser 必须拒绝额外字段。`message`、`resume`、`decisions`、`decision`、`effects`、`originSessionId` 等旧字段不能被忽略后继续传入 runtime。

V1 action cardinality：

- 一个 `ReviewSpec` 对应一个 pending tool action。
- `actionRef: { type: 'pending_action' }` 只在 pending review 有且只有一个 pending action 时合法。
- 后续如果要支持一次 review 多个 action，需要增加显式 action id，例如 `actionRef: { type: 'action_id'; actionId: string }`，不能复用隐式 `pending_action`。

V1 response 不携带 `schemaVersion`，也不携带 `reviewVersion`。stale 校验只看当前 pending review 的 `reviewSpec.id`。

V1 field ownership：

- `requestId`：transport route key，由 server 建立 request -> session/thread metadata。
- `reviewId`：pending review key，由 graph/tool runtime 在 interrupt payload 中 materialize，并由 LangGraph checkpoint 持有当前 pending review 的控制态。local-agent server 也应该在 route metadata 中缓存 `requestId -> reviewId`，client 提交时先做 fast-path stale 校验；graph/tool runtime 仍然必须做权威校验。
- `selectedOptionId`：用户选择的 option key。
- `input`：selected option 声明过的用户输入；V1 只支持 `respond` 的 `input.message`。

V1 不实现：

- blocks view。
- HTML view。
- image view。
- diff/table/code 专用渲染。
- 客户端自定义 option resolver。
- 通用 form / `edit` 的结构化 action 编辑器。

这些能力后续可以通过扩展 `ReviewView` 支持：

```ts
type ReviewView =
  | { kind: 'plain'; title?: string; body: string }
  | { kind: 'markdown'; title?: string; body: string }
  | { kind: 'html'; title?: string; body: string }
  | { kind: 'blocks'; title?: string; blocks: ReviewViewBlock[] };
```

未来 terminal 支持图片，可以增加 image block；Web 支持 HTML，可以增加 html block 或 html view variant。

## 5. 建议数据模型

### 5.1 Human review decision

V1 canonical decision 只有三种：

```ts
type ReviewResolvedDecision =
  | { type: 'approve' }
  | { type: 'reject'; message?: string }
  | { type: 'respond'; message: string };
```

三种 decision 的语义：

- `approve`：批准当前 pending action，tool wrapper 可以继续执行原 action。
- `reject`：拒绝当前 pending action，tool wrapper 不执行该 action，并把拒绝信息返回给 graph/model。
- `respond`：不执行当前 pending action，而是把用户的一段反馈/新指令返回给 graph/model，让模型重新规划下一步。例如用户看到 `rm -rf tmp` 后回复“不要删除，先列出目录看看”。它需要用户输入文本。

V1 的 TUI materialize 这四类 option：

- `approve` option：只包含 approve decision。
- `approve-with-effect` option：approve decision + `graph.authorize_tool_action` effect。
- `reject` option：reject decision。
- `respond` option：respond decision + 最小文本输入 `input.message`。

`edit` 需要结构化 action/args 编辑器，后续作为新的 canonical option/input 重新设计；V1 不保留旧 `HumanReviewActionRequest` / `applyEdit` 通道。

### 5.2 Review effect

review effect 表示 graph/tool runtime 在 resume 后要应用的状态变更。它不等同于 graph resume decision，也不是 WebSocket transport extras。

它解决的是“用户选择这个 option 后，除了批准/拒绝当前 pending action 之外，graph/tool runtime 还要记录什么执行策略”。例如 shell review 中的“本次会话授权”：

- `decision: { type: 'approve' }` 表示批准当前 pending tool call。
- `effects: [{ type: 'graph.authorize_tool_action', ... }]` 表示在 graph state 中记录 authorization，用于后续同 thread 匹配 action 的免审。

effect 不能替代 decision；decision 也不应该隐式携带 effect。

effects 放在 `ReviewOption` 上，而不是放在 `ReviewOptionDecision` 上。这样同一个 approve decision 可以有两个不同 option：普通“批准”和“批准并在本会话授权”。`approve-with-effect` 是 option 类型，不是新的 decision 类型。

```ts
type ReviewEffect =
  | {
      type: 'graph.authorize_tool_action';
      scope: 'thread';
      actionRef: ReviewActionRef;
      matcher: ToolAuthorizationMatcherTemplate;
    };

type ReviewActionRef =
  | { type: 'pending_action' };

type ToolAuthorizationMatcherTemplate =
  | { type: 'policy_hook' }
  | { type: 'shell_pattern'; source: 'args.command' }
  | { type: 'exact_args'; source: 'action.args' };

type ToolAuthorizationMatcher =
  | { type: 'exact_args'; value: Record<string, unknown> }
  | { type: 'shell_pattern'; value: string };
```

V1 只需要支持 session authorization 这一个 effect。

`shell_pattern.value` 是由 shell policy 归一化后的 matcher pattern。是否支持 `*` / `?`、如何规整空白、是否允许用户输入自定义 pattern，都属于 shell policy/runtime 的规则；UI 只展示 option，不解释 pattern。

重要约束：

- `ReviewEffect` 只能由 pending `ReviewSpec.options` 声明。
- 客户端不能临时构造未声明的 effect。
- graph/tool runtime 必须根据 `selectedOptionId` 从当前 interrupt payload / `ReviewResolutionContext` 解析 effect。
- effect 的应用必须经过 graph/tool runtime 校验，例如 authorization 必须要求 selected option 的 decision 是 approve。
- `actionRef` 不能是任意字符串；V1 只支持 `{ type: 'pending_action' }`。
- `matcher` 不能省略；producer 必须显式声明 matcher template，或者显式声明 `{ type: 'policy_hook' }`。
- matcher 推导属于 tool wrapper / review policy 的 hook。`matcher: { type: 'policy_hook' }` 表示由当前 action 对应的 policy 负责从 pending action 生成 matcher，例如 `run_shell.args.command -> shell_pattern`。UI 和 local-agent server 都不解释 tool args。

hook 的目标接口可以是：

```ts
type ToolAuthorizationMatcherHook = (ctx: {
  effect: Extract<ReviewEffect, { type: 'graph.authorize_tool_action' }>;
  pendingAction: PendingReviewAction;
  reviewSpec: ReviewSpec;
}) => ToolAuthorizationMatcher | null;
```

返回 `null` 表示当前 pending action 不能生成 authorization matcher，runtime 必须拒绝该 effect，不能降级成 approve-only。

### 5.3 Authorization state

authorization state 应该进入 graph state/checkpoint，而不是 local-agent server 的外部 map。

V1 可以定义一个窄状态：

```ts
type ReviewAuthorizationState = {
  toolAuthorizations: ToolAuthorization[];
};

type ToolAuthorization = {
  id: string;
  toolName: string;
  scope: 'thread';
  matcher: ToolAuthorizationMatcher;
  sourceReviewId: string;
  createdAt: string;
};
```

文案里的“本会话授权”在数据模型中等价于 `scope: 'thread'`：授权只对当前 graph thread/checkpoint 生效。它不是登录 session，也不是 local-agent 进程级全局授权。

shell review 的“本会话授权”可以落成：

```ts
{
  id: 'auth-1',
  toolName: 'run_shell',
  scope: 'thread',
  matcher: { type: 'shell_pattern', value: 'git status' },
  sourceReviewId: 'review-123',
  createdAt: '2026-06-09T00:00:00.000Z',
}
```

后续 `run_shell` 被调用时，tool review policy 先读取当前 graph state 的 `toolAuthorizations`：

```txt
tool call -> read graph state authorizations -> match -> skip human review
```

### 5.4 Review option

```ts
type ReviewOption = {
  id: string;
  label: string;
  description?: string;
  variant?: 'primary' | 'normal' | 'danger';
  input?: ReviewOptionInput;
  decision: ReviewOptionDecision;
  effects?: ReviewEffect[];
};
```

示例：普通 approve。

```ts
{
  id: 'approve',
  label: '批准执行',
  variant: 'primary',
  decision: { type: 'approve' },
}
```

示例：批准并在本会话授权 pending action。

```ts
{
  id: 'approve-and-authorize-session',
  label: '批准并在本会话授权',
  variant: 'primary',
  decision: { type: 'approve' },
  effects: [
    {
      type: 'graph.authorize_tool_action',
      scope: 'thread',
      actionRef: { type: 'pending_action' },
      matcher: { type: 'policy_hook' },
    },
  ],
}
```

示例：reject。

```ts
{
  id: 'reject',
  label: '拒绝',
  variant: 'danger',
  decision: { type: 'reject' },
}
```

示例：respond。

```ts
{
  id: 'respond',
  label: '补充说明',
  input: {
    kind: 'text',
    key: 'message',
    label: '说明',
    placeholder: '告诉 agent 你希望它怎么调整下一步',
    required: true,
    multiline: true,
  },
  decision: { type: 'respond', messageInputKey: 'message' },
}
```

## 6. 端到端流程

### 6.1 Producer materialize review spec

toolkit policy / model / function 生成 review request 时，最终要经过 trusted materializer 得到 `ReviewSpec`。policy 可以提供 view/options 内容；graph/tool runtime materializer 负责校验、补齐 `id` / `schemaVersion`，并过滤不被允许的 effect。

对于 shell review，producer 可以生成：

```ts
{
  id: 'review-123',
  schemaVersion: 1,
  view: {
    kind: 'plain',
    title: '需要确认',
    body: '即将执行高风险 shell 命令。\n目录：...\n命令：...',
  },
  options: [
    {
      id: 'approve',
      label: '批准执行',
      variant: 'primary',
      decision: { type: 'approve' },
    },
    {
      id: 'approve-and-authorize-session',
      label: '批准并在本会话授权',
      variant: 'primary',
      decision: { type: 'approve' },
      effects: [
        {
          type: 'graph.authorize_tool_action',
          scope: 'thread',
          actionRef: { type: 'pending_action' },
          matcher: { type: 'policy_hook' },
        },
      ],
    },
    {
      id: 'reject',
      label: '拒绝',
      variant: 'danger',
      decision: { type: 'reject' },
    },
    {
      id: 'respond',
      label: '补充说明',
      input: {
        kind: 'text',
        key: 'message',
        required: true,
        multiline: true,
      },
      decision: { type: 'respond', messageInputKey: 'message' },
    },
  ],
}
```

### 6.2 Pending review 由 interrupt/checkpoint 持有

graph/tool runtime 在触发 `interrupt()` 前，需要 materialize 当前 review payload。LangGraph interrupt/checkpoint 自己会持有“当前卡在哪个 review、resume 要回到哪个 stack frame”这类控制态；不要再把同一份 pending review 复制到普通 graph state channel。

```ts
type ReviewResolutionContext = {
  reviewSpec: ReviewSpec;
  pendingAction?: PendingReviewAction;
};

type PendingReviewAction = {
  actionId: string;
  toolName: string;
  args: Record<string, unknown>;
  description?: string;
};
```

`ReviewResolutionContext` 是当前 interrupt stack frame 里的解析上下文，不是 graph state。`reviewSpec.id` 必须在触发 interrupt 前稳定 materialize：tool review 用 pending action 的 stable `actionId`（例如 `tool_call_id`）派生；iteration-limit 这类 runtime gate 用当前 gate 上下文派生。这样 resume 重放时不会因为重新 `randomUUID()` 造成 stale review 循环。

local-agent server 可以缓存 requestId/reviewId/sessionId 到 active graph thread 的路由关系，但不缓存 authorization，也不解释 shell tool 语义。

`pendingAction` 只在 review 代表某个待执行 tool action，且后续 effect resolution 需要这个 action 上下文时存在；iteration-limit 这类 runtime gate 不应该伪造成 tool action。`pendingAction` 是 graph/tool runtime 自己保存的执行上下文，不来自 client response。matcher hook 必须读取这个 `pendingAction`，不能反向读取 UI payload。

长期免审只能来自 `graph.authorize_tool_action` effect 写入的 graph authorization state。普通 approve/reject/respond 不需要额外的 one-shot graph state；resume 会回到原来的 interrupted stack frame，wrapper 直接消费解析后的 decision。

### 6.3 UI 渲染 review spec

`ApprovalPanel.tsx` 接收简单 props：

```ts
type ApprovalPanelProps = {
  review: ReviewSpec;
  selectedIndex: number;
  width: number;
  petId?: string;
};
```

它只做：

- 渲染 `view.title`。
- 渲染 `view.body`。
- 渲染 options。
- 如果 selected option 有 `input`，渲染对应的最小文本输入状态。
- 高亮 selected option。

它不做：

- 解析 `actionRequests`。
- 解析 `reviewConfigs`。
- 构造 `resume`。
- 构造 `extras`。
- 判断 tool/action name。

TUI 的 input controller 负责根据 selected option 的 `input` 配置收集 `input.message`，并在 submit 时随 `selectedOptionId` 一起发送。

### 6.4 用户提交 selected option

TUI 提交：

```ts
{
  type: 'human_review_response',
  requestId: 'req-1',
  reviewId: 'review-123',
  selectedOptionId: 'approve-and-authorize-session',
}
```

respond option 提交：

```ts
{
  type: 'human_review_response',
  requestId: 'req-1',
  reviewId: 'review-123',
  selectedOptionId: 'respond',
  input: { message: '不要删除，先列出目录看看。' },
}
```

客户端不提交 `decision`，也不提交 `effects`。

local-agent server 收到 `human_review_response` 后只构造 graph resume payload；不能把它转成新的 `chat_request`，也不能为了复用 chat 入口而追加空的 `HumanMessage`。review response 是对当前 interrupt 的 resume，不是新的用户消息。

### 6.5 Graph/tool runtime resolve response

graph/tool runtime 根据当前 interrupt stack frame 中 materialized 的 review payload 解析：

```ts
type ReviewResponse = {
  reviewId: string;
  selectedOptionId: string;
  input?: Record<string, unknown>;
};

const response = interrupt({
  kind: 'review',
  review: reviewPayload.review,
  pendingAction: reviewPayload.pendingAction,
}) as ReviewResponse;
const option = reviewPayload.review.options.find(
  (item) => item.id === response.selectedOptionId,
);
```

resolver 输出一个 runtime 内部对象：

```ts
type ReviewResponseResolution = {
  reviewId: string;
  optionId: string;
  decision: ReviewResolvedDecision;
  effects: ReviewEffect[];
  display: {
    label: string;
    userInputMessage?: string;
  };
};
```

其中：

- `decision` 来自 pending `ReviewSpec.options` 和受校验的 `input`。
- `effects` 只能来自 pending `ReviewSpec.options`。
- `display.label` 是 option label，只用于 history/log，不驱动行为。
- `display.userInputMessage` 只在 `respond` decision 时填入用户输入文本，用于 history 展示；它不是 option description，也不是 runtime decision source。

`respond` 的处理要和普通用户消息区分开：它不创建新的 chat request，不追加一条新的 free-form user message 来绕过 pending tool call。graph/tool wrapper 应把它解析成 `{ type: 'respond', message }`，不执行当前 pending action，并把 human message 作为当前 tool call 的取消/反馈结果返回给 graph/model，让模型在同一个 run 里继续规划。

### 6.6 Graph/tool runtime 校验 response / effects

resolve response 和执行 effect 前必须校验：

- `requestId` 能 resume 到唯一 pending graph thread/checkpoint。
- `reviewId` 必须等于当前 pending review 的 `reviewSpec.id`；不匹配说明客户端提交了 stale response，必须拒绝。
- session/thread 路由信息来自 server/runtime metadata，而不是 client extras。local-agent server 必须用自己保存的 `requestId -> { sessionId, threadId, reviewId }` 路由 pending review；如果当前连接/当前 TUI focus 的 session 与这条 pending route 不匹配，必须拒绝 resume，避免把 response 送到错误 checkpoint。
- `originSessionId` 这类 client extras 不再作为 review response 协议字段。客户端不回传 session id 来证明自己，server/runtime 用自己保存的 request -> session/thread metadata 做路由和校验。
- 同一个 pending review 多客户端并发提交时，采用 first response wins：第一个通过校验并成功 resume 的 response 消费 pending review；后续 response 因 `reviewId` 不再匹配当前 pending review 而拒绝。
- `selectedOptionId` 存在于 pending spec。
- effect 来自 pending spec，而不是客户端临时传入。
- 对于 session authorization，`option.decision.type === 'approve'`。
- pending action 仍然存在并且能生成 authorization matcher。

### 6.7 Graph resume and apply effects

local-agent server resume graph 时只传用户选择：

```ts
resume = {
  reviewId: msg.reviewId,
  selectedOptionId: msg.selectedOptionId,
  ...(msg.input ? { input: msg.input } : {}),
};
```

graph/tool runtime resume 后再从 pending `ReviewSpec` 解析 decision 和 effects：

```ts
const resolution = resolveHumanReviewResponse({
  reviewSpec: reviewPayload.review,
  pendingAction: reviewPayload.pendingAction,
}, response);
```

effect 必须在继续执行 pending action 之前应用。对于 `graph.authorize_tool_action`，runtime 先根据 pending action 和 policy matcher hook 生成 authorization record 并写入 graph state；写入失败时不能执行该 tool call。

`resolveHumanReviewResponse()` 负责校验输入：

- `approve` / `reject` 不需要 input。
- `respond` 必须提供非空 `input.message`。
- `input` 只能包含 selected option 声明过的 key；V1 未声明或多余的 input key 必须拒绝，不能作为新的 extras 通道。
- V1 不解析 `edit`。

graph/tool runtime effect：

```ts
for (const effect of resolution.effects) {
  applyReviewEffect(state, effect);
}
```

effect application 和当前 decision 处理必须在 graph/tool runtime 内形成一个原子步骤：如果 authorization effect 校验或写入失败，不能继续执行当前 tool call。当前 tool call 随后按 `resolution.decision` 继续执行；后续 tool call 进入 review policy 前，先读取 graph state 中的 authorizations。

### 6.8 Pending review lifecycle

V1 需要明确几个运行时边界：

- 多客户端并发：同一个 graph thread 的同一个 pending review 可以被 TUI、Studio、App 等多个客户端看到，但只有第一个通过 `requestId + reviewId + session/thread` 校验的 response 生效。其他客户端提交同一 review 的 response 时应收到 stale/review-closed 错误。
- timeout / cancellation：LangGraph interrupt 本身不定义 timeout。local-agent 可以做 UI 层提示或 session 清理，但取消 pending review 必须 resume graph 为一个明确 decision，例如 `{ type: 'reject', message: 'review cancelled' }`，或显式中断当前 run。不能只清理 UI 状态而让 graph checkpoint 悬挂。
- `respond` 不创建新的 requestId。它仍然是当前 request/run 的 human review resume：graph/tool runtime 将 `input.message` 转成 `{ type: 'respond', message }`，把反馈交回 model 继续规划下一步。TUI 不应把 respond 当成一条新的普通用户消息。

V1 cancellation 默认策略：

- 用户主动 `/interrupt`：如果当前 session/thread 有 pending review，server 应 resume 当前 review 为 reject，例如 `{ type: 'reject', message: 'interrupted by user' }`，并清理本地 active run 状态。
- WebSocket 断开：默认保留 graph checkpoint 中的 pending review，不自动 reject。下次客户端连接并恢复同一 session/thread 时，server 应重新发送当前 pending `ReviewSpec`。
- TUI 进程崩溃或 local-agent 重启：只要 graph checkpoint 仍存在，pending review 继续保留；启动后通过 session/thread recovery 重新发现并展示。只有用户明确中断或 session 被显式删除时，才 resume reject 或删除对应 checkpoint。

### 6.9 Runtime entry points

当前代码有两条 HITL 入口，重构后都要归一到同一个 `ReviewSpec` / response resolver：

- TUI / App chat：通过 LangGraph checkpoint 中的 pending interrupt 恢复。server 从 `requestId` 找到 thread/checkpoint，并把 `{ reviewId, selectedOptionId, input }` 作为 resume payload。
- Studio humanReviewer：可以保留 `createWsHumanReviewer()` 里的 pending promise slot，但 pending slot 必须保存当前 `ReviewSpec`。收到 canonical response 后校验 `reviewId` / `selectedOptionId`，并把 canonical `{ reviewId, selectedOptionId, input }` 作为 graph resume payload。

也就是说，Studio 可以保留 promise slot 这个控制流实现，但不能保留另一套 message text decoder。Studio review response 只允许 canonical `{ reviewId, selectedOptionId, input }`；不能再从 `message` 文本或 `resume.decisions` 猜 decision。

## 7. Toolkit policy 调整

### 7.1 LangGraph / LangChain 现有能力判断

当前依赖中有两类相关能力：

1. LangGraph core
   - `interrupt()` / `Command({ resume })`
   - checkpointer / thread id
   - graph state / store

   LangGraph core 负责“暂停、保存状态、恢复执行”，但没有内置通用 permission / authorization store。

2. LangChain agent middleware
   - `humanInTheLoopMiddleware`
   - `interruptOn` per-tool policy
   - `approve` / `edit` / `reject` decision handling

   这个 middleware 运行在 model 产出 tool call 之后、tool 执行之前，结构上很接近我们需要的 review gate。但它解决的是“单次 tool call 是否需要 human approval”，不负责“本 graph thread 后续相似 action 免审”的 authorization state。它的 `edit` decision 不作为本项目 V1 兼容通道保留；后续编辑能力必须走新的 canonical option/input 设计。

因此本项目 V1 推荐：

- 继续使用 LangGraph interrupt/checkpointer/state 作为基础。
- 不把 authorization state 放在 local-agent server。
- 在 pet-agent graph state 中新增 authorization state。
- 在 toolkit review policy / tool wrapper 中读取 graph state authorizations。
- 借鉴 `humanInTheLoopMiddleware` 的结构，但保留我们自己的 `ToolkitToolReviewPolicy` 和 `ReviewSpec`。

### 7.2 Policy API

当前接口只返回 `ReviewSpec`，不再暴露旧 request union。

目标形态：

```ts
type ToolkitToolReviewPolicy = {
  request: (
    ctx: ToolkitToolReviewContext
  ) => ReviewSpec | null | Promise<ReviewSpec | null>;
  buildAuthorizationMatcher?: (
    ctx: ToolkitToolReviewContext & {
      effect: Extract<ReviewEffect, { type: 'graph.authorize_tool_action' }>;
      pendingAction: PendingReviewAction;
    }
  ) => ToolAuthorizationMatcher | null | Promise<ToolAuthorizationMatcher | null>;
};
```

`buildAuthorizationMatcher` 只在 selected option 的 effect 使用 `matcher: { type: 'policy_hook' }` 时调用。对于 shell policy，它可以把 `pendingAction.args.command` 映射成 `{ type: 'shell_pattern', value }`；对于不支持 session authorization 的 tool，不实现这个 hook。

Policy 必须明确声明 options，而不是从旧 `allowedDecisions` 推断 option：

```ts
return buildReviewSpec({
  view: {
    kind: 'plain',
    title: '需要确认',
    body: prompt,
  },
  options: [
    approveOption(),
    approveAndAuthorizeSessionOption(),
    rejectOption(),
    respondOption({ inputKey: 'message' }),
  ],
});
```

为了避免 review policy 的定义变复杂，具体 toolkit 代码不应该手写大段 JSON。建议提供一组简单 builder：

```ts
return reviewSpec({
  view: plainReview(prompt, { title: '需要确认' }),
  options: [
    approve(),
    approveWithEffect(
      'approve-and-authorize-session',
      '批准并在本会话授权',
      authorizePendingActionForSession(),
    ),
    reject(),
    respond({ inputKey: 'message' }),
  ],
});
```

这样 policy 的职责仍然清楚：

- 声明用户看到什么。
- 声明用户可以选什么。
- 声明某个 option 是否附带 graph/tool runtime effect。

复杂的协议字段由 builder 生成，不让每个 policy 重复拼结构。

后续支持结构化编辑时，再增加 canonical `edit` option 和对应的 structured input builder；不要复活旧的 action request 通道。例如：

```ts
edit({ inputKey: 'editedAction', argsSchema });
```

## 8. `ApprovalPanel.tsx` 重构方向

重构后的 `ApprovalPanel.tsx` 应该从当前状态：

```txt
PendingApproval
  -> parse raw payload
  -> infer action name
  -> infer command
  -> build options
  -> render
```

改为：

```txt
ReviewSpec view model
  -> render
```

option 构造迁移到独立模块，例如：

```txt
packages/pet-agent/src/agent/orchestrator/review/
  reviewSpec.ts
  reviewResponseResolver.ts
  reviewAuthorizations.ts

services/local-agent/src/tui/
  approvalPanelView.ts
```

`ApprovalPanel.tsx` 不应再导入 local protocol 类型，也不应导入 human review payload 类型。local-agent 的 TUI 层只接收已 materialized 的 `ReviewSpec` view model。

## 9. 迁移步骤

### PR 1a：引入 ReviewSpec 类型

- 新增 `ReviewSpec` / `ReviewView` / `ReviewOption` 类型。
- 保持现有 runtime / UI 行为不变。

### PR 1b：引入 review response resolver

- 在 pet-agent graph/tool runtime 中新增 `resolveHumanReviewResponse()`。
- 引入 `ReviewResolutionContext` 类型，表示当前 interrupt stack frame 中用于 resolve response 的上下文；它不写入普通 graph state。
- 本 PR 只解析 selected option 到 decision/effects，不应用 authorization effect。
- 测试覆盖 `reviewId` stale response、unknown option、respond missing `input.message`、未声明 input key。

### PR 1c：升级 transport protocol

- `human_review.requested` event 使用 canonical `review: ReviewSpec` 字段。
- local-agent protocol parser 只接受新 response 字段 `reviewId` / `selectedOptionId` / `input`，并拒绝旧的 `message` / `resume` / `decisions` / client session extras。
- local-agent server 缓存 `requestId -> { sessionId, threadId, reviewId }` route metadata，并对 response 做 fast-path stale 校验。
- canonical response 必须由 server 原样构造成 graph resume；decision/effects 只能由 graph/tool runtime 使用当前 interrupt payload / `ReviewResolutionContext` resolve。client 不能直接用 `resume` 决定 runtime 行为。
- 保持现有 UI 行为不变。
- 测试覆盖 canonical response、transport stale short-circuit、invalid option retry、session/thread route mismatch。

### PR 2：让 TUI 使用 ReviewSpec

- pending approval state 保存 `ReviewSpec`。
- `ApprovalPanel.tsx` 改成纯渲染。
- TUI submit 改成发送 `selectedOptionId` 和可选 `input`。
- TUI 支持 `respond` option 的最小文本输入，提交到 `input.message`。
- 删除 TUI 中的 `run_shell` / `shell` 等 tool/runtime 名称判断。
- `prompt` / `payload` 不进入 `ApprovalPanel.tsx`，也不驱动 runtime 行为。

### PR 3：session authorization 已迁移到 graph state

- `/allow` text magic 和 client-submitted authorization extras 已移除。
- `approve-with-effect` option 通过 `graph.authorize_tool_action` effect 表达授权意图。
- graph/tool runtime 从当前 interrupt payload / `ReviewResolutionContext` 解析 effect。
- shell review policy 明确声明 `approve-with-effect` option 和 `buildAuthorizationMatcher` hook。
- graph/tool runtime 校验 approve decision、thread、reviewId、option、single pending action 后写入 graph state authorization。
- tool review policy 在下一次 tool call 前读取 graph state `toolAuthorizations`。
- local-agent 不再维护独立 session authorization 模块；authorization 只从 graph state 读取。

### PR 4：收敛 toolkit policy API

- toolkit policy 直接返回 `ReviewSpec`。
- shell review policy 直接声明 options。
- 旧 request 返回类型和 adapter 已移除。

## 10. 验收标准

- `ApprovalPanel.tsx` 不出现任何 tool/action name 判断。
- TUI 不从 `args.command` 等 tool input 里推断行为。
- WebSocket response 不由 message 文本驱动 runtime 行为。
- 客户端不提交 decision 或 effects；只提交 selected option id 和必要输入。
- graph/tool runtime 从当前 interrupt payload / `ReviewResolutionContext` 解析 decision 和 effects。
- V1 支持 `respond` 的文本输入，并校验非空 `input.message`。
- V1 拒绝 selected option 未声明的 input key。
- graph/tool runtime 校验 session/thread、requestId、reviewId、option id 后才写入 authorization state。
- 同一个 pending review 多客户端并发提交时采用 first response wins，后续 stale/review-closed response 必须拒绝。
- shell session authorization 只能由 graph pending review 中声明过的 option 触发。
- reject/respond option 不能触发 session authorization；后续如果扩展 edit option，即使前端异常提交，也不能触发 session authorization。
- V1 graph-level decision 只支持 approve / reject / respond；旧 edit decision 不再作为 runtime fallback 保留。

## 11. 后续扩展

V1 使用最小 view：

```ts
type ReviewView =
  | { kind: 'plain'; title?: string; body: string }
  | { kind: 'markdown'; title?: string; body: string };
```

后续可以扩展：

- `blocks`：结构化文本、key-value、code、diff、table。
- `html`：Web/Studio 可直接渲染的富文本。
- `image`：terminal 或 Web 支持图片后展示截图、图表、预览。
- `form`：option 需要用户输入参数时使用。

扩展原则：

- producer 输出稳定 view schema。
- renderer 根据能力选择展示方式。
- response 仍然只提交 selected option id 和必要输入。
- graph/tool runtime 行为仍然只能从 pending spec resolve。
