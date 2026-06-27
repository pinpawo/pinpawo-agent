# Subagent 极限管理框架设计

> 状态：设计（未实现）。日期：2026-06-28。
> 关联：#270（grep checkpoint 自指爆炸，已修）、#275（外层 recursionLimit，**A/B 推倒**）、
> #115 / [CONTEXT_GOVERNANCE_REFACTOR](./CONTEXT_GOVERNANCE_REFACTOR.md)（L1 子代理窗口淘汰是本设计第 3 阶段的基础）。

## 0. 为什么推倒 #279 的 A/B

#279 给**外层 orchestrator** 图加了显式 `recursionLimit = maxRunIterations × NODES_PER_DELEGATION + MARGIN`，并在 `runChatSession` 兜 `GraphRecursionError` 降级。问题：

1. **层搞错了**。#270 的真实爆炸在**内层 subagent**（grep 把 checkpoint 搜回、subagent 上下文顶穿窗口），不是外层 orchestrator 的节点循环。
2. **`NODES_PER_DELEGATION` 是无法准确预估的魔法数**。它想把"一次委派 = 几个 graph super-step"折算成常量，但一次委派里 subagent 跑几轮 ReAct、调几次工具是**运行时动态的**，固定 5 永远是错的近似。
3. **`recursionLimit` 没有在限制"该限制的东西"**。把硬断路器从 25 推到 135，只是让 LangGraph 的默认兜底晚点炸，不是有意义地约束图。

**结论**：极限管理不该靠调 LangGraph 的 `recursionLimit` 魔法数，而该靠**我们自己的 guard 层**，把"循环极限"翻译成**结论**交回上层决策。

## 1. 两层循环，本设计只管内层

```
外层：orchestrator 循环   decision → delegate → outcome decision → …（有 runIterationLimitGuard 软上限）
内层：subagent  ReAct 循环  llm → tool → llm → …（有 maxIterations + context fuse）   ← 本设计聚焦这里
```

#270 炸的是内层。本设计**只重做内层 subagent 的极限模型**；外层是否还需要硬 `recursionLimit`，等内层做对后再回看（很可能不再需要，因为内层不再往上抛 `GraphRecursionError`）。

## 2. 极限模型（设计意图，来自需求方定调）

**token 为主 + 大迭代预算 + review 防空跑 + 主动停。** 五条：

1. **token 为主**：context/token 占用是主极限信号，不是 ReAct 轮次。
2. **迭代预算拉大（~100）**：不再用 8/12/16 这种小 `maxIterations` 早早掐断；给足空间让 subagent 真正完成多步任务。
3. **大预算 ⇒ 必然撞 token 上限**：轮次这么大，跑着跑着 token 一定逼近上下文窗口。**这是预期内的正常事件，不是异常。**
4. **撞 token guard 时先 review，防空跑**：不是一撞阈值就停。先**回看已有进展**，判断 subagent 是不是在原地打转 / 空跑：
   - 有实质进展 → 压缩旧工具输出（evict/truncate）腾出空间，继续跑；
   - 在空跑（无新结论、反复同类调用）→ 主动停，别烧 token。
5. **迭代预算到顶（100）⇒ 主动停**：最外圈预算用尽，subagent **主动停下**，产出"未跑完"结论交回 orchestrator。

核心转变：**从"抛错被 catch"转为"主动软着陆 + 产出结论"。** 极限不是 error，是一种 `completionReason`。

## 3. 现状 vs 目标（gap analysis）

| 设计点 | 现有机制（代码） | 状态 | 缺口 |
|---|---|---|---|
| 1 token 为主 | `createContextWindowFuseMiddleware`（`wrapModelCall`，token ≥ 85%×窗口）| ✅ 信号有 | 行为是 **throw**，应改主动软着陆 |
| 2 迭代预算拉大 | `DEFAULT_SUBAGENT_MAX_ITERATIONS=12`、general 16、capability 8，且**当作 `recursionLimit` 用**（[createSubagent.ts:231](../packages/pet-agent/src/subagent/createSubagent.ts#L231)）| ❌ 太小、单位错位 | 拉到 ~100；厘清"ReAct 轮次"与 graph `recursionLimit` 的关系 |
| 3 必撞 token | fuse 必触发 | ✅ 符合预期 | — |
| 4 review 防空跑 | `contextPolicy`（evict/truncate 旧工具输出，[contextPolicy.ts](../packages/pet-agent/src/subagent/contextPolicy.ts)）| ⚠️ 只有**机械压缩**，无"是否空跑"判断 | **新增 progress/空跑判定**——本设计的真正新语义 |
| 5 到顶主动停 | fuse throw → catch 转 `limit_reached`（[createSubagent.ts:259-281](../packages/pet-agent/src/subagent/createSubagent.ts#L259)）| ⚠️ 靠抛错实现 | 改为主动停 + 干净结论 |

**真正缺的只有两点**：第 4 点的"空跑判定"（全新），第 5 点的"主动停而非抛错"（重构）。其余是参数与行为调整。

## 4. 核心：把 Decision / Guard 从概念抽象落成代码抽象

需求方定调：控制层概念太多，要回归 orchestrator 已有的 **Decision vs Guard** 区分，并且**这次不只是定义上分，代码也同步抽出来**成为可复用的一等抽象。形成关系：

```
Node            → Decision
Node            → Guard
middleware(pos) → Decision      （pos = beforeModel / wrapModelCall / afterModel 钩子位置）
middleware(pos) → Guard
```

### 4.1 现状：只有命名约定，没有代码抽象

orchestrator 里 `runIterationLimitGuard` / `delegationOutcomeDecisionGuard` / `runOrchestrationDecision` 都是 `createOrchestratorGraph` 闭包内的内联 async 函数，**靠函数名区分 Decision/Guard，没有共同类型/接口/签名**。subagent 侧更散（fuse throw、contextPolicy 压缩、catch limit_reached 各写各的）。

### 4.2 两个抽象的语义契约

- **Guard = 硬条件放行/拦截**。确定性谓词，**无 LLM**：输入上下文 → `pass`（放行，可带 state 更新）或 `block`（拦截，带结论）。例：`runIterationLimitGuard`（委派数到顶）、`delegationOutcomeDecisionGuard`（completionReason 是否 limit_reached）。
- **Decision = 选路**。在多个**合法去向**中选一个，**可能用 LLM/结构化输出**。例：`runOrchestrationDecision`。

### 4.3 位置无关（position-independent）

同一个 Guard/Decision 抽象，既能在 graph **node** 调用，也能在 middleware 的某个 **position 钩子**调用。这是 `Node→Guard` 与 `middleware(pos)→Guard` 能并存的前提：抽象本身是 `(input) => Verdict` 的纯契约，**与"在哪调"解耦**。Node 适配器把 verdict 翻成 state 更新；middleware 适配器把 verdict 翻成"放行 / 改写 request / 主动结束"。

### 4.4 本次落地的 Guard：重复 messages 检查（最小实现）

需求方明确：**"防空跑"策略本身作为 interface 留出，现在只实现最基本的一个判断——`messages` 输入是否多次重复。**

- **Guard 名**：`RepeatedInputGuard`（暂名）。
- **判据（唯一且最小）**：subagent 喂给模型的 `messages`（或其指纹）是否**多次重复出现** → 是则判定打转，`block`。不做结论增量、token 比等复杂判据。
- **接口形状**：`SubagentLoopGuard` interface，`RepeatedInputGuard` 是其一个实现；将来"结论增量 / token 比 / review 防空跑"都作为**同一 interface 的其他实现**接入，不改调用方。
- **挂载位置**：subagent middleware 的 **`wrapModelCall`** position。关键：判据要看的是**真正提交给 LLM 的那组 messages**（`request.messages`），即**经过本轮 contextPolicy 压缩之后**的输入——`beforeModel` 看到的 `state.messages` 是只增的历史，永远不重复，抓不住打转；而压缩后的"实质输入"在空跑时会稳定成同一组，这才是有意义的"重复"信号。
- **block 行为**：`wrapModelCall` 命中时**不调 handler**（不调模型），返回 `new Command({ goto: END, update: { messages: [notice] } })` 优雅结束（无 throw）。notice 带 stop marker，`createSubagent` 据此报 **completionReason='limit_reached'**，交回 orchestrator（`delegationOutcomeDecisionGuard` 已消费 limit_reached，回交链路现成）。

### 4.5 复用清单（不新增多余概念）

- **context fuse middleware** → 归为一个 Guard（token 硬阈值）。后续把 throw 改成走统一的 Guard block 路径（主动停）。
- **contextPolicy（evict/truncate）** → 仍是压缩执行器，不是 Guard/Decision，保持原职。
- **completionReason='limit_reached'** → 所有 Guard block 的统一结论载体。
- **runIterationLimitGuard / delegationOutcomeDecisionGuard（orchestrator）** → 迁移到新 Guard 抽象的**示范对象**，但迁移本身**另开 PR**（见 §6 范围）。

## 5. 迭代预算与 graph recursionLimit 的关系（第 2 点的厘清）

- subagent 内部是 LangGraph ReAct agent，`recursionLimit` 是它的硬断路（[createSubagent.ts:231](../packages/pet-agent/src/subagent/createSubagent.ts#L231)，当前 `= maxIterations`，单位错位）。
- 预期停止点应是 **Guard 主动停**（重复输入 / token 阈值），不是 `recursionLimit`。后者退化为"真死循环"的最后断路。
- 因为 Guard 主动停产出 `limit_reached`（不外抛 `GraphRecursionError`），**外层 orchestrator 的硬 `recursionLimit`（#279 A）大概率不再需要**——P4 验证后决定去留（#275 的最终归宿）。

## 6. 落地范围

需求方定调：**先在 subagent 引入 Decision/Guard 代码抽象（解决重复 messages 检查），抽象设计成 orchestrator 也能复用的形状；orchestrator 现有 Guard/Decision 的迁移另开 PR。**

## 7. 实施阶段（建议）

**本 PR（subagent 内）**：

1. **P1 引入 Guard 代码抽象**：定义 `SubagentLoopGuard` interface + verdict 类型 + 一个把 Guard 挂到 middleware position（`beforeModel`）的适配器。
2. **P2 `RepeatedInputGuard`**：唯一最小实现——`messages` 指纹连续重复达阈值 → block，主动停产出 `completionReason='limit_reached'`，不抛错。
3. **P3 fuse 归位**：把现有 context fuse 表达成同一 Guard 抽象下的一个 Guard（token 硬阈值），block 路径与 P2 统一（throw → 主动停）。

**后续 PR（独立）**：

4. **P4 拉大迭代预算**：`maxIterations` → ~100，厘清与 `recursionLimit` 关系。
5. **P5 orchestrator 迁移**：把 `runIterationLimitGuard` / `delegationOutcomeDecisionGuard` / `runOrchestrationDecision` 迁到新 Decision/Guard 抽象。
6. **P6 回看外层 recursionLimit**：#275 最终归宿。
7. **P7 策略增强**：结论增量 / token 比 / review 防空跑作为 `SubagentLoopGuard` 的新实现接入。

本 PR 聚焦 P1–P3：用最小的重复输入 Guard 把"打转"挡住，并把概念归置到 Decision/Guard 抽象。

## 8. 验证

- Guard 单测：构造 messages 指纹连续重复的序列，断言 `RepeatedInputGuard` 在阈值处 block。
- subagent 单测：模型反复收到同一组 messages → 断言**不抛错、产出 `completionReason='limit_reached'`**。
- 回归：现有 `completionReason` / handoff / `delegationOutcomeDecisionGuard` 链路不变；正常（不重复）任务不被误停。
