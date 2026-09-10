# local-agent domain 定义（2026-09-10 draft）

关联：#790。核对基线：`badde03a`。
本文定义 local-agent 的 domain 切分。[准入分层](./admission-scopes.md) 的 scope
是本文的**推论**，待本文定稿后据此重写。

## 为什么需要这一篇

module-boundaries §一 用两种方式划分：**目录结构**（wire/agent/conversation/config）
和 **handler 职责表**。但核对代码时发现的 7 条协调分叉，没有一条能靠这两种划分
判定 —— 它们回答「这段代码属于哪个模块」，而分叉问的是「谁拥有这个状态、谁有权
裁决」。

更根本的是，代码里连概念本身都还没分开：

- **`ServerDeps` 是平铺的杂物袋**，11 个字段混了 Pet 身份 / 配置源 / Host 长期服务 /
  存储适配器四类东西，所有消费者都拿到全部字段。
- **`ServerTuiSessionService` 19 个公开方法**，横跨会话注册表、内容投影、
  执行状态读取、以及 **graph 装配**。

最能说明问题的是 `buildChatSetup()`：它挂在「session 服务」上，却在读
`modelProfiles`、`toolkitInventory`、`capabilityArtifactStore`、`checkpointer`
—— 它装配的是**一次执行**，不是一个会话。

**连「一次执行」和「一个会话」是不是同一个东西都没定义过，谈锁多大是空的。**

---

## 一、domain 切分（已定）

| domain | 是什么 | 拥有什么 |
|---|---|---|
| **Host** | 一个进程内的 Pet 宿主 | 长期服务、生命周期 |
| **Session** | 会话身份 | `sessionId` ↔ `threadId` 绑定、模型覆盖值 |
| **agent**（Execution） | 一次执行 | setup、invoke、准入、取消收尾 |
| **Conversation** | 为 TUI/前端交互提供 state 管理 | UI 交互 state 与其投影 |
| **Config** | 配置来源 | 读取、校验、持久化、**默认值** |

**wire 不是 domain**，是传输适配层（不拥有状态）。

`toolkits/` `commands/` `capabilities/` 已存在，不在本次讨论范围。

### 1. Host 只有一种

`serverHandlers` 现在既是「local 模式的完整 Host」，又是「resident 模式的内层
组件」（`admitConversationHandlers` 包裹它的 peerHandlers）。这是 4 层协调叠加和
两层豁免规则不一致的根因。

**只有一种 Host，local 是它的退化形态**（没有 dispatch 队列的 Host）。
resident 不再包一层；`server.ts` / `chatStdioServer.ts` 直接用同一个 Host。

### 2. setup 与 invoke 都归 agent

原本就有 agent 这一层 —— `agentChannel.ts`。它现在只剩 `AgentChannelSetup` 类型
和 `buildLocalChatAgentInput`（纯装配，不读任何服务）。真正的 setup→invoke 链路
散在 5 个文件，其中两处错位：

| 环节 | 现在在哪 | |
|---|---|---|
| `AgentChannelSetup` 类型 | `agentChannel.ts` | ✅ |
| `buildLocalChatAgentInput`（纯装配） | `agentChannel.ts` | ✅ |
| `buildChatSetup`（读服务 + 装配） | **`serverTuiSessions.ts`** | ❌ **错层** |
| `streamEvents` / `settleAbortedRun` | `agentGraphService.ts` | ✅ |
| 一次 turn 的编排 | `chatSessionAdapter.ts` | ✅ |
| 生命周期 / 取消 / 收尾 | `serverChatHandler.ts` **和** `residentPetHost.ts` | ❌ **两处重复** |

**规则：setup 和 invoke 都属于 agent，一个都不放在 Session 上。**

`buildChatSetup` 真正需要的会话信息只有两项：`threadId` 和 `modelProfileId`。

**推论：Session 只提供身份，agent 拿身份去装配执行。Session 不需要知道
graph 长什么样。**

### 3. resident dispatch 不是第二种 Execution

它是在标准 Host 之上长出来的**更下游的子集** —— 同一个 Execution 概念，
只是触发者不是 peer 而是调度。

**因此它必须走同一个执行入口与收尾路径，不再复制一套生命周期**
（这正是 module-boundaries §一 对 `residentPetHost` 的要求）。

### 4. Conversation = UI 交互 state 管理

**Conversation 是为 TUI / 前端交互提供 state 管理的部分。它管理的 state，
都是围绕实际 UI 交互的。**

这条给出一个可检验的判据：**凡不是 UI 交互 state 的，就不属于 Conversation。**

这个 domain **已经有一个包了** —— `@pinpawo/agent-session`（约 3000 行，
消费者正是 `services/local-agent` 与 `services/tui`）：

| 模块 | 行数 | 角色 |
|---|---|---|
| `protocol.ts` | 1062 | 客户端协议消息 |
| `project.ts` | 755 | **`reduceSession` / `applySessionSnapshot` —— state reducer** |
| `parser.ts` | 608 | 解析 |
| `domain.ts` | 160 | `AgentSession`、`AgentRunView`、`AgentPlan`、`AgentTimelineEntry` 等 **UI 视图类型** |
| `events.ts` / `timeline.ts` / `snapshot.ts` / `review.ts` | ~350 | 事件、时间线、快照、review 视图 |

`buildLocalAgentSessionSnapshot` 组装的正是 `AgentSessionSnapshot`，且显式带入
`activeRun`（注释写明「Live local transport state; never inferred from
checkpoint plan data」）—— 这不是 transcript 的投影，**是给界面看的当前状态**。

**所以 Conversation 不是 Session 的视图，也不是共用工具集，而是一个已存在的
domain**；local-agent 这边的约 720 行只是**宿主侧的投影与组装**。

### 5. `modelProfileId` 是覆盖与默认两层

| 层面 | 归属 | 含义 |
|---|---|---|
| 当前 session 选中的 model profile | **Session** | 该会话的覆盖值，可在会话内切换 |
| 外部 config 指定的默认值 | **Config** | 没有会话覆盖时用哪个 |

不是二选一。现状 `TuiSessionRecord.modelProfileId` 叠在
`ServerTuiSessionService.defaultModelProfileId` 之上已经是这个形状，
只是两层关系没有被写下来。

### 6. wire 不是 domain：适配层 + 能力统一

**规则：wire 适配不同传输，但能力必须统一。**

这比「传输面不拥有准入」更强：不只是不许拥有准入，而是**每个传输都必须暴露
同一组能力**。核对现状：

| 传输 | 能力面 | 是否合规 |
|---|---|---|
| WebSocket | 13 个 handler | 基准 |
| **stdio** | 复用**同一个** `peerHandlers` | ✅ 天然一致 |
| **HTTP** | 自己手写 5 条路由 | ❌ 自成子集 |

stdio 的做法是对的（`attachLocalServerStdioTransport(handlers.peerHandlers)`）。
**HTTP 是唯一重新实现了能力面、而不是适配它的传输。**

所以分叉 #1（HTTP 绕过 `sessionCommands`）不是独立 bug，而是这个违规的**症状**：
自建路由的传输，自然也自建了「经过哪些协调」。

---

## 二、支撑证据

### 身份与内容已经分开存

这是现成的事实，不是提议：

| 存储 | 内容 |
|---|---|
| `TuiSessionRecord`（tuiSessionRegistry.ts） | `id`、`petId`、`threadId`、`modelProfileId`、`title`、`messageCount`、时间戳 —— **身份与元数据** |
| LangGraph checkpoint（`FileSaver`） | 真正的 `messages`、`pendingInterrupt`、`currentPlan` —— **执行状态** |

`messageCount`/`title` 是从 checkpoint 投影出来的缓存
（`summarizeTuiCheckpointMessages`）。所以 Session 记录里那两个字段，
**是 Conversation 算出来交给它的**。分家在存储上已经完成，只差类型和服务。

### local-agent 侧约 720 行的归属

| 模块 | 行数 | 是 UI 交互 state 吗 | 归属 |
|---|---|---|---|
| `imageAttachments.ts` | 195 | ❌ 大小/数量/MIME **上限校验是准入规则** | **agent**（附件准入） |
| `currentPlanProjection.ts` | 148 | ✅ 投影 `AgentPlan`（UI 视图类型） | Conversation |
| `chatAttachments.ts` | 136 | ⚠️ 混：显示文本是 UI，消息构造是执行输入 | **需拆** |
| `agentSessionSnapshot.ts` | 133 | ✅ 组装 `AgentSessionSnapshot` | Conversation |
| `pendingInterruptProjection.ts` | 21 | ✅ 投影给界面的待确认状态 | Conversation |
| `serverTuiSessions.ts:81-170` | 90 | ✅ `title`/`messageCount` 是列表 UI 要的 | Conversation（**现错放在 session 文件里**） |

`serverTuiSessions.ts:81-170` 是关键证据：那 5 个函数
（`readTuiCheckpointMessages`、`readTuiCheckpointInputModalities`、
`readTuiCheckpointTokenUsage`、`readTuiCheckpointMessageSource`、
`summarizeTuiCheckpointMessages`）**参数只有 `BaseMessage[]`，对 session 状态
零依赖** —— 纯 transcript 函数，只是恰好住在 session 文件里。

`imageAttachments.ts` 被判据踢出：它抛的异常叫 `ImageAdmissionError`，
`chatAttachments.ts` 里也有 `createAdmittedLocalChatHumanMessage` ——
**代码里早就写着 admission，只是按「和聊天有关」而非按 domain 归了类。**

### 现在混在一起的东西

**`ServerDeps`**（serverTypes.ts，11 个字段）：

| 字段 | 实际是什么 | 归属 |
|---|---|---|
| `petId`、`petName`、`serverMode` | Pet 的身份 | Host |
| `modelProfiles` | 配置来源 | Config |
| `capabilityCatalog`、`toolkitInventory`、`toolkitRuntimeManager`、`petDocument`、`capabilityArtifactStore` | Host 长期持有的服务 | Host |
| `chatCheckpointer` | 存储适配器 | Host |

**`ServerTuiSessionService`**（19 个公开方法）：

| 职责 | 方法 | 归属 |
|---|---|---|
| 会话注册表 | `getActiveSession`、`getActiveSessionId`、`getSession`、`getChatThreadId`、`hasActiveSession`、`createNewSession`、`resumeSession`、`resetSession`、`listSessions`、`selectModelProfile`、`adoptInitialThread` | Session |
| 内容投影 | `readSessionCheckpointMessages`、`updateSessionSummaryFromCheckpoint`、`refreshActiveSessionSummary` | Conversation |
| 执行状态读取 | `readActivePendingInterrupt`、`readActiveCheckpointPoint`、`readSessionCheckpointPoint` | Conversation（投影）/ agent（读取） |
| **执行装配** | `buildChatSetup`、`createUserMessage` | **agent** |

---

## 三、未决

- [ ] `chatAttachments.ts` 怎么拆（`readLocalChatDisplayText`/`formatLocalChatModelText` 归 Conversation，
      `createLocalChatHumanMessage`/`createAdmittedLocalChatHumanMessage` 归 agent）
- [ ] `imageAttachments.ts` 移到 agent 后，附件准入与执行准入怎么合
- [ ] `ServerDeps` 按 domain 拆成哪几个契约
- [ ] 每个 domain 拥有哪些状态，谁能改（写成契约类型）
- [ ] Pet 身份（`petId`）是 Host 的属性，还是独立的 Pet domain
- [ ] 准入 scope 如何由本文推导（[admission-scopes](./admission-scopes.md) 据此重写）

## 四、已决速查

| # | 结论 |
|---|---|
| 1 | Host 只有一种，local 是退化形态 |
| 2 | setup 与 invoke 都归 agent，不放 Session |
| 3 | resident dispatch 是下游子集，同一个 Execution |
| 4 | Conversation = UI 交互 state 管理，主体在 `@pinpawo/agent-session` |
| 5 | `modelProfileId`：Session 覆盖 / Config 默认 |
| 6 | wire 不是 domain；适配传输，能力必须统一 |
