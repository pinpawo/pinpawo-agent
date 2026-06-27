# 编排图 Recursion Limit 逃逸 & Subagent 上下文爆炸 —— 诊断

> 状态：诊断（未改代码）。复现自一次真实会话（thread `…2e773650`，workdir
> `aisouls/manage`）：subagent 内 `grep_search` 触发
> `SubagentContextLimitReachedError`（估算 1,268,999 token / 阈值 850,000），
> 随后编排图以 `GraphRecursionError: Recursion limit of 25 reached` 冒泡为 chat error。
>
> **第一性根因（LangSmith trace 实测）**：一次 `grep_search` 递归扫描 workdir 时**搜进了
> agent 自己的 checkpoint 目录 `.pinpawo/checkpoints-tui/objects/`**，返回 **4,330,842
> 字符（50 行 × 单行最长 ~493KB 的序列化对话 JSON）**的工具结果 —— 自指爆炸。根因是
> `walkFiles` 不排除 `.pinpawo` + `grep_search` 只限行数不限字节。fuse / recursion 都是
> 下游受害者。见 §2.1。

## 1. 现象（来自日志）

```
operation_started  kind=bash.grep_search
Error in handler StreamToolsHandler, handleToolStart: TypeError [ERR_INVALID_STATE]: Invalid state: Controller is already closed   (×N)
operation_failed   kind=bash.grep_search
  error=SubagentContextLimitReachedError { estimatedTokens: 1268999, limitTokens: 850000 }
Error in handler StreamMessagesHandler, handleChainEnd: ... Controller is already closed   (×N)
[local-server] chat error: GraphRecursionError: Recursion limit of 25 reached without hitting a stop condition.
```

两条独立的故障线索：

1. **`Controller is already closed`** —— 一串来自 LangChain stream handler 的 `TypeError`。
2. **`GraphRecursionError: Recursion limit of 25`** —— 最终冒泡成 chat error 的那个。

## 2. 根因一：Subagent 上下文失控 + fuse 触发后的 controller 噪音

### 2.1 上下文为什么会爆到 1.26M token —— **一次 grep 搜进了 agent 自己的 checkpoint 目录**

> 由 LangSmith trace `019f0881-fc49-...`（11.7MB，`thread_id` 与 `e2b3` 同一会话，
> `ls_run_depth: 1`，即 depth-0 编排图里的子运行）逐条消息抽查**实测**得出。
> 此节**修正了本文档早先"不是单次、是累积"的错误判断**。

实测：该子运行的 `outputs.messages` 里有一条 **`grep_search` 的 ToolMessage，content =
4,330,842 字符（≈ 4.3M chars / 1M+ token）**，外加 4 条各 ~183KB 的同名重复。把这条 4.3M
的工具结果拆开看：

- 一共 **50 行**（正好是 `grep_search` 默认 `limit ?? 50`，行数限制其实生效了）；
- **50 行 100% 命中** `…/aisouls/manage/.pinpawo/checkpoints-tui/objects/<hash>`；
- **单行最长 492,877 字节（~493KB）**。

也就是说：grep 递归扫描 workdir 时，**扫进了 agent 自己的 checkpoint 存储目录
`.pinpawo/checkpoints-tui/objects/`**。每个 object 文件是把一整条对话历史压成**一行**的
序列化 JSON（`{"lc":1,"type":"constructor",…AIMessage…capability_search…}`）。50 行 ×
每行几百 KB ≈ 4.3M 字符，**一次工具调用**就把它塞回了 subagent 上下文。叠加重放，估算 token
冲到 1,268,999，fuse 触发。

**这是一次自指爆炸（self-reference blow-up）：agent 把自己的"记忆"搜了回来当上下文，
而读取这段上下文又写进新的 checkpoint，雪球。**

两个真正的缺陷叠加：

1. **`grep_search` 只限行数、不限字节** —— `maxResults = Math.min(limit ?? 50, 200)`
   （[searchTools.ts:53](../services/local-agent/src/toolkits/local/searchTools.ts#L53)）
   只数"匹配行数"。但 checkpoint object 是**单行 ~493KB 的超长 JSON**，50 行就 4.3M 字符。
   工具**没有任何单行截断 / 单次结果总字节上限**（对比 `run_shell` 有
   `SHELL_OUTPUT_LIMIT_CHARS = 20_000`，
   [shellTools.ts:96](../services/local-agent/src/toolkits/local/shellTools.ts#L96)，
   grep_search 完全没有对应物）。
2. **`walkFiles` 无忽略机制** —— 无差别递归遍历 workdir 整棵子树，**不跳过 `.git` /
   `node_modules` / `.pinpawo` / 任何隐藏目录或二进制**
   （[fileSystemUtils.ts:17-41](../services/local-agent/src/toolkits/local/fileSystemUtils.ts#L17)）。
   于是一定会扫进 `.pinpawo/checkpoints-tui/objects/`，把 agent 自己的序列化记忆当成
   "代码"搜回来。

fuse 阈值 = `contextWindowTokens × 0.85`（`DEFAULT_CONTEXT_FUSE_RATIO`，
[createSubagent.ts:16](../packages/pet-agent/src/subagent/createSubagent.ts#L16) /
[:95](../packages/pet-agent/src/subagent/createSubagent.ts#L95)）。850,000 反推出
`contextWindowTokens ≈ 1,000,000`。fuse **正确触发**了，它是受害者不是肇事者。

> 修正记录：本文档曾断言"单个工具边界控制得很好、1.26M 是几十次累积"。trace 实测推翻了
> 这一点——**单次 grep_search 就返回了 4.3M 字符**，因为行数上限挡不住"单行 ~493KB 的
> checkpoint JSON"，且遍历没排除 `.pinpawo`。这才是 token 爆炸的第一性原因。

### 2.2 fuse 正确触发了，`Controller is already closed` 是次生噪音

`createContextWindowFuseMiddleware.wrapModelCall` 在估算 token ≥ 阈值时
抛 `SubagentContextLimitReachedError`
（[createSubagent.ts:122](../packages/pet-agent/src/subagent/createSubagent.ts#L122)）。
这是**预期且正确**的最后一道保险。

抛错让 subagent 的 `agent.stream()` 提前结束，消费循环
（[createSubagent.ts:235](../packages/pet-agent/src/subagent/createSubagent.ts#L235)）退出、
底层 `ReadableStream` controller 关闭。但 LangChain 的 `StreamToolsHandler` /
`StreamMessagesHandler` 回调还在尝试往**已关闭的 controller** 推
`handleToolStart` / `handleToolEnd` / `handleChainEnd` 事件 →
`TypeError [ERR_INVALID_STATE]: Controller is already closed`。

**结论：这串报错不影响正确性，是 fuse 触发后流提前关闭的副作用噪音。** 但它会污染日志，
也提示我们流的拆解（teardown）顺序不干净。

### 2.3 关键：这一条 **不是** recursion limit 的成因

`SubagentContextLimitReachedError` 被 `createSubagent` 的 catch 正确接住，
归类为 `completionReason: 'limit_reached'` 正常返回
（[createSubagent.ts:259-281](../packages/pet-agent/src/subagent/createSubagent.ts#L259)）。
它**没有**让 subagent 抛 `GraphRecursionError`。recursion limit 是编排图层的独立问题，见根因二。

## 3. 根因二（核心）：编排图硬 recursionLimit 逃逸，软 guard 永远追不上

### 3.1 "25" 是 LangGraph 默认值，不是我们设的任何限制

编排图通过 `agentGraphService.stream()` 启动，传给 `graph.stream()` 的 config
**没有 `recursionLimit` 字段**
（[agentGraphService.ts:118-132](../services/local-agent/src/agentGraphService.ts#L118)）：

```ts
return streamOrchestratorGraph(graph, input, {
  signal: setup.input.signal,
  configurable: buildConfigurable(setup),
  streamMode: ['messages', 'values'],
  // ← 没有 recursionLimit
});
```

`runAgent`（非 stream 路径）同样没传
（[runAgent.ts:50-56](../packages/pet-agent/src/agent/runAgent.ts#L50)）。

所以编排图跑在 LangGraph 默认的 **25 个节点步数**上限。日志里的 "25" 就是它，
与 `DEFAULT_ORCHESTRATOR_MAX_ITERATIONS = 25`
（[createAgentRuntime.ts:123](../packages/pet-agent/src/agent/createAgentRuntime.ts#L123)）**数值巧合但语义无关**——
后者从未传进图。

### 3.2 我们以为的 guard 数的是另一个量

`runIterationLimitGuard`（图节点 `delegationOutcomeIterationGuard`，
[createAgentRuntime.ts:487](../packages/pet-agent/src/agent/createAgentRuntime.ts#L487)）
是个**软的、节点级**的 guard，只在：

```ts
state.runIterationCount >= maxRunIterationLimit   // 默认 25
```

时触发，给一条"已达上限、记为待续跑"的 AIMessage 并结束。

但 `runIterationCount` **只在每次委派完成时 +1**：
- `capabilityNode` 返回 `runIterationCount: state.runIterationCount + 1`
  （[createAgentRuntime.ts:1173](../packages/pet-agent/src/agent/createAgentRuntime.ts#L1173)）
- `generalNode` 同理
  （[createAgentRuntime.ts:1276](../packages/pet-agent/src/agent/createAgentRuntime.ts#L1276)）

即 **1 次委派 = 计数 +1**。

### 3.3 两个计数器单位不同，软 guard 必然落后于硬 limit

LangGraph 的 `recursionLimit` 数的是 **节点转移步数（super-steps）**。一次委派往返要经过
多个节点：

```
prepare → compactContext → capabilityDiscovery → userIntentDecisionGuard
  → userIntentDecision → capability/general
  → delegationOutcomeIterationGuard → delegationOutcomeDecisionGuard
  → delegationOutcomeDecision → (capability/general | answer | end)
```

一次委派往返约消耗 **4~5 个节点步**，但只让 `runIterationCount` +1。

于是：

| 计数器 | 单位 | 上限 | 在第几次委派触顶 |
|---|---|---|---|
| LangGraph `recursionLimit`（硬） | 节点步 | 25（默认） | **约第 5~6 次委派往返** |
| `runIterationLimitGuard`（软） | 完成的委派数 | 25 | 第 25 次委派 |

**软 guard 要等 25 次委派，硬 limit 在约第 5~6 次委派（25 个节点步）就先炸了。** 软
guard 永远没机会触发。

### 3.4 硬 `GraphRecursionError` 在编排图层完全没被 catch

`createSubagent` 里那段 `GRAPH_RECURSION_LIMIT` 捕获
（[createSubagent.ts:259-281](../packages/pet-agent/src/subagent/createSubagent.ts#L259)）
**只兜 subagent 自己的内部图**，对编排图无效。

编排图的 stream 消费循环
（[chatSessionAdapter.ts:266-332](../services/local-agent/src/chatSessionAdapter.ts#L266)）
没有任何 `GraphRecursionError` 的 catch / 降级分支，于是它直接冒泡到
`localServerChatHandler` 的顶层 catch
（[localServerChatHandler.ts:315-329](../services/local-agent/src/localServerChatHandler.ts#L315)），
变成 `[local-server] chat error`。

## 4. 修复方案（建议）

优先级顺序（trace 实测后重排）：**D0 / D1 是第一性根因，最高优先级**；A/B 是失控时的
断路与降级；C 是日志噪音。

### 修复 D0（最高优先级）：遍历排除 `.pinpawo` 等目录

`walkFiles` 必须有忽略列表，至少排除 `.pinpawo`（agent 自己的 checkpoint / 工件存储）、
`.git`、`node_modules`，以及隐藏目录与已知二进制。这是阻断"自指爆炸"的最直接一刀。

- 改 [fileSystemUtils.ts:17-41](../services/local-agent/src/toolkits/local/fileSystemUtils.ts#L17)
  的 `walkFiles`：在 push 子目录前按忽略集过滤；`grep_search` / `glob_search` 共用。
- 忽略集应可配置但带安全默认；`.pinpawo` 必须**硬编码**进默认（它是 agent 的内部状态，
  搜它一定是错的）。

### 修复 D1（最高优先级）：`grep_search` / `glob_search` 增加字节级上限

行数上限挡不住"单行 ~493KB 的 JSON"。工具必须有：

- **单行截断**：超过 N（如 2,000 字符）的匹配行截断并标注，避免单行就是几百 KB。
- **单次结果总字节上限**：累计输出超过 M（参考 `run_shell` 的 20,000 字符量级，或更大但
  有界）即停止并提示"结果过大，请收窄 query/path"。
- 实现位置：[searchTools.ts:44-96](../services/local-agent/src/toolkits/local/searchTools.ts#L44)
  的 `grepSearchTool`（以及 `globSearchTool` 的路径长度同理）。

> D0 + D1 任一单独都能避免本次故障，但应**同时做**：D0 防自指、D1 防任何意外的巨型文件
> （minified bundle、lockfile、二进制误读）。

### 修复 A：给编排图 stream/invoke 传显式 `recursionLimit`

> ✅ 已实现（#275）：`resolveOrchestratorRecursionLimit(maxRunIterations)` 导出自
> `createAgentRuntime`，由 `agentGraphService.stream/invokeState` 与 `runAgent` 调用；
> `NODES_PER_DELEGATION = 5`、`ORCHESTRATOR_RECURSION_MARGIN = 10`。

把编排图的硬上限与软上限对齐成"软先于硬触发"。当前软上限默认 25 次委派，每次委派 ~4–5
个节点步，所以硬上限应至少 `maxRunIterations × 每委派节点步 + 余量`。

- 在 `agentGraphService.stream` / `invokeState` 和 `runAgent` 的 config 里补
  `recursionLimit`（[agentGraphService.ts:126](../services/local-agent/src/agentGraphService.ts#L126)、
  [runAgent.ts:52](../packages/pet-agent/src/agent/runAgent.ts#L52)）。
- 取值建议由 `config.maxRunIterations`（或 `DEFAULT_ORCHESTRATOR_MAX_ITERATIONS`）
  派生：`recursionLimit = maxRunIterations × NODES_PER_DELEGATION + MARGIN`，
  让软 guard 总是先触发、给出友好待续跑文案，硬 limit 只作为真正失控时的最后断路。
- `NODES_PER_DELEGATION` 作为一个具名常量放在 `createAgentRuntime`，紧挨
  `DEFAULT_ORCHESTRATOR_MAX_ITERATIONS`，并加注释说明它必须随图结构变化更新。

### 修复 B：编排图层兜 `GraphRecursionError`，降级为待续跑（推荐行为）

> ✅ 已实现（#275）：`runChatSession` 的 stream try/catch 用共享的
> `isGraphRecursionLimitError` 识别并降级为 `{status:'completed'}` + 待续跑文案；
> 非 recursion 错误原样抛出。

即便修复 A 让软 guard 先触发，硬 limit 仍应有兜底（防御异常路径，如节点循环 bug）。

**推荐：触顶后优雅降级为"待续跑"，与 `runIterationLimitGuard` 现有行为一致**，
理由：
- 用户体验一致——无论是软上限还是硬断路，用户看到的都是"已达上限、委派记为待续跑、
  可继续提交下一轮"，而不是一个裸 stack。
- 语义正确——recursion 触顶意味着"这一轮没跑完"，恰好就是"待续跑"。
- 实现位置：在 `chatSessionAdapter.runChatSession` 的 stream `try/catch`
  （[chatSessionAdapter.ts:266-332](../services/local-agent/src/chatSessionAdapter.ts#L266)）
  捕获 `GraphRecursionError`（用与 `createSubagent` 同款的 `lc_error_code === 'GRAPH_RECURSION_LIMIT'`
  / 正则双重判定），转成一条 assistant 完成消息 + `message.completed`，正常 return
  `{ status: 'completed' }`，不抛错。

> 备选（不推荐作为默认）：仍然失败，但转成带分类的错误，让 TUI 区分"上下文爆炸 vs
> 节点循环"。可作为 B 的补充——在降级文案里带上分类标签，但仍走 completed 而非 error。

### 修复 C：收敛 fuse 触发后的 `Controller is already closed` 噪音

`SubagentContextLimitReachedError` 抛出后，subagent 流的拆解顺序不干净。

- 在 `createSubagent` catch 到 fuse 错误时，确保先停止 / 显式关闭流再让 handler 收尾，
  或吞掉 teardown 阶段的 `ERR_INVALID_STATE` controller 错误（它们对正确性无影响）。
- 这条优先级最低（纯日志噪音），但能让上面两个 fix 的日志干净、可读。

### 修复 D2（纵深防御，独立跟进）：general lane 会话级工具输出淘汰

D0/D1 堵住了"单次巨型工具结果"。D2 是纵深防御：即便单次结果有界，多次工具调用仍会累积。

general lane 委派不挂 `contextPolicy`
（[createAgentRuntime.ts:1228](../packages/pet-agent/src/agent/createAgentRuntime.ts#L1228) 起），
单条工具原始输出无法被逐条淘汰，多次累积只能等 fuse。长期应让 general lane 也具备工具原始
输出淘汰能力（与 capability lane 对齐），把累积规模在到达 fuse 之前压下去。关联
[[context-governance-core-invariant]]（"conclusions cross boundaries, transcripts
don't"，L2 lane-merge → L1 subagent eviction）。

此项范围较大，建议单独立项。优先级低于 D0/D1（后者直接消除本次故障的第一性原因）。

## 5. 验证

- 单测：构造一个会连续委派 > recursionLimit/NODES_PER_DELEGATION 次的假图，断言
  修复 A 后软 guard 先触发、修复 B 后即便硬 limit 触顶也返回 `completed` 而非抛错。
  参考现有 `eval:hitl -w pinpawo-local-agent`（驱动假图验证 structured-resume）。
- 复现脚本：让 subagent 工具返回超阈值内容，断言 fuse 仍触发 `limit_reached`，
  且修复 C 后无 `Controller is already closed`。
```
