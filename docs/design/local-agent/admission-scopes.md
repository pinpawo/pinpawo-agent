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
| resident dispatch | agent（一次执行） | **agent** | ⚠️ 现 Host 级队列 |
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
| 5 | dispatch 不进 `InflightRequestController` | dispatch 是同一个 Execution（domains §一.3），走同一入口 |
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
| `ResidentPetCoordinator` | 一个 Pet | Host / agent（dispatch 与对话竞争同一执行入口） |
| `InflightRequestController` | 一个 peer，且只认 WS | agent（须覆盖 dispatch） |

### 三个入口面

| 入口面 | 现状 |
|---|---|
| WebSocket（13 个 handler） | 基准 |
| stdio | 复用**同一组** `peerHandlers` ✅ |
| HTTP（5 条路由） | 自建路由，`/sessions/resume` 不经 `sessionCommands` ❌ |
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
