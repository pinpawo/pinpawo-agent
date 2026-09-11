# 本分支 review 指南：按 domain 概念组织

分支：`claude/local-agent-module-boundaries-0a8310`（30 个提交，相对 `main`）
更新至：`da8822bb`

提交是按**时间顺序**攒的，不是按 domain 组织的。本文按**领域概念**重排，
让每条结论的「定义 → 落地 → 修正」可以连起来看。

## 全景

| domain 结论（domains.md §四） | 定义提交 | 落地提交 | 状态 |
|---|---|---|---|
| 1. Host 只有一种，local 是退化形态 | `a1e7335a` | — | **仅文档** |
| 2. setup 与 invoke 都归 agent | `660a8095` | `1955ece8` | **部分**：装配已归位，生命周期仍两处重复 |
| 3. dispatch 是 Studio 概念，gate = Agent 可用 | `3ddcaad2` → **`1ed755e2` 修正** | `0562e671` | ✅ 已落地 |
| 4. Conversation = UI 交互 state | `badde03a` | `89981a64` `35796df6` | ✅ 已落地 |
| 5. `modelProfileId`：Session 覆盖 / Config 默认 | `3ddcaad2` | `23394d4c` | **部分**：窄契约已分离 Config 层，三层默认链未实现 |
| 6. wire 不是 domain，能力必须统一 | `660a8095` | `885610e6` `37c2227a` `a6815988` | ✅ 已落地 |
| 7. attachment 是输入准入，归 agent | `9296881e` | `89981a64` | ✅ 已落地 |
| 8. 多 Pet 由 Studio 持有多个 Host | `9296881e` | — | **仅文档** |

**8 条里 6 条动了代码**（4 条完全落地、2 条部分）。剩下 2 条是纯定义 ——
先把概念定清楚再动结构，是刻意的。

### §七 实施阶段

| 阶段 | 内容 | 提交 |
|---|---|---|
| 0 | 按 domain 归位（transcript / attachment / 三个投影） | `89981a64` `35796df6` |
| 1 | `buildChatSetup` 归 agent | `1955ece8` |
| 2 | Session 准入有了所有者 | `314b2293` |
| 3 | 对话移出 dispatch 队列 | `0562e671` |
| 4 | 删掉 HTTP 上重实现对话能力的残留路由 | `a6815988` |
| 5 | `ServerDeps` 拆成 domain 窄契约 | `23394d4c` |

**7 条分叉全部消解。**

### review 过程中定下的新结论

§七 五个阶段完成后，review 又推出一条 domain 结论并落地：

| 结论 | 提交 |
|---|---|
| **3b. 一个 Host 只接一个交互连接**（dispatch 与观察各走各的路径） | `00e6f4e4` |
| 随之：命令队列收敛为 Host 级、`/health` 随其消费者删除 | `9c940fc4` |
| 随之：`SessionCommandQueue` / `admitHumanMessage` 正名 —— command 与 message 是两回事 | `da8822bb` |

这条是 review 中问出来的：dispatch 的初衷就是「任意塞消息，Host 自己决定何时
处理」，那么直接交互本就该独占。代码里早有这个假设（`activeRun` 是 Host 级单值），
只是从没在连接入口强制。

---

## 一、有代码落地的六条

### 结论 2：setup 与 invoke 都归 agent

```bash
git show 1955ece8
```

- **改了什么**：`buildChatSetup` 的装配逻辑从 `ServerTuiSessionService` 搬到
  `agent/buildChatSetup.ts`；Session 服务保留同名方法做**身份解析**后委托。
- **暴露的事实**：装配真正需要的会话信息只有 3 个值 —— 显式成了 `ChatSetupSession`
  类型（`threadId` / `modelProfileId` / `startedAt`）。
- **阶段 5 已解决**：`assertChatSetupPrerequisites` 与那处顺序保护都删掉了。
  `ServerDeps.capabilityArtifactStore` 改为必填后，缺失它**编译就不通过**，
  不必再在运行时检查。
- **未完成**：生命周期/取消/收尾仍在 `serverChatHandler` 与 `residentPetHost`
  **两处重复**，这是 domains §一.2 表格里的第二个 ❌。

### 结论 4 + 7：Conversation 与 attachment 的归属

```bash
git show 89981a64
```

一个提交同时落地两条结论，因为它们在同一批文件里：

| 文件 | 去向 | 依据 |
|---|---|---|
| `conversation/transcriptProjection.ts` | Conversation | 5 个函数只吃 `BaseMessage[]`，零 session 依赖 |
| `conversation/chatDisplayText.ts` | Conversation | 读回给界面看的文本 |
| `conversation/agentSessionSnapshot.ts` | Conversation | 组装 `AgentSessionSnapshot` |
| `conversation/currentPlanProjection.ts` | Conversation | 投影 `AgentPlan` |
| `conversation/pendingInterruptProjection.ts` | Conversation | 投影待确认状态 |
| `agent/chatMessageInput.ts` | agent | 构造模型输入 |
| `agent/attachmentAdmission.ts` | agent | 上限校验由模型 `inputModalities` 决定 |

后三个是 review 时发现**阶段 0 漏搬的** —— domains.md §二 早已判给 Conversation，
但当时只搬了 transcript 与 attachment 那批。已补齐。

- **唯一的行为性改动**：`DISPLAY_TEXT_METADATA_KEY` 加了 `export`
  （写入方在 agent、读取方在 Conversation，必须共享）。
- **要看的点**：`chatAttachments` 的拆法你是否认同 ——
  显示归 Conversation、消息构造归 agent。

### 结论 6：wire 是适配层

```bash
git show 885610e6 --stat -M   # 建 wire/ + #434
git show 37c2227a --stat -M   # 去掉 local 前缀
```

- **`37c2227a` 非 import 行 = 0**，纯改名，看 `--stat` 即可。
- **保住的东西**：`localServerTransportApi` 的 tsup entry key 没变，
  发布子路径 `pinpawo/local-server-transport` 与产物文件名不受影响（构建验证过）。
- **顺带修的**：3 个 tsconfig 路径映射指向了搬走前的旧路径
  （`plugins/studio-http`、`plugins/kanban`、`tests/studio-e2e`）。
- **阶段 4 已补完**：删掉 HTTP 上重新实现对话能力的三条残留路由
  （`/snapshot`、`/sessions`、`/sessions/resume`，全仓零消费者）。
  运维面不在「能力统一」规则内；其中 `/health` 随其唯一消费者（已停止维护的
  macOS 伴侣）一并删除，HTTP 现在只剩 `/runtime`。

---

## 二、准入相关（跨 domain，独立于上面 8 条）

这三个提交不对应某一条 domain 结论，而是**收敛准入归属**的过程。

### `f17b2e9a` 删掉恒假条件（11 行）

三处 `|| inflightRequests.hasActiveRequest()` 是恒假冗余。
用调用链推导 + 全套 627 测试插桩双重验证，`hasActiveRequest()` 一并删除。

### `314b2293` 给 Session 准入一个所有者 —— **本分支唯一的全新逻辑**

```bash
git show 314b2293 -- services/local-agent/src/sessionAdmission.ts \
                     services/local-agent/src/sessionAdmission.test.ts
```

**85 行，最值得细看的部分。** 两个裸闭包变量（`activeChatOperations`、
`sessionTransition`）变成 `SessionAdmission`，四处重复的五步操作变成
`transact()` / `runInSession()`。

写测试时暴露出两个**原本存在但被掩盖**的缺陷（`sessionCommands` 的 per-peer
串行挡住了它们）：

1. 四处 release 写法不一致 —— 两处有 `if (transition === current)` 保护，
   两处无条件置 null，后者可能清掉后继者的 transition。
2. 先 await 再占坑 —— 同一 tick 的两个 transition 都能过闸。

**要确认的语义**：`runInSession` 是「等待后才占坑」，即排队中的 run **不**拒绝
transition。我是照原实现保的（原来也是等 transition 之后才 `+1`），
但这是行为语义，值得你确认。

**⚠️ 这条提交的 message 有一句话是错的**：它暗示了「agent 级准入已就位」，
实际它只是 **Session 级**。后续文档已更正，但 message 留着了。

### `5c645087` interrupt 契约收敛（跨 pet-agent / local-agent）

```bash
git show 5c645087 --stat -M
```

`settleAbortedRun` 从 `AbortSettlement`（paused/finished 联合）收敛为
`PendingInterrupt | null`，删掉了两个消费者里几乎相同的分支。

- **你批准过的行为变更**：settlement 失败改为**抛错走失败路径**，
  不再 catch 后降级成 finished。
- **要看的点**：`serverChatHandler` 里为此抽出的 `reportFailure` 闭包 ——
  因为 `settleInterrupted` 在 `try` 和 `catch` 里都被调用，
  后者抛出会逃逸整个函数。

---

## 三、只有定义、尚未落地的两条

这两条是**纯概念**，代码一行没动。review 时看文档即可：

| 结论 | 看哪里 | 为什么没做 |
|---|---|---|
| 1. Host 只有一种 | `domains.md` §一.1 | `serverHandlers` 要拆到四个 domain，是下一轮的主体 |
| 8. 多 Pet 由 Studio 组织 | `domains.md` §一.8 | 改动面在 `packages/studio`，不在本次范围 |

结论 3 与 5 原本也在此列，实施中已分别由 `0562e671`（阶段 3）和
`23394d4c`（阶段 5）落地。

---

## 四、我判断失误并自我修正的六处

如果你想看推导出错的轨迹，这几个提交的 message 写得比较完整：

| 提交 | 错在哪 | 谁发现的 |
|---|---|---|
| `5033b147` | domains.md 写成「只列候选不做结论」，却压了 6 条已定进去，自相矛盾 | 自查 |
| `d03adbfa` | 阶段 2/3 顺序反了 —— resident 解包依赖准入归位 | 实施时自查 |
| `678e5e84` | 以为阶段 2 满足了阶段 3 的前置，实际 Session 准入 ≠ 执行准入 | 实施时自查 |
| **`1ed755e2`** | **把 dispatch 当成 local-agent 需要协调的一等公民** | **你纠正** |
| `35796df6` | 阶段 0 漏搬三个归属已定的投影模块 | **你 review 时问「外面还有一大堆文件」** |
| `a6815988` | 以为 HTTP 该去适配 13 个 handler，实际它承载的是运维面 | 实施时自查 |

`1ed755e2` 那条是根本性的：dispatch 是 Studio 的调度概念，Host 只提供
「Agent 可用」gate，gate 与会话无关。这让我之前发明的「阶段 2.5 执行准入」
整个撤销。

三条方向性错误（`d03adbfa`、`1ed755e2`、`a6815988`）有个共同模式：
**我在没查清消费者/调用链之前就按计划推进**。后两条都是动手后才发现前提不成立。

---

## 五、建议的 review 顺序

1. **`sessionAdmission.ts` + 它的测试**（85 行）—— 唯一的全新并发逻辑
2. **`5c645087` 的两个消费者分支** —— 跨包契约变更
3. **`1955ece8` 的顺序保护** —— 判断要不要保留
4. **`89981a64` 的 attachment 拆法** —— 概念归属是否认同
5. 其余看 `--stat -M` 确认文件去向即可

### 有用的命令

忽略移动后的真实改动：
```bash
git diff -M90% --stat main..HEAD -- services packages
```

只看非 import 的实质改动：
```bash
git diff main..HEAD -- services | grep -E "^[-+]" | grep -v "^[-+][-+]" | grep -vE "from '|import\("
```

## 六、验证基线

全程保持：**14 个 workspace、0 失败**，typecheck 全绿，build 通过。

测试数 627 → **631**：新增 5 个 `sessionAdmission`、2 个连接准入、3 个
`SessionCommandQueue` 测试；阶段 4 删掉 3 个 HTTP 路由测试合并为 1 个；
阶段 5 把 1 个运行时抛错测试改成类型边界断言；`/health` 删除后移除 1 个
health 字段测试。

⚠️ **本仓需要 Node >= 24。** Node 18 下整套测试会以 `crypto is not defined`
大面积失败（本轮踩过两次），那是环境不是代码。

---

## 七、为什么顶层还剩 63 个文件

这是 review 中被问到的问题，值得写清楚。按 domain 归类，顶层剩余文件分三类：

| domain | 顶层数 | 原因 |
|---|---|---|
| **agent** | 18 | 阶段 1 只搬了 `buildChatSetup`；`chatSessionAdapter`、`agentGraphService` 等要等生命周期收敛（现仍在两处重复） |
| **Config** | 17 | 阶段 5 只拆了**契约**，未建 `config/` 目录 |
| **Host** | 11 | 结论 1 **仅文档**；`residentPetHost` 的拆分是下一轮主体 |
| **Session** | 4 | 未建 `session/` 目录 |
| **wire** | 4 | `httpHandlers` / `server` 等是**组装侧**，不是协议解析 |
| 组装/入口 | ~9 | `index` / `cli` / `serverTypes` / `runtime` **本来就该在顶层** |

三个原因：

1. **归属已定、目录未建（约 21 个）** —— Config 与 Session。阶段 5 拆了 Config
   的**契约**（`RuntimeProjectionDeps`），但没建 `config/` 目录；建目录是纯移动，
   留给下一轮一次做完更省事。
2. **等下一轮的结构收敛（约 29 个）** —— agent 的生命周期仍在
   `serverChatHandler` 与 `residentPetHost` 两处重复（结论 2 的未完成部分），
   `serverHandlers` 要拆到四个 domain。这两件事一起做，提前搬会反复冲突。
3. **本来就该在顶层（9 个）** —— `index` / `cli` / `runtime` / `serverTypes` 等。
   domains.md 说的「Host 的完整组装类型留在组合入口」。
   **终态顶层大约是 10 个，不是 0 个。**
