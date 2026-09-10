# local-agent 准入分层与 Host domain（2026-09-10 draft）

关联：#790（module-boundaries §一「执行协调的范围与所有者」）。
核对基线：`f17b2e9a`。本文为**待定稿设计**，不代表当前实现。

> **顺序更正**：本文的 §二 scope 枚举是「同一把锁的粒度层级」，属于机制，
> 不是 domain 定义。正确顺序是先定 domain（有哪些概念、谁拥有什么），
> scope 应作为其**推论**。domain 候选与证据见
> [local-agent domain 候选](./domains.md)；那一篇定稿后，本文 §二～§四 需据此重写。
> 本文 §一 的**现状核对**（6 个协调器、3 个入口面、7 条分叉）仍然有效。

## 为什么需要这一篇

module-boundaries §一 写了「同一范围的准入和终结只能有一个权威所有者」，但
**「范围（scope）」从未被定义**。它被当作不言自明，于是每个协调器各自猜了一个。

核对代码后发现 7 个分叉。它们看起来是 7 个独立问题，实际是同一处缺失暴露 7 次：

| # | 分叉 | 现状 |
|---|---|---|
| 1 | 同一个 `resumeSession`：WS 经 `sessionCommands`，HTTP 不经 | 真缺口；已归因为「HTTP 自建能力面」的症状，见 [domains §二 F](./domains.md) |
| 2 | resident 模式下 4 层协调叠加 | §一 明确要消除 |
| 3 | local 与 resident 两层豁免规则不一致 | 各定各的 |
| 4 | `sessionCommands` per-peer，`activeChatOperations` 全局 | 粒度不匹配 |
| 5 | resident dispatch 不进 `InflightRequestController` | 同一问题答案不一 |
| 6 | 只读查询不检查活跃执行 | 疑似有意，但未写明 |
| 7 | `onNewSession` 与 `onSessionNew` 都调 `createNewSession`，前者零协调、后者穿 4 层 | 疑似遗漏 |

关键在于：**这 7 条没有一条能靠「目标目录结构」或「handler 职责表」判定。**
两种划分回答的都是「这段代码属于哪个模块」，而这 7 条问的是另一个问题：

> **这次准入的作用域是谁？谁有权拒绝？**

所以缺的不是目录，是 **scope 这个 domain**。

---

## 一、现状：6 个协调器，6 种 scope

没有一处写下过自己的 scope，以下是从实现反推：

| 协调器 | 实际 scope | 位置 |
|---|---|---|
| `ServerSessionCommandQueue` | **一个 peer 连接**（按 peer 存 tail） | serverSessionCommandQueue.ts |
| `activeChatOperations` | **整个进程**（单计数） | serverHandlers.ts |
| `sessionTransition` | **整个进程**（单 Promise） | serverHandlers.ts |
| `ThreadInvocationCoordinator` | **一个 thread** | threadInvocationCoordinator.ts |
| `ResidentPetCoordinator` | **一个 Pet**（普通数组队列） | residentPetHost.ts |
| `InflightRequestController` | **一个 peer**，且只认 WS 来的 | inflightRequestController.ts |

分叉 #4 就是这张表的直接后果：`sessionCommands` 是 peer 级，
`activeChatOperations` 是进程级，二者串联使用却从未对齐粒度。

### 三个入口面

| 入口面 | 经过的协调 |
|---|---|
| **WebSocket peer**（13 个 handler） | 见下表分组 |
| **HTTP**（5 条路由） | `/sessions/resume` 复用 `resumeSession`，但**不经 `sessionCommands`** |
| **resident dispatch**（非 peer） | 直接进 `dispatchQueue`，不进 `InflightRequestController` |

WebSocket 的 13 个 handler 按经过的层分 4 组：

| 组 | handler | 经过 |
|---|---|---|
| A 对话执行 | `onChatRequest`、`onInterruptResume` | `afterSessionCommands` → 计入 `activeChatOperations` |
| B 会话/配置变更 | `onSessionNew`、`onSessionResume`、`onSessionCompact`、`onModelSelect` | `sessionCommands` → 等 transition → 检查活跃执行 → 持有 transition |
| C 只读查询 | `onRuntimeConfigUpdate`、`onSessionSnapshotGet`、`onSessionList`、`onModelList` | 只 `sessionCommands`，**不检查活跃执行** |
| D 完全旁路 | `onRunInterrupt`、`onNewSession`、`onClose` | 无 |

D 组旁路**只有一部分是有意的**：`onRunInterrupt` 必须穿透队列打断正在跑的执行，
排在队尾就失去意义。

但 `onNewSession` 不同（#7）。它与 B 组的 `onSessionNew` 调用**同一个**
`tuiSessions.createNewSession`：

| 入口 | 等 transition | 拒绝活跃执行 | 持有 transition |
|---|---|---|---|
| `onSessionNew`（B 组） | ✅ | ✅ | ✅ |
| `onNewSession`（D 组） | ❌ | ❌ | ❌ |

同一个状态变更，一条路径全检查、另一条零检查。这更像遗漏而非设计，
定 scope 时需要一并裁决。

### Host 身份是模糊的（#2 #3 的根）

`createLocalServerHandlers` 有 3 个宿主：

```
server.ts          (WebSocket)  → 终端 Host
chatStdioServer.ts (stdio)      → 终端 Host
residentPetHost.ts              → 再包一层
```

`admitConversationHandlers` **包裹**了 local 的 peerHandlers，于是 resident 模式下：

```
peer message
  └─ coordinator.enqueueConversation      ← 外层队列（Pet 级）
       └─ local peerHandler
            └─ sessionCommands.enqueue    ← 内层队列（peer 级）
                 └─ 等 sessionTransition  ← 进程级锁
                      └─ 检查 activeChatOperations  ← 进程级计数
```

**一个 `onSessionNew` 穿过 4 层协调。**

两层的豁免规则还不一致：

| handler | local 层 | resident 层 |
|---|---|---|
| `onRunInterrupt` | 旁路 | 旁路（一致） |
| `onSessionSnapshotGet` | `sessionCommands` | **旁路** |
| `onNewSession` | 旁路 | **入队** |

根因：**`serverHandlers` 既是「local 模式的完整 Host」，又是「resident 模式的
一个内层组件」。它不知道自己是哪个身份，于是两边各自补协调。**

### 一个 Pet 可挂多个 peer

`residentPetHost.ts` 的 `peers: Set<AgentSessionPeer>` 说明多 peer 是真实场景。
因此 peer 级与 Pet 级的粒度不匹配（#4）**是正确性问题，不只是整洁性问题**。

---

## 二、待定：scope 枚举

建议定义为 4 层，由外到内：

| scope | 含义 | 谁拥有 |
|---|---|---|
| `process` | 整个 local-agent 进程 | 组合入口 |
| `pet` | 一个 resident Pet / 一个 Chat Host | Host |
| `session` | 一个会话（thread） | agent |
| `connection` | 一个客户端连接 | wire |

**核心规则（待确认）：**

1. 一个操作只声明**一个**准入 scope，由该 scope 的所有者裁决。
2. 准入不叠加：内层不得对已由外层裁决过的同一 scope 再排一次队。
3. `connection` scope **只用于连接自身的生命周期**（断连、清理），
   不用于任何会改变共享状态的操作。

规则 3 若成立，`sessionCommands` 现在承担的 B 组排队就是**错层**——
建会话/切模型改的是 Pet 级共享状态，却按 peer 串行。
这同时解释了 #1：HTTP 绕过 `sessionCommands` 不是有人忘了，
而是从未定义过「resume 的准入 scope 是 peer 还是 pet」。

---

## 三、待定：每个操作归哪个 scope

以下是**候选归属**，需要逐条确认：

| 操作 | 候选 scope | 理由 | 现状是否一致 |
|---|---|---|---|
| chat / interrupt resume | `session` | 改的是一个 thread 的状态 | ❌ 现在是进程级计数 |
| session new / resume | `pet` | 改 Pet 的当前会话 | ❌ 现在 peer 级排队 + 进程级检查 |
| model select | `pet` | 改 Pet 的会话记录 | ❌ 同上 |
| compact | `session` | 只动一个 thread 的 checkpoint | ❌ 同上 |
| runtime config update | `pet` | 改 Pet 级策略 | ⚠️ 现在不检查活跃执行 |
| snapshot / list / model list | **无**（只读） | 不改共享状态 | ⚠️ 有意但未写明（#6） |
| run interrupt | **无**（须穿透） | 打断正在跑的执行 | ✅ 已旁路 |
| `onNewSession` | `pet`（同 session new） | 改 Pet 的当前会话 | ❌ 现在零协调（#7） |
| resident dispatch | `pet` | 与对话竞争同一 Pet | ✅ 已是 Pet 级 |

判定 #6 的规则建议：**只读操作不参与准入，但必须读到一致快照**；
它免检的理由要写在代码注释里，否则收敛时容易被误改。

---

## 四、已定：传输面统一能力，不拥有准入

WebSocket / HTTP / stdio / resident dispatch 是 **4 个传输**，不是 4 套准入。

**规则：wire 适配不同传输，但能力必须统一**（见 [domains §二 F](./domains.md)）。
传输只把请求变成「操作 + 身份」，准入一律由所有者裁决。

现状：stdio 复用同一组 `peerHandlers`，天然合规；**HTTP 手写 5 条路由，是唯一
重新实现能力面的传输**。#1 因此不是独立缺口，而是这个违规的症状 ——
HTTP 自建路由，自然也自建了「经过哪些协调」。

---

## 五、这一版不做的

- 不引入全局队列。不同 scope 保留各自的协调器，只是**每个 scope 恰好一个**。
- 不改 `ThreadInvocationCoordinator` 的语义（它已经是 session 级，且是对的）。
- 不动 `onRunInterrupt` 的穿透豁免（它是有意的）。`onNewSession` 的零协调
  另论，见 #7。
- 不预设最终类型/类结构；先定 scope 归属，再谈代码组织。

## 六、验收（待补）

定稿后需要能回答：

- [ ] 任一操作，能说出它的准入 scope 和裁决者
- [ ] 同一操作经不同传输进来，准入结果一致
- [ ] resident 模式下不存在同 scope 的重复入队
- [ ] local 与 resident 的豁免规则一致，或差异有明确理由
- [ ] 多 peer 挂同一 Pet 时，Pet 级操作正确互斥
- [ ] 同一状态变更不存在「一条路径全检查、另一条零检查」（#7）
