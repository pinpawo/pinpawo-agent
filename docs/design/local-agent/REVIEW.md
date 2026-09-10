# 本分支 review 指南：按 domain 概念组织

分支：`claude/local-agent-module-boundaries-0a8310`（20 个提交，相对 `main`）
生成于：`1ed755e2`

提交是按**时间顺序**攒的，不是按 domain 组织的。本文按**领域概念**重排，
让每条结论的「定义 → 落地 → 修正」可以连起来看。

## 全景

| domain 结论（domains.md §四） | 定义提交 | 落地提交 | 状态 |
|---|---|---|---|
| 1. Host 只有一种，local 是退化形态 | `a1e7335a` | — | **仅文档**，代码未动 |
| 2. setup 与 invoke 都归 agent | `660a8095` | `1955ece8` | 部分落地 |
| 3. dispatch 是 Studio 概念，gate = Agent 可用 | `3ddcaad2` → **`1ed755e2` 修正** | 阶段 3 | **已落地** |
| 4. Conversation = UI 交互 state | `badde03a` | `89981a64` | 部分落地 |
| 5. `modelProfileId`：Session 覆盖 / Config 默认 | `3ddcaad2` | — | **仅文档** |
| 6. wire 不是 domain，能力必须统一 | `660a8095` | `885610e6` `37c2227a` | 目录落地，能力统一未做 |
| 7. attachment 是输入准入，归 agent | `9296881e` | `89981a64` | 已落地 |
| 8. 多 Pet 由 Studio 持有多个 Host | `9296881e` | — | **仅文档** |

**8 条里只有 4 条动了代码**，其余是定义。这是刻意的：先把概念定清楚，再动结构。

---

## 一、有代码落地的四条

### 结论 2：setup 与 invoke 都归 agent

```bash
git show 1955ece8
```

- **改了什么**：`buildChatSetup` 的装配逻辑从 `ServerTuiSessionService` 搬到
  `agent/buildChatSetup.ts`；Session 服务保留同名方法做**身份解析**后委托。
- **暴露的事实**：装配真正需要的会话信息只有 3 个值 —— 显式成了 `ChatSetupSession`
  类型（`threadId` / `modelProfileId` / `startedAt`）。
- **要看的点**：`assertChatSetupPrerequisites` 的顺序保护。
  它保的是「artifact store 缺失时不要先建一个会话再抛错」，
  但**生产路径走不到**（`residentPetHost` 里该字段是必填）。留着还是删掉是你的判断。
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
- **未完成**：「能力必须统一」这条规则**没落地** —— HTTP 仍是自建的 5 条路由，
  是唯一重新实现能力面的传输（阶段 4）。

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

## 三、只有定义、尚未落地的四条

这四条是**纯概念**，代码一行没动。review 时看文档即可：

| 结论 | 看哪里 |
|---|---|
| 1. Host 只有一种 | `domains.md` §一.1 |
| 3. dispatch 是 Studio 概念 | `domains.md` §一.3（**已被 `1ed755e2` 修正过**） |
| 5. `modelProfileId` 两层 | `domains.md` §一.5 |
| 8. 多 Pet 由 Studio 组织 | `domains.md` §一.8 |

---

## 四、我判断失误并自我修正的四处

如果你想看推导出错的轨迹，这几个提交的 message 写得比较完整：

| 提交 | 错在哪 | 谁发现的 |
|---|---|---|
| `5033b147` | domains.md 写成「只列候选不做结论」，却压了 6 条已定进去，自相矛盾 | 自查 |
| `d03adbfa` | 阶段 2/3 顺序反了 —— resident 解包依赖准入归位 | 实施时自查 |
| `678e5e84` | 以为阶段 2 满足了阶段 3 的前置，实际 Session 准入 ≠ 执行准入 | 实施时自查 |
| **`1ed755e2`** | **把 dispatch 当成 local-agent 需要协调的一等公民** | **你纠正** |

最后一条是根本性的：dispatch 是 Studio 的调度概念，Host 只提供「Agent 可用」
gate，gate 与会话无关。这让我之前发明的「阶段 2.5 执行准入」整个撤销。

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

全程保持：**14 个 workspace、632 测试、0 失败**，typecheck 全绿，build 通过。
测试数从 627 增至 632（新增 5 个 `sessionAdmission` 测试）。

---

## 七、为什么顶层还剩 63 个文件

这是 review 中被问到的问题，值得写清楚。按 domain 归类，顶层剩余文件分三类：

| domain | 顶层数 | 原因 |
|---|---|---|
| **agent** | ~18 | 阶段 1 只搬了 `buildChatSetup`；`chatSessionAdapter`、`agentGraphService` 等要等生命周期收敛（现仍在两处重复） |
| **Config** | ~17 | 结论 5 **仅文档**，代码未动 |
| **Host** | ~11 | 结论 1 **仅文档**；`residentPetHost` 要等阶段 3 |
| **Session** | 3 | 未建 `session/` 目录 |
| **wire** | 4 | `httpHandlers` / `server` 等要等阶段 4 |
| 组装/入口 | ~9 | `index` / `cli` / `serverTypes` / `runtime` **本来就该在顶层** |

三个原因：

1. **等后续阶段（约 40 个）** —— 有意留的。`serverHandlers` 要拆到四个 domain，
   而拆法取决于阶段 3-5；提前搬会与后续改动反复冲突，
   这和把 `ServerDeps` 拆解放在最后一阶段是同一个理由。
2. **结论只有定义、未落地（约 28 个）** —— Config 与 Host 两个 domain 的代码一行没动。
3. **本来就该在顶层（约 9 个）** —— domains.md 说的「Host 的完整组装类型留在
   组合入口」。**终态顶层大约是 10 个，不是 0 个。**
