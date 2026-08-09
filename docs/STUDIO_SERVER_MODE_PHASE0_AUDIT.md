# Studio Server Mode — Phase 0 Contract Audit

Tracking issue: #561（Studio server mode + long-lived local-agent runtime host）
依赖：#570 `agent-contracts`（已合入）、#337 runtime/config ownership、#232 TUI overhaul

本文是 #561 Phase 0 的落盘产物。它**只做审计和边界固定**，不改运行时代码。目标是让
Phase 1–6 的每一次改动都能先回答三个问题：

1. 这块代码是 Studio-only、Chat-only 还是 shared？
2. 改它会不会改变 Chat 的可观察行为？
3. 它现在处在 per-request 热路径上，还是可以提升为 startup-scoped？

---

## 1. 现状盘点：Studio 请求的完整生命周期

一次 `/studio` 请求当前经过的路径：

```text
TUI  /studio <task>          services/tui/src/commands/composerIntent.ts
  └─ ws studio_request       services/local-agent/src/localAgentProtocol.ts
      └─ LocalServerStudioHandler.handleStudioRequest
         services/local-agent/src/localServerStudioHandler.ts:86
          ├─ InflightRequestController.start        （取消已有 inflight）
          ├─ reviewRouter.getOrCreateSlot(peer)     （**每连接单槽** review）
          └─ LocalStudioDueRunScheduler.submit  或  StudioRunService.run
              services/local-agent/src/localStudioDueRunScheduler.ts
              services/local-agent/src/studioRunService.ts:46
               └─ buildStudioForTurn(...)           ← **每次请求重新装配**
                  services/local-agent/src/studio/studioRuntime.ts:125
                   ├─ loadStudioLocalConfig()       （每次读 studio.json）
                   ├─ loadPetLocalConfigs()         （每次读 pets/*.json）
                   ├─ resolveStudio()
                   ├─ createPetAgentRuntime() × N   （每次编译 N 个 graph）
                   │   packages/pet-agent/src/agent/studio/createPetAgentRuntime.ts:143
                   └─ createStudioOrchestrator()    （每次新建 orchestrator）
                       packages/pet-agent/src/agent/studio/createStudioOrchestrator.ts:317
                        └─ runDispatch → agent.invoke()
                            createStudioOrchestrator.ts:384
                             └─ graph.invoke() + 私有 HITL while 循环
                                 createPetAgentRuntime.ts:219-232
```

### 1.1 目标 vs 现状：Studio 没有"启动"这一步

先把两者摆在一起，因为它们是**相反**的：

| | 启动时 | 请求到来时 |
| --- | --- | --- |
| **#561 要求的目标** | 把配置读完，所有启用的 pet agent 建好并常驻 | 查到已建好的实例，`invoke()` 一下 |
| **当前代码实际做的** | 什么都不做（Studio 没有启动环节） | 从读配置文件开始，把全部 pet 现建一遍，用完丢掉 |

也就是说：**Studio 现在没有"已启动完成的实例"可供调用**。下一个请求进来，
再从头建一遍。这正是 #561 存在的理由，Phase 3 的 `StudioRuntimeHost` 就是要
把上表左列变成现实。

#### 证据

`buildStudioForTurn()` 的函数名里 `ForTurn` 就是"每一轮一次"。它的 doc comment
明确写着这是设计意图：

> 每次 /studio turn 调用一次，fresh build，不 cache。Pet runtime 构造很轻，且
> 不 cache 让配置改动即生效。
> — [studioRuntime.ts:110-112](services/local-agent/src/studio/studioRuntime.ts#L110)

这个函数体每次请求跑完整四步：

```text
loadStudioLocalConfig()      读 studio.json
loadPetLocalConfigs()        读 pets/*.json
createPetAgentRuntime() × N  建 N 个 pet，每个编译一次 graph
createStudioOrchestrator()   建 orchestrator
```

注释给的两条理由都不再成立：

- **"构造很轻"** — `createPetAgentRuntime()` 内部会调
  `createOrchestratorGraph()`（[createPetAgentRuntime.ts:151](packages/pet-agent/src/agent/studio/createPetAgentRuntime.ts#L151)），
  也就是**编译 LangGraph 图**。5 个 pet 就是每个请求编译 5 次。
- **"不 cache 让配置改动即生效"** — #561 已明确否掉：V1 不做 config hot reload，
  配置变化通过**重启 host** 生效。

唯一已经做了跨请求缓存的是 run queue store：
`runQueueStoresByPath` + `restoredRunQueuePaths` 两个 module-level Map
（[studioRuntime.ts:89-104](services/local-agent/src/studio/studioRuntime.ts#L89)）。
这是当前"queue recovery 每 host generation 只跑一次"的**唯一**实现方式——
它靠 module 级全局变量近似 host 生命周期，而不是靠一个显式 owner。这正是
Phase 3 要用 `StudioRuntimeHost` 替换掉的东西。

### 1.2 已存在的 startup-scoped 正面样板

Chat 侧已经有正确形状：`LocalAgentGraphService` 用 `graphKey` 缓存 compiled graph
（[agentGraphService.ts:139-152](services/local-agent/src/agentGraphService.ts#L139)），
graph 常驻、每次请求只传 `configurable`。Phase 3 的 host registry 应当对齐这个模型，
而不是发明新的缓存策略。

---

## 2. pet-agent 代码分类：Studio-only / Chat-only / shared

分类依据是**实际消费者**，不是路径或文件名。判定方法：对每个模块 grep 其
import 来源，若只被 `agent/studio/**` 与 Studio 测试引用则为 Studio-only。

### 2.1 Studio-only（#561 默认可改）

| 模块 | 行数 | 判断依据 |
| --- | --- | --- |
| `agent/studio/createPetAgentRuntime.ts` | 263 | 仅 `studioRuntime.ts` 与 studio 测试消费；Chat 走 `LocalAgentGraphService` |
| `agent/studio/createStudioOrchestrator.ts` | 995 | 仅 Studio 装配路径 |
| `agent/studio/types.ts` | 308 | 全部为 Studio orchestrator / pet runtime 契约 |
| `agent/studio/runQueueStore.ts` | 319 | 仅 Studio run queue |
| `agent/studio/dueRunScheduler.ts` / `dueRunContract.ts` / `fileDueRunStore.ts` | 852 | 仅 due-run 调度 |
| `agent/studio/planCapability.ts` | 217 | planner 专用 capability |
| `agent/studio/wikiCurator.ts` / `wikiReadCapability.ts` / `wikiReadToolkit.ts` | 735 | 仅 Studio wiki |
| `types/studio.ts` | 37 | `PetAgentStatus` / `StudioContext` 等 Studio 概念 |

### 2.2 Shared（改动需 Chat 影响分析）

`agent/studio/**` 向核心的全部 import 边界（去重后）：

```text
../../types/agent            AgentActor / AgentExecution / AgentModels
../../types/capability       AgentCapability
../../types/toolkit          AgentToolkit / filterAvailableToolkits
../../utils/structuredOutput
../createAgentRuntime        createOrchestratorGraph / compileAgentRegistry
                             buildOrchestratorRunInput / OrchestratorConfig
../orchestrator/review/reviewSpec   HumanReviewInterruptPayload / ReviewResponse
../orchestrator/toolkitRuntime      ToolkitRuntimeManager
../orchestrator/types               ActiveDelegationTransition
```

这 8 个都是 **shared**：Chat 路径同样消费。Phase 2 把 Studio 接到稳定 Chat
runtime 时，最可能被诱惑去改的是 `createAgentRuntime` 和 `reviewSpec`——
按 issue 要求，若必须改这两处才能推进，应停止编码并提交 blocker 说明。

### 2.3 Chat-only 保护区（默认不可改）

- `agent/orchestrator/**` 除上述被 Studio 引用的三个模块外的全部
- `agent/createAgentRuntime.ts` 的 Chat 行为语义（可读不可改）
- `services/local-agent/src/localServerChatHandler.ts`、`agentGraphService.ts`、
  `agentChannel.ts`、`chatSessionAdapter.ts`
- Chat 模式下已稳定的 TUI 交互

---

## 3. Chat 回归基线

Phase 1–6 每个 PR 必须保持以下命令全绿，作为"未影响 Chat"的最低证据：

```bash
npm run typecheck && npm test
```

关键 Chat 断言文件（这些测试的行为不允许被 Studio 重构改动）：

- `services/local-agent/src/localServerChatHandler.test.ts`
- `services/local-agent/src/agentGraphService.test.ts`
- `services/local-agent/src/agentChannel.test.ts`
- `services/local-agent/src/chatSessionAdapter.test.ts`
- `packages/pet-agent/src/agent/orchestrator/*.test.ts`

补充要求：Phase 2 起需新增 **Studio/Chat 隔离回归测试**——断言 Studio host 的
启动与关闭不改变 Chat graph 缓存身份、不影响 Chat review 路由。

---

## 4. 与并发契约的差距清单（Phase 4 的输入）

下面每一项都是当前代码与 #561 验收标准的具体冲突点，含代码位置。

| # | 验收要求 | 当前实现 | 位置 |
| --- | --- | --- | --- |
| C1 | review router 不得用 connection-global 单槽 | `PendingReviewSlot = { current: PendingReview \| null }`，第二个 review 直接 reject | [studioBridge.ts:29](services/local-agent/src/studio/studioBridge.ts#L29)、[studioBridge.ts:74-79](services/local-agent/src/studio/studioBridge.ts#L74) |
| C2 | invocation identity 稳定且可关联 | 有 `petRunId = randomUUID().slice(0,8)`，但无 `invocationId` 语义、无 lease | [createStudioOrchestrator.ts:766](packages/pet-agent/src/agent/studio/createStudioOrchestrator.ts#L766) |
| C3 | capacity/lease 模型 | 完全不存在；并发由"每 peer 串行队列"隐式保证 | [localServerStudioHandler.ts:212](services/local-agent/src/localServerStudioHandler.ts#L212) `withQueuedStudioRequest` |
| C4 | resident runtime 不持 request-scoped 状态 | `humanReviewer` 在**构造时**绑定 ws（`send`/`requestId`/`slot`），是典型 request-scoped 状态被固化进 runtime | [studioRuntime.ts:196-201](services/local-agent/src/studio/studioRuntime.ts#L196) |
| C5 | pet 复用 Chat runtime，无私有 HITL loop | `createPetAgentRuntime` 自持 `while(true) { graph.invoke(); Command({resume}) }` | [createPetAgentRuntime.ts:219-232](packages/pet-agent/src/agent/studio/createPetAgentRuntime.ts#L219) |
| C6 | pet runtime 无 mutable status | 闭包内 `let status`，invoke 期间被改写为 `'active'` 再还原 | [createPetAgentRuntime.ts:144](packages/pet-agent/src/agent/studio/createPetAgentRuntime.ts#L144)、[:212-235](packages/pet-agent/src/agent/studio/createPetAgentRuntime.ts#L212) |
| C7 | cancel 区分 invocation/task/run scope | 只有单个 `controller.signal`，取消即整 turn | [localServerStudioHandler.ts:106](services/local-agent/src/localServerStudioHandler.ts#L106) |
| C8 | 断线不丢正在执行/等 review 的 run | `rejectDisconnected()` 直接 reject pending review 并标记连接关闭 | [localServerStudioHandler.ts:72](services/local-agent/src/localServerStudioHandler.ts#L72) |
| C9 | queue recovery 每 host generation 一次 | 靠 module-level `restoredRunQueuePaths` Set 近似 | [studioRuntime.ts:89-104](services/local-agent/src/studio/studioRuntime.ts#L89) |
| C10 | 并行 wiki 提交有序列化策略 | 无；依赖当前恰好串行 | `agent/studio/wikiCurator.ts` |
| C11 | 事件带完整 correlation identity | `StudioTurnEvent` 带 `taskIndex`/`petId`/`petRunId`，缺 `runId`/`invocationId` | [types.ts](packages/pet-agent/src/agent/studio/types.ts) `StudioTurnEvent` |
| C12 | server 单一主模式 | 无 mode 概念；`run` 命令无 `--mode`，Studio 是 chat session 内的 `/studio` toggle | [cli.ts:96](services/local-agent/src/cli.ts#L96)、[composerIntent.ts:78-84](services/tui/src/commands/composerIntent.ts#L78) |
| C13 | studio 配置非法时 fail fast | 抛 `StudioNotConfiguredError`，但在**第一次请求时**才抛，不是启动时 | [studioRuntime.ts:44](services/local-agent/src/studio/studioRuntime.ts#L44) |

### 4.1 Phase 1 的处置状态

Phase 1 只解决**启动语义**，不动执行路径：

- **C12 已解决** — `pinpawo server --mode chat|studio`（`run` 保留为同一 handler
  的兼容别名，不形成第二套 runtime 行为），mode 投影进 `/runtime` 的
  `server_mode`。
- **C13 已解决** — `preflightStudioMode()` 在 server 启动、任何长期资源创建
  之前校验 studio.json / pets 与 planner 归属，失败即终止启动，不降级到 chat。
- **C1–C11 仍开放** — 这些属于执行期契约，由 Phase 2–4 处理。Phase 1 新增的
  `studioApiContract.ts` 只把目标形状**固定下来**（invocation identity、
  scoped cancel、wiki 变更事件、错误码），尚未接线到运行时。

另外，**Studio 的改动不背兼容包袱**：Phase 1 已经把 `serverMode` 定为必填而非
可选兜底，后续 Phase 同样直接删除旧的 Studio 路径，而不是收缩或保留别名。

但这条原则只覆盖 Studio 自己的东西（studio.json 读法、pet runtime 装配、
Studio 协议路径）。**不覆盖 chat 也在用的共享入口**：`run` 命令早于 server mode
存在且启动的是 chat，因此保留为 `server` 的别名（两者共用同一份定义，不会分叉出
第二套 runtime 路径）。Chat 保护区同理——那是 issue 明确的保护面，与"Studio 不
需要兼容"不冲突。

`threadId` 是一个已经正确的点：现有格式已含足够 namespace
`studio:{studioId}:thread:{conversationId}:pet:{petId}:dispatch:{dispatchId}`
（[createStudioOrchestrator.ts:453](packages/pet-agent/src/agent/studio/createStudioOrchestrator.ts#L453)），
Phase 4 只需把 `dispatch` 段正名为 `invocation` 并补 `runId`/`taskIndex`。

---

## 5. Studio 的对外 HTTP 协议层

**这一层是薄的。** 它不是一个交互式 Web 应用的后端，只是 Studio 的协议出口：

- 一个 `POST` 提交 user request；
- 一条 SSE 推送 **wiki 知识库变更**。

SSE 只推 wiki —— 对外暴露的是 Studio 的**产出**，不是执行过程。task 调度、
pet invocation、工具执行这些编排细节都不出协议边界。事件形状沿用 orchestrator
既有的 `wiki_changed`（`changedPaths`），只说哪些路径变了，不带内容或摘要；
需要内容的消费者自己去读 wiki。

当前 HTTP 路由（[localHttpHandlers.ts](services/local-agent/src/localHttpHandlers.ts)）：

```text
/health  /runtime  /studio_due_runs  /capabilities  /capabilities/rescan
/snapshot  /sessions  /sessions/resume
```

Studio 的 submit / event / review / cancel **全部只走 WebSocket 的
`studio_request` + `human_review_response`**，没有独立的 Studio HTTP 面。

**实现时机**：HTTP 层在后续 Phase 实现。Phase 1 只定协议形状
（`studio/studioApiContract.ts`），不接线运行时。

---

## 6. Phase 边界建议（对 issue 分阶段的细化）

审计后建议的实施顺序与依赖：

| Phase | 触及区域 | 可与其他 Phase 并行？ |
| --- | --- | --- |
| 1 server mode + API contract ✅ 已完成 | local-agent only（cli.ts、localHttpHandlers、协议类型） | 是，不依赖 #570 之外任何东西 |
| 2 复用 Chat runtime | pet-agent Studio-only + local-agent adapter | 依赖 #570 契约；解决 C4/C5/C6 |
| 3 `StudioRuntimeHost` | local-agent 新增 host 模块 | 依赖 Phase 1 的 mode；解决 C9/C13 |
| 4 capacity/lease | pet-agent orchestrator + host | 依赖 2、3；解决 C1/C2/C3/C7/C10/C11 |
| 5 Web/API-first + TUI 收缩 | local-agent API + services/tui | 依赖 1、4；解决 C8/C12 |
| 6 删除 per-request 路径 | 删 `buildStudioForTurn` 与 `StudioRunService` 装配职责 | 最后做 |

**Phase 1 可以立刻开始**，因为它完全落在 local-agent 且不碰 pet-agent。

---

## 7. Phase 0 验收对照

- [x] 未在 Studio/local-agent 内新增本应由 #570 拥有的共享 agent 协议（本 Phase 无代码改动）
- [x] 明确列出 pet-agent 的 Studio-only / Chat-only / shared 边界（§2）
- [x] 固定 Chat mode 回归基线（§3）
- [x] 明确 Studio config planner/worker 的解析与启动失败语义现状及差距（C13）
- [x] 定义 concurrency-ready 契约的差距清单（§4，C1–C13）
- [x] 明确 Web 完整工作流所需的 Studio API 差距（§5）
- [ ] 与 #337 runtime ownership 对齐 — **待办**：#337 的 runtime/config ownership
      结论会直接决定 `StudioRuntimeHost` 由谁持有 workdir-scoped 配置快照，
      Phase 3 开工前需确认。
