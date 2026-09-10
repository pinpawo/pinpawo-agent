# local-agent domain 定义（2026-09-10 draft）

关联：#790。核对基线：`badde03a`。
本文定义 local-agent 的 domain 切分，并在 §三 给出它的两个推论：
准入归属，以及据此排出的实施顺序。

## 术语

- **准入（admission）**：「这个操作现在准不准跑」的裁决。例如
  `if (activeChatOperations > 0) { 拒绝切模型 }`。分两类：
  **时机准入**（有执行在跑吗）与**输入准入**（这个输入这个模型收得下吗）。
- **domain 的状态**：这个 domain 独占拥有、且**别人只能通过它修改**的数据。
  判据是「谁能改」，不是「谁能读」。

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
| **Host** | **一个 Pet** 的宿主 | Pet 身份、生命周期；**持有**（非拥有）长期服务的引用 |
| **Session** | 会话身份 | `sessionId` ↔ `threadId` 绑定、模型覆盖值 |
| **agent**（Execution） | 一次执行 | setup、invoke、准入、取消收尾 |
| **Conversation** | 为 TUI/前端交互提供 state 管理 | UI 交互 state 与其投影 |
| **Config** | 配置来源 | 读取、校验、持久化、**默认值** |

**wire 不是 domain**，是传输适配层（不拥有状态）。

多 Pet 时由 **Studio 持有多个 Host** 并拥有共享服务实例（见 §一.8）；
local 模式是「只有一个 Host」的退化形态。

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

### 3. dispatch 是 Studio 的概念；Host 只提供「Agent 可用」这道 gate

dispatch **不是 local-agent 的 domain**。它由 Studio 插件（kanban / scheduler /
trigger）发起，是更下游的调度概念。local-agent 这一层只向上暴露一道 gate。

**gate 与会话无关，它表达的是 Agent 的可用状态。** 现有实现说得很清楚
（residentPetHost.ts:532）：

```ts
const readSettledState = async () => {
  if (state.pendingInterrupt) return 'waiting';  // 在等人回复 → 不可用
  return 'open';                                  // 可用
};
```

`open | busy | waiting | blocked` 回答的是「**这个 Agent 现在能不能接新活**」。
`waiting` 的成因是有 pending interrupt 在等人，与 session 状态无关。

这与既有设计一致：[resident Pet Host ports](../agent-runtime/resident-pet-host-ports.md)
已把 `ResidentPetHost` 定义为**两个不对称的 port** —— `dispatch`（给 Studio）
与 `interaction`（对话），并明确不为对话另建同构的 `PetConversationPort`。

**因此「对话 ↔ dispatch 互斥」是个伪命题。** 对话不是 dispatch 的竞争者，
对话是**让 Agent 变忙的原因之一**；gate 要表达的只是忙/等人时别再派活进来。

dispatch 触发的确实是一次普通 Execution（走同一个执行入口与收尾路径），
但**不能由此推出 local-agent 需要一层「执行级互斥」**——那是把 Studio 的调度
概念误当成了本层需要协调的一等公民。

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

**但这条规则只约束「对话能力面」，不约束运维面。** 实施阶段 4 时核对发现，
HTTP 承载的其实是两种不同的东西：

| 路由 | 属于 | 真实消费者 |
|---|---|---|
| `/health` | **运维面**（进程是否活着） | macOS 伴侣 `StatusPoller` |
| `/runtime` | **运维面**（装的哪个版本） | TUI `localHostMetadata` |
| ~~`/snapshot`~~ ~~`/sessions`~~ ~~`/sessions/resume`~~ | 对话能力面 | **零消费者**（已删） |

运维面回答的是「进程」的问题，不是「对话」的问题，它本就不该出现在
`peerHandlers` 里，也不该被这条规则要求去「统一」。

真正违规的是后三条：它们把 snapshot / list / resume 在 HTTP 上**重新实现**了
一遍。TUI 早已改走 WebSocket 的 `session.snapshot.get` / `session.list` /
`session.resume`（`TuiLocalServerClient` 已不存在），macOS 伴侣只用 `/health`，
所以这三条**全仓零消费者**。

| 传输 | 对话能力面 | 是否合规 |
|---|---|---|
| WebSocket | 13 个 handler | 基准 |
| **stdio** | 复用**同一个** `peerHandlers` | ✅ 天然一致 |
| **HTTP** | 不承载对话能力（已删三条残留） | ✅ 运维面独立 |

所以分叉 #1（HTTP 绕过 `sessionCommands`）的根不是「HTTP 该去适配 13 个
handler」，而是**它本不该有那三条路由**。删掉即消解。

### 7. attachment 是输入准入，由模型能力决定

之前把 `imageAttachments.ts` 判给 agent、把 `chatAttachments.ts` 判为「需拆」，
**这个判断不完整**。核对 `createUserMessage`（serverTuiSessions.ts:318）后：

```ts
const profile = deps.modelProfiles.resolve(session.modelProfileId);
const admitted = await this.imageAdmission.admit(attachments, {
  allowImages: (profile.inputModalities ?? ['text']).includes('image'),
});
```

`allowImages` 来自**模型档案的 `inputModalities`** —— 这不是 UI 的事，
是「**这个模型收不收图**」。所以：

| 内容 | 归属 | 理由 |
|---|---|---|
| 尺寸/数量/MIME 上限、`ImageAdmissionError` | **agent** | 输入准入，由模型能力决定 |
| `createLocalChatHumanMessage` / `createAdmittedLocalChatHumanMessage` | **agent** | 构造执行输入 |
| `readLocalChatDisplayText` / `formatLocalChatModelText` | **Conversation** | 纯显示 |

**对 agent 而言 attachment 就是 messages 的一部分**，不是独立概念 ——
这正是它该归 agent 的原因。TUI 侧只负责把用户选的文件递进来。

**两端其实是同一条规则**：`requiredInputModalities` 从 transcript 读回
（serverTuiSessions.ts:392），用于**切模型时拒绝不兼容的模型**
（已有图片的会话不能切到纯文本模型）。所以「附件准入」与「切模型准入」
是同一条模型能力约束的两端，现在却分散在两处 —— 这就是「怎么合」的含义：
**同一条规则应当只有一个所有者（agent），而不是入口一处、切换一处各写一遍。**

### 8. 多 Pet 由 Studio 组织，Host 不感知彼此

`petId` **是 Host 的属性，不需要独立的 Pet domain** —— 核对 multi-Pet 的实际
组织方式（`packages/studio/src/host/buildStudio.ts:169-228`）后确认：

```
Studio
 ├─ residentPets: Map<petId, ResidentPetHost>   ← 多 Pet 在这一层
 ├─ 共享注入：modelProfiles、toolkitInventory、toolkitRuntimeManager、
 │            capabilityArtifactStore、checkpointer(同一个 FileSaver)、
 │            runtimeConfig、globalReviewPolicyMode
 └─ 每 Pet 独有：petId、petName、modelProfileId、defaultCapabilityName、
                 petDocument、capabilities、sessionStatePath、adoptThreadId
```

三条推论：

1. **Host = 一个 Pet 的宿主**，`petId` 是它的身份属性。多 Pet 是
   **Studio 持有多个 Host**，Host 之间互不感知。local 模式就是「只有一个 Host」
   的退化形态 —— 与 §一.1 一致。
2. **Host 长期服务大多是 Studio 级共享的**，不是 Pet 独有。连 `checkpointer`
   都是同一个 `FileSaver`，靠 `threadId` 隔离（`adoptThreadId` 形如
   `studio:<studioId>:pet:<petId>`）。所以「Host 拥有服务」要改成
   **Host 持有引用，Studio 拥有实例**。
3. **Config 的默认值层是 Studio 级的**（`input.modelProfiles` 全 Pet 共享，
   `petConfig.modelProfileId` 是 Pet 级覆盖）—— 与 §一.5 的两层模型同构，
   只是多了一层：**Config 默认 → Pet 覆盖 → Session 覆盖**。

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
| `imageAttachments.ts` | 195 | ❌ 上限校验是**输入准入**，由模型 `inputModalities` 决定 | **agent**（见 §一.7） |
| `currentPlanProjection.ts` | 148 | ✅ 投影 `AgentPlan`（UI 视图类型） | Conversation |
| `chatAttachments.ts` | 136 | ⚠️ 混：显示文本是 UI，消息构造是执行输入 | **需拆**（见 §一.7） |
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

**`ServerDeps`**（serverTypes.ts，11 个字段）—— **可以取消**。

核对每个消费者实际读了哪些字段：

| 消费者 | 实际读的字段 |
|---|---|
| `serverTuiSessions.ts` | 7 个（`capabilityArtifactStore`、`capabilityCatalog`、`defaultCapabilityName`、`modelProfiles`、`petDocument`、`petId`、`toolkitRuntimeManager`） |
| `configProjection.ts` | 5 个 |
| `residentPetHost.ts` | 3 个 |
| `httpHandlers.ts` | 2 个（`petId`、`petName`） |
| `serverHandlers.ts` | 2 个 |
| `agentSessionSnapshot.ts`、`serverChatHandler.ts` | 1 个 |
| `chatStdioServer`、`server`、`runtime`、`run`、`modelProfiles`、`runtimeOperationRegistry` | **0 个（只传递）** |

**大多数消费者只读 1-3 个字段，6 个消费者一个都不读、纯粹在传递。**
唯一读得多的 `serverTuiSessions` 那 7 个字段，正是 `buildChatSetup` 需要的 ——
而 `buildChatSetup` 已定归 agent（§一.2）。

所以 `ServerDeps` 不是一个契约，是**为了少写参数而攒的传递包**。按 domain
拆成各自的窄契约后它自然消失，符合 module-boundaries §二
「消费者声明自身需要的字段」和「Host 的完整组装类型不成为模块公共总线」。

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

## 三、推论：准入归属

> 这一节曾是独立的 `admission-scopes.md`。实施完成后并回来 ——
> 它的分量本就该是 domain 的一个推论章节，而不是并列的一篇：
> 真实代码改动只有「删三处恒假条件 + 抽一个 85 行的 `SessionAdmission`」。

**准入（admission）**：「这个操作现在准不准跑」的裁决。分**时机准入**
（有执行在跑吗）与**输入准入**（这个模型收得下这个输入吗，已定归 agent，见 §一.7）。

### 规则

**一个操作的准入，归它所修改状态的那个 domain。** 由此直接得出两条：

- **Conversation 不裁决准入** —— 它管的是 UI 交互 state，是投影而非权威数据源。
  所以只读查询免检是对的。
- **Config 不裁决准入** —— 它只拥有读取/校验/持久化，**生效时点归 agent**。
  所以 `onRuntimeConfigUpdate` 不检查活跃执行也是对的。

### 每个操作的归属

| 操作 | 改哪个 domain 的状态 | 准入归属 |
|---|---|---|
| chat / interrupt resume、compact | agent（一次执行） | **agent** |
| session new / resume、model select | Session（会话指针 / 模型覆盖值） | **Session** |
| resident dispatch | 不改 local-agent 的状态 | **gate**（Agent 可用即可派活） |
| runtime config update | Config（只写配置） | 无 |
| snapshot / list / model list | Conversation（只读投影） | 无 |
| run interrupt | 不改状态，须穿透 | 无 |
| 断连清理 | wire（连接自身） | wire |

**没有 `process` 层。** `activeChatOperations` 与 `sessionTransition` 是
`createLocalServerHandlers` 的闭包局部变量，而 Studio 对每个 Pet 各调一次
`createResidentPetHost` —— 它们是 **Host 级**的，多 Pet 时进程内没有共享准入状态。

### 现状核对（实施前的事实基线）

#### 6 个协调器的实际归属

| 协调器 | 实际范围 | 该归谁 |
|---|---|---|
| `ServerSessionCommandQueue` | 一个 peer 连接 | **撤销**（错层，§二.2） |
| `activeChatOperations` | **一个 Host**（闭包局部，非进程） | agent 的执行准入 |
| `sessionTransition` | **一个 Host**（同上） | Session |
| `ThreadInvocationCoordinator` | 一个 thread | **保留**，已是 agent 级且语义正确 |
| `ResidentPetCoordinator` | 一个 Pet | **gate（Agent 可用状态）**，是 `PetDispatchPort` 的职责；其中的对话入队要拆走 |
| `InflightRequestController` | 一个 peer，且只认 WS | agent（须覆盖 dispatch） |

#### 三个入口面

| 入口面 | 现状 |
|---|---|
| WebSocket（13 个 handler） | 基准 |
| stdio | 复用**同一组** `peerHandlers` ✅ |
| HTTP（2 条路由） | 仅运维面 `/health` `/runtime`；三条对话能力残留路由已删 ✅ |
| resident dispatch | 直接进 `dispatchQueue`，不进 `InflightRequestController` |

#### resident 模式的 4 层叠加

```
peer message
  └─ coordinator.enqueueConversation      ← Pet 级
       └─ local peerHandler
            └─ sessionCommands.enqueue    ← peer 级
                 └─ 等 sessionTransition  ← Host 级
                      └─ 检查 activeChatOperations  ← Host 级
```

根因是 Host 身份模糊（domains §一.1），不是协调本身写错了。

#### 两层豁免规则不一致

| handler | local 层 | resident 层 |
|---|---|---|
| `onRunInterrupt` | 旁路 | 旁路（一致） |
| `onSessionSnapshotGet` | `sessionCommands` | **旁路** |
| `onNewSession` | 旁路 | **入队** |

---

### 实施顺序（已全部落地）

按依赖而非工作量排序。**三次方向性错误都是动手后才发现前提不成立** ——
详细推导见各阶段的 commit message。

| 阶段 | 内容 | 提交 |
|---|---|---|
| 0 | 按 domain 归位（transcript / attachment / 三个投影） | `89981a64` `35796df6` |
| 1 | `buildChatSetup` 归 agent | `1955ece8` |
| 2 | Session 准入有了所有者（`SessionAdmission`） | `314b2293` |
| 3 | 对话移出 dispatch 队列 | `0562e671` |
| 4 | 删掉 HTTP 上重实现对话能力的残留路由 | `a6815988` |
| 5 | `ServerDeps` 拆成 domain 窄契约 | `23394d4c` |

三次更正，都记录在对应提交里：

| 原计划 | 实际 | 提交 |
|---|---|---|
| 阶段 2 = resident 解包 | 它依赖准入归位，顺序反了 | `d03adbfa` |
| 需要「执行级准入」接管对话↔dispatch 互斥 | **伪命题**（见 §一.3） | `1ed755e2` |
| HTTP 改为适配 13 个 handler | HTTP 承载的是运维面 | `a6815988` |

### 尚未收敛的

- **agent 的生命周期仍在两处重复**（`serverChatHandler` 与 `residentPetHost`）
  —— §一.2 表格里的第二个 ❌，是下一轮的主体。
- **`serverHandlers` 尚未按 domain 拆开** —— 它要拆到四个 domain，
  与上一条一起做。
- 未建 `session/` 与 `config/` 目录：阶段 5 拆的是 Config 的**契约**，不是目录。

---

## 四、未决

- [ ] 输入准入（attachment）与切模型准入合并到 agent 后的具体形态
- [ ] 各 domain 的窄契约怎么写（`ServerDeps` 拆解后的替代物）
- [ ] Studio 级共享服务与 Host 级引用的边界怎么表达
- [x] 准入归属如何由本文推导 → **见 §三**（7 条分叉全部可判定）

## 五、已决速查

| # | 结论 |
|---|---|
| 1 | Host 只有一种，local 是退化形态 |
| 2 | setup 与 invoke 都归 agent，不放 Session |
| 3 | dispatch 是 Studio 概念；Host 只提供「Agent 可用」gate，与会话无关 |
| 4 | Conversation = UI 交互 state 管理，主体在 `@pinpawo/agent-session` |
| 5 | `modelProfileId`：Session 覆盖 / Config 默认 |
| 6 | wire 不是 domain；适配传输，能力必须统一 |
| 7 | attachment 是输入准入（由模型能力决定），整体归 agent；只有显示文本归 Conversation |
| 8 | 多 Pet 由 Studio 持有多个 Host；`petId` 是 Host 属性，无需独立 Pet domain |
