# local-agent domain 候选（2026-09-10 draft）

关联：#790。核对基线：`7013c650`。
本文**只列候选与证据，不做结论**。切法待定后，
[准入分层](./admission-scopes.md) 的 scope 应作为本文的推论重写，而非前提。

## 为什么先做这一篇

上一版先写了 scope 枚举（process / pet / session / connection）。那是**同一把锁的
粒度层级，是机制**，回答「锁多大」，不回答「系统里有哪些东西、谁拥有它们」。

而代码里的证据表明，连概念本身都还没分开：

- **`ServerDeps` 是平铺的杂物袋**，11 个字段至少混了 4 类东西（见 §一）。
- **`ServerTuiSessionService` 有 19 个公开方法**，横跨会话注册表、消息构造、
  checkpoint 读取、以及 **graph 装配**。

最后一条最能说明问题：`buildChatSetup()` 挂在「session 服务」上，却在读
`modelProfiles`、`toolkitInventory`、`capabilityArtifactStore`、`checkpointer`
——它组装的是**一次执行**，不是一个会话。

**连「一次执行」和「一个会话」是不是同一个东西都没定义过，谈锁多大是空的。**

## 已定：setup 与 invoke 都归 agent

原本就有 agent 这一层 —— `agentChannel.ts`。它现在只剩两样东西：
`AgentChannelSetup` 类型和 `buildLocalChatAgentInput`（纯装配，不读任何服务）。
真正的 setup→invoke 链路却散在 5 个文件：

| 环节 | 现在在哪 | 归属 |
|---|---|---|
| `AgentChannelSetup` 类型 | `agentChannel.ts` | agent ✅ |
| `buildLocalChatAgentInput`（纯装配） | `agentChannel.ts` | agent ✅ |
| `buildChatSetup`（读服务 + 装配） | **`serverTuiSessions.ts`** | agent ❌ **错层** |
| `streamEvents` / `settleAbortedRun` | `agentGraphService.ts` | agent ✅ |
| 一次 turn 的编排 | `chatSessionAdapter.ts` | agent ✅ |
| 生命周期 / 取消 / 收尾 | `serverChatHandler.ts` **和** `residentPetHost.ts` | agent ❌ **两处重复** |

**规则：setup 和 invoke 都属于 agent，一个都不放在 Session 上。**

`buildChatSetup` 是唯一走错层的装配点：它挂在 session 服务上，却在读
`modelProfiles`、`toolkitInventory`、`capabilityArtifactStore`、`checkpointer`。
它真正需要的会话信息只有两项：`threadId` 和 `modelProfileId`。

推论：**Session 只提供身份，agent 拿身份去装配执行。Session 不需要知道
graph 长什么样。** 这同时解答了 §二 D 的存疑（见下）。

## 已定：Host 只有一种

`serverHandlers` 现在既是「local 模式的完整 Host」，又是「resident 模式的内层
组件」（`admitConversationHandlers` 包裹它的 peerHandlers），这是 4 层协调叠加和
两层豁免规则不一致的根因。

**决定：只有一种 Host，local 是它的退化形态**（没有 dispatch 队列的 Host）。
resident 不再包一层；`server.ts` / `chatStdioServer.ts` 直接用同一个 Host。

---

## 一、证据：现在混在一起的东西

### `ServerDeps`（serverTypes.ts）

| 字段 | 实际是什么 |
|---|---|
| `petId`、`petName`、`serverMode` | Pet 的**身份** |
| `modelProfiles` | **配置来源** |
| `capabilityCatalog`、`toolkitInventory`、`toolkitRuntimeManager`、`petDocument`、`capabilityArtifactStore` | Host **长期持有的服务** |
| `chatCheckpointer` | **存储适配器** |

module-boundaries §二 已经指出这三类的所有权规则不同（长期服务 / 会话数据 /
执行快照），但类型上仍是一个平铺结构，所有消费者都拿到全部字段。

### `ServerTuiSessionService`（19 个公开方法）

| 职责 | 方法 |
|---|---|
| 会话注册表 | `getActiveSession`、`getActiveSessionId`、`getSession`、`getChatThreadId`、`hasActiveSession`、`createNewSession`、`resumeSession`、`resetSession`、`listSessions`、`selectModelProfile`、`adoptInitialThread` |
| 会话内容/投影 | `readSessionCheckpointMessages`、`updateSessionSummaryFromCheckpoint`、`refreshActiveSessionSummary` |
| 执行状态读取 | `readActivePendingInterrupt`、`readActiveCheckpointPoint`、`readSessionCheckpointPoint` |
| **执行装配** | `buildChatSetup`、`createUserMessage` |

### 身份与内容已经是分开存的

这一点是现成的事实，不是提议：

| 存储 | 内容 |
|---|---|
| `TuiSessionRecord`（tuiSessionRegistry.ts） | `id`、`petId`、`threadId`、`modelProfileId`、`title`、`messageCount`、时间戳 —— **身份与元数据** |
| LangGraph checkpoint（`FileSaver`） | 真正的 `messages`、`pendingInterrupt`、`currentPlan` —— **执行状态** |

会话记录里的 `messageCount`/`title` 是**从 checkpoint 投影出来的缓存**
（`updateSessionSummaryFromCheckpoint`）。所以「会话身份」与「对话内容」
在存储上已经分家，只是在**类型和服务上还没分**。

---

## 二、候选 domain

以下每个候选都附「支持它独立存在的证据」和「反对/存疑」。**不做结论。**

### A. Host

**是什么**：一个进程内的 Pet 宿主。持有长期服务，决定生命周期。

| 支持 | 反对/存疑 |
|---|---|
| `ServerDeps` 里那 5 个服务确实是 Host 生命周期的 | 「Host」现在同时指 resident 和 local 两种形态，需要按已定结论统一 |
| `residentPetHost` 已有明确的 open/busy/closing 状态机 | Pet 身份（`petId`）是 Host 的属性，还是独立的 Pet domain？ |
| 关闭时「停止准入 → 取消活跃执行 → 等收尾 → 释放」是 Host 级动作 | |

### B. Session（会话身份）

**是什么**：`sessionId` ↔ `threadId` 的绑定，以及它选中的模型。

| 支持 | 反对/存疑 |
|---|---|
| `TuiSessionRecord` 已经是独立存储，且**不含消息** | 与 Conversation 是否该合并？（见 D） |
| `activeSessionIds` 是 Pet 级的「当前会话」指针 | （已定：见下，Session 覆盖 / Config 默认） |
| 「同一会话内可切模型」是 module-boundaries §二 已确认的规则 | |

**已定：`modelProfileId` 分两个层面，是覆盖与默认的关系。**

| 层面 | 归属 | 含义 |
|---|---|---|
| 当前 session 配置的 model profile | **Session** | 该会话选中的模型，可在会话内切换 |
| 外部 config 指定的默认值 | **Config** | 没有会话覆盖时用哪个 |

不是二选一 —— Session 存**覆盖值**，Config 提供**默认值**，读取时
Session 覆盖优先。现状 `TuiSessionRecord.modelProfileId` 与
`ServerTuiSessionService` 的 `defaultModelProfileId` 已经是这个形状，
只是两层关系没有被写下来。

### C. Execution（一次执行）

**是什么**：一次 invoke 的生命周期 —— 输入、配置快照、AbortSignal、收尾。

**已定：resident dispatch 不是第二种 Execution。** 它是在标准 Host 之上长出来的
**更下游的子集** —— 同一个 Execution 概念，只是触发者不是 peer 而是调度。
因此它必须走同一个执行入口与收尾路径，不再复制一套生命周期
（这正是 module-boundaries §一 对 residentPetHost 的要求）。

| 支持 | 反对/存疑 |
|---|---|
| `AgentChannelSetup` 已经是「一次执行的完整输入」这一形状 | 它现在由 session 服务的 `buildChatSetup` 组装，归属含糊 |
| module-boundaries §二 明确「同次执行及其收尾使用同一份配置」 | （已定：resident dispatch 是标准 Host 的下游子集，同一个 Execution） |
| `ThreadInvocationCoordinator` 已是 thread 级、且语义正确 | |
| 取消结算（`settleAbortedRun`）只对一次执行有意义 | |

### D. Conversation（对话内容）

**是什么**：把 checkpoint 里的 transcript 变成人能看的东西 —— 解码、投影、
汇总、以及反方向的用户消息构造。

**覆盖面核查**（约 720 行，5 个独立模块 + 1 段错放的代码）：

| 模块 | 行数 | 做什么 |
|---|---|---|
| `imageAttachments.ts` | 195 | 图片附件的类型、大小/数量上限、MIME 校验 |
| `currentPlanProjection.ts` | 148 | 从 state 投影 `currentPlan`，并判等 |
| `chatAttachments.ts` | 136 | 构造用户消息、读显示文本、格式化模型文本 |
| `agentSessionSnapshot.ts` | 133 | 组装给客户端的会话快照与 runtime 视图 |
| `pendingInterruptProjection.ts` | 21 | 投影 pending interrupt |
| **`serverTuiSessions.ts:81-170`** | **90** | **transcript 解码/汇总，错放在 session 文件里** |

最后一行是关键证据。那 5 个函数
（`readTuiCheckpointMessages`、`readTuiCheckpointInputModalities`、
`readTuiCheckpointTokenUsage`、`readTuiCheckpointMessageSource`、
`summarizeTuiCheckpointMessages`）**参数只有 `BaseMessage[]`，
对 session 状态零依赖** —— 纯 transcript 函数，只是恰好住在 session 文件里。
`summarizeTuiCheckpointMessages` 更是 `title`/`messageCount` 的来源，
也就是说 Session 记录里那两个字段，是 Conversation 算出来交给它的。

| 支持 | 反对/存疑 |
|---|---|
| 约 720 行，5 个模块已自然成组 | 大部分是**读投影**，写只有「构造用户消息」一条 |
| `serverTuiSessions.ts:81-170` 只吃 transcript，零 session 依赖 | 投影的消费者遍布 agent/wire，可能只是共享工具而非 domain |
| 消费者遍布 `agentGraphService`、`chatSessionAdapter`、`serverChatHandler`、`residentPetHost`、`serverHandlers` —— 不专属 Session | 附件校验（imageAttachments）像准入规则，可能属 agent |
| 真正的消息在 checkpoint，与会话记录**已经分开存** | |

### D 的边界定义（已定）

**Conversation = 为 TUI / 前端交互提供 state 管理的部分。它管理的 state，
都是围绕实际 UI 交互的。**

这条把 D 从「对话内容」收紧成一条可检验的判据：**凡不是 UI 交互 state 的，
就不属于 Conversation。**

核对下来，这个 domain **已经有一个包了** —— `@pinpawo/agent-session`（约 3000 行，
消费者正是 `services/local-agent` 与 `services/tui`）：

| 模块 | 行数 | 角色 |
|---|---|---|
| `protocol.ts` | 1062 | 客户端协议消息 |
| `project.ts` | 755 | **`reduceSession` / `applySessionSnapshot` —— state reducer** |
| `parser.ts` | 608 | 解析 |
| `domain.ts` | 160 | `AgentSession`、`AgentRunView`、`AgentPlan`、`AgentTimelineEntry` 等 **UI 视图类型** |
| `events.ts` / `timeline.ts` / `snapshot.ts` / `review.ts` | ~350 | 事件、时间线、快照、review 视图 |

`buildLocalAgentSessionSnapshot` 组装的正是 `AgentSessionSnapshot`，
且显式带入 `activeRun`（注释写明「Live local transport state; never inferred
from checkpoint plan data」）—— 这不是 transcript 的投影，
**是给界面看的当前状态**。

所以 local-agent 里那 720 行的定位随之明确：

| 模块 | 是 UI 交互 state 吗 | 归属 |
|---|---|---|
| `agentSessionSnapshot.ts` | ✅ 组装 `AgentSessionSnapshot` | **Conversation** |
| `currentPlanProjection.ts` | ✅ 投影 `AgentPlan`（UI 视图类型） | **Conversation** |
| `pendingInterruptProjection.ts` | ✅ 投影给界面的待确认状态 | **Conversation** |
| `chatAttachments.ts` | ⚠️ 读显示文本是 UI；构造用户消息是执行输入 | **需拆**：显示归 Conversation，消息构造归 agent |
| `imageAttachments.ts` | ❌ 大小/数量/MIME **上限校验是准入规则** | **agent**（附件准入） |
| `serverTuiSessions.ts:81-170` | ✅ `title`/`messageCount` 是列表 UI 要的 | **Conversation**（现在错放在 session 文件里） |

两条推论：

1. **Conversation 不是 Session 的视图，也不是共用工具集，而是一个已存在的
   domain** —— 它的类型与 reducer 都在 `@pinpawo/agent-session`，
   local-agent 这边只是**宿主侧的投影与组装**。
2. **`imageAttachments.ts` 应当移出。** 附件的大小/数量/MIME 上限是「这次执行
   能否接受这个输入」的准入判断，不是 UI state。它现在混在 Conversation 里，
   是按「和聊天有关」而非按 domain 归的类。

### E. Config（配置）

**是什么**：模型档案、review 策略、runtime 配置。

| 支持 | 反对/存疑 |
|---|---|
| `modelProfiles` 是独立注册表 | module-boundaries §一 已指出：切模型**不是**单纯读配置，含准入 |
| `updateReviewPolicy` 有「何时生效」的规则 | 那就说明 Config 只拥有「读取/校验/持久化」，生效时点归 Execution |
| §二「配置生效规则」已写了快照语义 | |

### F. Transport / wire —— **已定：不是 domain，是适配层 + 一条规则**

**是什么**：协议解析、鉴权、路由、事件发送。它不拥有任何状态。

**规则：wire 适配不同传输，但能力必须统一。**

这条比「传输面不拥有准入」更强：不只是不许拥有准入，而是**每个传输都必须
暴露同一组能力**。按此核对现状：

| 传输 | 能力面 | 是否合规 |
|---|---|---|
| WebSocket | 13 个 handler | 基准 |
| **stdio** | 复用**同一个** `peerHandlers` | ✅ 天然一致 |
| **HTTP** | 自己手写 5 条路由 | ❌ 自成子集 |

stdio 的做法是对的（`attachLocalServerStdioTransport(handlers.peerHandlers)`
直接接同一组能力）。**HTTP 是唯一重新实现了能力面、而不是适配它的传输。**

所以分叉 #1（HTTP 绕过 `sessionCommands`）不是一条独立的 bug，而是这个违规的
**症状**：HTTP 自己手写路由，自然也自己决定经过哪些协调。

---

## 三、切法候选

| 方案 | 组成 | 代价 |
|---|---|---|
| **三分** | Host / Session / Execution | Conversation 归入 Session 的投影；Config 归入 Host 服务 |
| **四分** | Host / Session / Conversation / Execution | Session 只管身份与生命周期，Conversation 管内容 |
| **五分** | 四分 + Config 独立 | 与 module-boundaries §一 的目录结构最接近 |

`wire` 在三种方案里都不算 domain，而是**传输适配层**（不拥有状态），
并受「能力必须统一」这条规则约束。

---

## 四、定稿后需要回答

- [x] Conversation 的边界 → **为 TUI/前端交互提供 state 管理**；类型与 reducer 已在 `@pinpawo/agent-session`
- [ ] `chatAttachments.ts` 怎么拆（显示文本 vs 消息构造）
- [ ] `imageAttachments.ts` 移到 agent 后，附件准入与执行准入怎么合
- [ ] 每个 domain 拥有哪些状态，谁能改
- [x] `buildChatSetup` 归谁 → **agent**（见「已定」；现在错挂在 Session 上）
- [ ] `ServerDeps` 按 domain 拆成哪几个契约
- [x] resident dispatch 与 chat 是不是同一个 Execution → **是**，dispatch 是下游子集
- [x] `modelProfileId` 属于 Session 还是 Config → **两层**：Session 覆盖，Config 默认
- [ ] 准入 scope 如何由 domain 推导（[admission-scopes](./admission-scopes.md) 据此重写）
