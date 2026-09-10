# local-agent 准入归属（2026-09-10 draft）

关联：#790（module-boundaries §一「执行协调的范围与所有者」）。
核对基线：`9296881e`。本文为**待定稿设计**，不代表当前实现。

**前置**：[local-agent domain 定义](./domains.md)。本文的准入归属是那一篇的
**推论** —— 不再自立一套 scope 层级，而是问「这个操作改的是**哪个 domain 的
状态**」，由该 domain 裁决。

## 术语

**准入（admission）**：「这个操作现在准不准跑」的裁决。分两类：

- **时机准入**：有执行在跑吗？（`if (activeChatOperations > 0) 拒绝`）
- **输入准入**：这个输入这个模型收得下吗？（attachment 的 `inputModalities` 校验）

本文只谈时机准入；输入准入已定归 agent（domains §一.7）。

---

## 一、准入归属规则

**规则：一个操作的准入，归它所修改状态的那个 domain。**

domain 已定五个（domains §一），其中三个拥有可变状态，因而可以裁决准入：

| domain | 拥有的状态 | 能裁决准入吗 |
|---|---|---|
| **Host** | Pet 身份、生命周期 | ✅ Host 级 |
| **Session** | `sessionId`↔`threadId` 绑定、模型覆盖值 | ✅ Session 级 |
| **agent** | 一次执行的生命周期 | ✅ 执行级 |
| **Conversation** | UI 交互 state（**投影，非权威**） | ❌ 只读投影 |
| **Config** | 配置的读取/校验/持久化 | ❌ 见下 |

两条推论，都由 domain 直接得出：

- **Conversation 不裁决准入。** 它管理的是 UI 交互 state，是投影而非权威数据源
  —— 这直接判定了分叉 #6：**只读查询不参与准入是对的**，因为它们读的是投影。
  但理由要写进代码，否则收敛时会被误改。
- **Config 不裁决准入。** 它只拥有「读取/校验/持久化」，**生效时点归 agent**
  （module-boundaries §二「配置更新成功后影响下一次获准执行」）。所以
  `onRuntimeConfigUpdate` 不检查活跃执行是对的 —— 它只写配置，不影响在跑的执行。

### 只有三层，没有 `process`

上一版提过 `process` scope，**是错的**。核对后：`activeChatOperations` 与
`sessionTransition` 是 `createLocalServerHandlers` 的**闭包局部变量**
（serverHandlers.ts:133-134），而 Studio 对**每个 Pet 各调一次**
`createResidentPetHost`（buildStudio.ts:194）→ 各建一份 handlers → 各有一份计数器。

**所以它们是 Host 级的，不是进程级的。** 多 Pet 时进程内没有任何共享的准入状态，
`process` 这一层不存在。

---

## 二、每个操作的准入归属

| 操作 | 改哪个 domain 的状态 | 准入归属 | 现状 |
|---|---|---|---|
| chat / interrupt resume | agent（一次执行） | **agent** | ⚠️ 现由 Host 级计数代管 |
| compact | agent（一个 thread 的 checkpoint） | **agent** | ❌ 现走 Host 级 |
| session new / resume | Session（当前会话指针） | **Session** | ❌ 现 peer 级排队 + Host 级检查 |
| `onNewSession` | Session（同上） | **Session** | ❌ 零协调（#7） |
| model select | Session（模型覆盖值） | **Session** | ❌ 现 peer 级排队 + Host 级检查 |
| resident dispatch | 不改 local-agent 的 domain 状态 | **gate**（Agent 可用即可派活） | ✅ 已由 coordinator 提供 |
| runtime config update | Config（只写配置） | **无** | ✅ 现已不检查 |
| snapshot / list / model list | Conversation（只读投影） | **无** | ✅ 现已不检查 |
| run interrupt | 不改状态，**须穿透** | **无** | ✅ 已旁路 |
| 断连清理 | wire（连接自身） | **wire** | ✅ 已在 `onClose` |

三条由此确定：

1. **`onNewSession` 与 `onSessionNew` 必须同归 Session**（#7 解决）——
   它们改同一份状态，不能一条全检查、一条零检查。
2. **`sessionCommands`（peer 级）整层是错层**（#1 #4 解决）。建会话/切模型改的是
   **Session 的状态**，不是连接的状态；按 peer 串行既不必要也不充分 ——
   一个 Pet 可挂多个 peer（`peers: Set<AgentSessionPeer>`），peer 级串行
   拦不住另一个 peer 的并发。**这才是 #4 是正确性问题的原因。**
3. **HTTP 绕过不是独立缺口**（#1）。准入归 Session 之后，
   `resumeSession` 无论从 WS 还是 HTTP 进来都走同一处裁决 ——
   与传输无关（domains §一.6：wire 适配传输，能力必须统一）。

### wire 的准入例外

wire 只拥有**连接自身**的生命周期。断连时取消该连接拥有的执行，属于 wire；
但它**不得**裁决任何改变共享状态的操作 —— 那是上面三个 domain 的事。

---

## 三、这样能消掉几条分叉

| # | 分叉 | 由什么解决 |
|---|---|---|
| 1 | HTTP 绕过 `sessionCommands` | 准入归 Session，与传输无关（§二.3） |
| 2 | resident 4 层叠加 | Host 只有一种（domains §一.1），不再包一层 |
| 3 | 两层豁免规则不一致 | 同上；只有一层就无所谓一致 |
| 4 | peer 级 vs Host 级粒度不匹配 | `sessionCommands` 整层撤销（§二.2） |
| 5 | dispatch 不进 `InflightRequestController` | dispatch 触发的是同一种 Execution，走同一执行入口与收尾；但 dispatch 本身是 Studio 概念，不与对话互斥（domains §一.3） |
| 6 | 只读查询不检查活跃执行 | Conversation 是投影，不裁决准入（§一） |
| 7 | `onNewSession` 零协调 | 与 `onSessionNew` 同归 Session（§二.1） |

**7 条全部可判定**，且没有一条需要新的机制 —— 都是「谁拥有这个状态」的直接推论。

---

## 四、现状核对（事实基线，仍然有效）

### 6 个协调器的实际归属

| 协调器 | 实际范围 | 该归谁 |
|---|---|---|
| `ServerSessionCommandQueue` | 一个 peer 连接 | **撤销**（错层，§二.2） |
| `activeChatOperations` | **一个 Host**（闭包局部，非进程） | agent 的执行准入 |
| `sessionTransition` | **一个 Host**（同上） | Session |
| `ThreadInvocationCoordinator` | 一个 thread | **保留**，已是 agent 级且语义正确 |
| `ResidentPetCoordinator` | 一个 Pet | **gate（Agent 可用状态）**，是 `PetDispatchPort` 的职责；其中的对话入队要拆走 |
| `InflightRequestController` | 一个 peer，且只认 WS | agent（须覆盖 dispatch） |

### 三个入口面

| 入口面 | 现状 |
|---|---|
| WebSocket（13 个 handler） | 基准 |
| stdio | 复用**同一组** `peerHandlers` ✅ |
| HTTP（2 条路由） | 仅运维面 `/health` `/runtime`；三条对话能力残留路由已删 ✅ |
| resident dispatch | 直接进 `dispatchQueue`，不进 `InflightRequestController` |

### resident 模式的 4 层叠加

```
peer message
  └─ coordinator.enqueueConversation      ← Pet 级
       └─ local peerHandler
            └─ sessionCommands.enqueue    ← peer 级
                 └─ 等 sessionTransition  ← Host 级
                      └─ 检查 activeChatOperations  ← Host 级
```

根因是 Host 身份模糊（domains §一.1），不是协调本身写错了。

### 两层豁免规则不一致

| handler | local 层 | resident 层 |
|---|---|---|
| `onRunInterrupt` | 旁路 | 旁路（一致） |
| `onSessionSnapshotGet` | `sessionCommands` | **旁路** |
| `onNewSession` | 旁路 | **入队** |

---

## 五、这一版不做的

- 不引入全局队列。每个 domain 保留自己的协调器，只是**每个恰好一个所有者**。
- 不改 `ThreadInvocationCoordinator`（已是 agent 级且正确）。
- 不动 `onRunInterrupt` 的穿透豁免（有意的）。
- 不预设最终类型/类结构；先定归属，再谈代码组织。

## 六、验收

- [ ] 任一操作，能说出它改哪个 domain 的状态、由谁裁决准入
- [ ] 同一操作经不同传输进来，准入结果一致
- [ ] 不存在同一 domain 的重复入队（resident 4 层消除）
- [ ] 多 peer 挂同一 Pet 时，Session 级操作正确互斥
- [ ] 同一状态变更不存在「一条路径全检查、另一条零检查」（#7）
- [ ] 只读/只写配置的免检有代码注释说明理由（#6）
- [ ] dispatch 与对话经同一执行入口，终结事件不重复发布（#5）

---

## 七、实施顺序

按**依赖**排序，不按工作量。前三步互不依赖、可独立验证；后三步有严格前后序。

### 阶段 0：无依赖的归位（可独立落地，纯移动）

| # | 动作 | 影响面 | 风险 |
|---|---|---|---|
| 0.1 | `serverTuiSessions.ts:81-170` 的 5 个 transcript 函数移入 Conversation | 生产代码**零外部引用**；`serverTuiSessions.test.ts` 有 4 个直接测试，随之移走 | 极低 |
| 0.2 | `chatAttachments.ts` 拆分：显示留 Conversation，消息构造归 agent | 2 个引用者 | 低 |
| 0.3 | `imageAttachments.ts` 移入 agent（输入准入） | 2 个引用者 | 低 |

这三步不改行为，也不依赖任何准入决定。**先做它们**，让后续的结构改动在更干净的
基础上进行。

### 阶段 1：`buildChatSetup` 归 agent（前置于阶段 2）

`buildChatSetup` 有 5 个生产调用点（residentPetHost×2、serverChatHandler×2、
serverHandlers×1）。它只需 `threadId` + `modelProfileId`，其余从 Host 服务读。

**为什么必须先做**：它现在挂在 Session 服务上，是 Session 与 agent 纠缠的主结点。
不解开它，阶段 3 的「Session 拥有准入」无法与「agent 拥有执行」分离。

### 阶段 2：准入归位（解决 #1 #4 #6 #7）

撤销 `sessionCommands` 整层（10 处调用，全在 `serverHandlers.ts` 内，
无外部引用），准入改由状态所有者裁决：

- Session 级：session new/resume、model select、`onNewSession`
- agent 级：chat/resume、compact、dispatch
- 无准入：只读查询、config 更新、run interrupt

**撤销前必须确认**：`sessionCommands` 现在还兼做「同 peer 内命令串行」，
撤销后要由 Session 级准入覆盖等价保证 —— 且它本来就拦不住跨 peer，
所以新方案严格更强，不是更弱。

前置：阶段 1。

### 阶段 3：resident 不再包一层（解决 #2 #3）

`admitConversationHandlers` 只有**一个调用点**（residentPetHost.ts:599）。

**两次误判的更正（第三次核对）**：前两版把 `coordinator` 当成「对话与 dispatch
的互斥器」，并据此推导需要一层「执行级准入」来接管它。**这个前提是错的。**

dispatch 是 **Studio 的调度概念**，不是 local-agent 的 domain；local-agent 只
向上暴露一道 gate，而 gate 表达的是 **Agent 可用状态**（`pendingInterrupt` →
`waiting`），与会话无关。详见 [domains §一.3](./domains.md)。

**所以对话与 dispatch 不需要互斥**：对话不是竞争者，对话是让 Agent 变忙的
原因之一。之前拟插入的「阶段 2.5 执行准入」是为一个伪命题设计的，已撤销。

本阶段真正要回答的是：`coordinator` 现在把两件不同的事塞在同一个队列里 ——

| `coordinator` 现在做的 | 属于什么 | 拆解后 |
|---|---|---|
| 维护 `open/busy/waiting/blocked` 并对外发布 | **gate（Agent 可用状态）** | 保留，这是 `PetDispatchPort` 的职责 |
| dispatch 排队与 closing 拒绝 | **gate** | 保留 |
| **把对话也塞进同一队列**（`enqueueConversation`） | 对话准入 | **这才是要拆的** |

对话已有自己的准入（阶段 2 的 `SessionAdmission`）与 thread 级协调
（`ThreadInvocationCoordinator`），不需要再排一次 Studio 的调度队列。
拆掉 `admitConversationHandlers` 后，对话走 local 层的准入，
`coordinator` 回归为纯粹的 dispatch gate。

**仍需确认**：对话结束后 gate 状态如何刷新（现在靠 `drain()` 之后的
`readSettledState()`）。这是拆除时唯一需要接续的行为。

`queuedConversations` 已核对：它在 `studioContract.ts` 里声明并被填充，但
**没有任何生产消费者**读它（scheduler 插件只用 `StudioDispatchQueue['state']`）。
拆队列时该字段可以保留形状或归零。

前置：阶段 2。

**已落地**：`enqueueConversation` 改为 `holdForConversation` —— 对话不再入队，
只在执行期间持有 gate 并在结束后刷新。`conversationQueue` 已删除，
`coordinator` 回归为纯 dispatch gate。

实施中发现并保住的两条行为：

1. **gate 刷新必须 await。** 契约是「`handle()` 返回时 gate 状态已结算」——
   旧队列的 `run()` 在 resolve 前刷新，fire-and-forget 会破坏它
   （e2e 测试 `two resident Pets isolate waiting checkpoints` 抓到）。
2. **对话的 hold 必须同步认领。** 排队中的 dispatch 在**启动时**读 Session 状态，
   所以已在途的会话切换必须先落地；先等待再认领会让该 dispatch
   顶着旧 thread 跑掉（测试 `a queued dispatch reads the active conversation
   thread only when it starts` 抓到）。

### 阶段 4：HTTP 能力面对齐（解决 #1 的根）

**方向更正（实施时发现）**：原计划写的是「HTTP 改为适配同一组能力，与 stdio
一致」，**这是错的**。HTTP 承载的是**运维面**（`/health` 给 macOS 伴侣探活、
`/runtime` 给 TUI 读版本），它回答的是「进程」的问题而非「对话」的问题，
本就不该出现在 `peerHandlers` 里。

真正违规的是另外三条：`/snapshot`、`/sessions`、`/sessions/resume` 把对话能力
在 HTTP 上重新实现了一遍，且**全仓零消费者** —— TUI 早已改走 WebSocket 的
`session.*` 命令（`TuiLocalServerClient` 已不存在），macOS 伴侣只用 `/health`。

**已落地**：删除这三条路由及其测试，`LocalHttpHandlerOptions` 收窄为只剩
`authToken`。`docs/wiki/concepts/local-agent-transport-boundary.md` 里
「HTTP endpoints ... used by the TUI today」的说法已经过时（该文按 CLAUDE.md
规则不在本次改动范围，留待 ingest 时更新）。

前置：阶段 3。

### 阶段 5：`ServerDeps` 拆解

拆成各 domain 的窄契约。6 个消费者一个字段都不读、纯传递，可直接去掉参数。

**一条已知线索**：`ServerDeps.capabilityArtifactStore` 声明为可选（`?`），
但 `residentPetHost` 的生产路径上它是必填（`CapabilityArtifactStore`，无 `?`）。
**类型比现实宽**，于是下游写了 2 处防御性检查
（`assertChatSetupPrerequisites` 及其调用点）。agent 的窄契约里把它声明为必填，
这些检查连同为它保留的顺序保护都可以删除。

**放最后**：它是前面各步的**自然结果**，而不是前提。提前做会与阶段 1-3 的
归属调整反复冲突。

### 依赖图

```
0.1 ─┐
0.2 ─┼─（互不依赖，可并行）
0.3 ─┘
      └─→ 1 buildChatSetup → 2 Session 准入 → 3 resident 解包 → 4 HTTP 对齐 → 5 ServerDeps 拆解
```

### 每阶段的验证

阶段 0-1 靠现有测试（1709 个）保证零回归。
阶段 2-4 需补行为测试，对应 §六 验收项：多 peer 并发的 Session 级互斥、
同一操作经不同传输准入一致、dispatch 与对话终结事件不重复。
