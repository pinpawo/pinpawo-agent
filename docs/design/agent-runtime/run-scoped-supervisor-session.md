# Root、Supervisor 与 Capability 的状态与交接

状态：已接入运行图并完成下述验证；本文为待 review 的工作设计稿。
更新于 2026-09-11；实现基线为已合并的 [PR #795](https://github.com/pinpawo/pinpawo-agent/pull/795)。

Root 状态、Entry `continue`、Supervisor 消息交接、Capability 执行及 Host 计划投影已统一接入。
不再保留独立 active delegation、continuation、pending call 或下一次执行临时槽。

## 核心结构

Root 承载会话、整体执行流程和 checkpoint。Supervisor 在这个流程中负责规划、验收和
调度，工作上下文是 run-scope。Capability executor 独立负责具体执行。

**Supervisor 内部保留控制调用及确认；交给 Root 的是实际 delegation 调用，Root 保存并执行，
再写入对应结果。两边各自有完整消息，不增加一份中间 proposal 状态。**

| 部分 | 职责 |
| --- | --- |
| Root | 保存状态与消息，落实调度更新，执行节点路由，管理入口、checkpoint、暂停、失败和回复发布 |
| Entry Answer | 非原生恢复运行的入口，结合用户输入与已有状态，回答、发起规划或继续工作 |
| Supervisor | 使用 createAgent，依据整体状态决定计划、验收和后续执行；不在内部执行 Capability |
| Capability 工具执行 | 对 Root 表现为一次 `delegate_capability` tool call，由 `capability` 节点承载执行；工具内部复用独立 executor，不验收自身结果、不决定下一任务 |

工具调用是对外边界，executor 是内部实现：一次调用内部仍完成
briefing → Toolkit 绑定 → createAgent 执行 → finalize → 交付，再返回对应 ToolMessage。
这些步骤不是 Root 上的多次工具调用，也不需要因工具化拆掉原 executor 封装。

<a id="current-ownership-and-lifetime"></a>

## 状态：只保存必要事实

Root 用 `runSupervisorState` 保存当前 run 的 Supervisor 业务状态，只表达目标、计划和
必要任务进度。以下为[业务状态类型](../../../packages/pet-agent/src/agent/orchestrator/runSupervisor/state.ts)的简化示意：

```ts
type RunSupervisorState = {
  goal: string | null;
  plan: SupervisorPlan; // 计划及必要任务进度
};
```

不另设 `activeDelegation`、`proposal`、`pendingCall`、`nextAttempt`、`lastOutcome`
或嵌套 `run` 容器。调用参数与已有事实能够推导的信息，不重复放进 state。

删除独立 active delegation 不等于删除执行身份和进度。计划任务使用稳定 ID，以及
`pending / completed / superseded` 业务进度，明确尚未验收、已验收或被替换。
执行中、已返回和执行失败从该任务最新的实际工具调用及结果推导，不写回计划。
当前任务由计划中首个未完成且未被替换的任务确定。
delegation ID、调用 ID、交付引用仍用于执行校验与追溯，但不形成另一份当前任务容器。

Capability 节点只提交私有消息、Root ToolMessage，以及产物索引、授权记录、执行计数等
程序拥有的运行事实；不更新 `runSupervisorState`。交付只保存在配对的 ToolMessage，
删除重复的 `sessionDelegationResults`。验收必须依据当前任务最近一次执行的有效交付，
不能在重试失败后回退到旧成功结果。无新交付以 `missing_deliverable` 错误 ToolMessage
返回 Supervisor，由其决定补做或回复；真正的运行异常仍走框架错误出口。
暂停路由读取本轮最新执行结果的 `paused`，不另存 Root `taskPauseInterrupt` 标志；
原生 interrupt 及 Capability 内部暂停机制不变。

| 信息 | 保存与生命周期 |
| --- | --- |
| 目标、计划、任务进度 | Root 的 `runSupervisorState` 保存，Supervisor 决策；保存后的状态可供后续运行参考 |
| Supervisor 工作消息 | 使用 Root 消息存储并保持工作归属；每个新 run 重置工作视图，不继承上轮工作现场 |
| delegation 调用及结果 | Root 消息与 checkpoint 保存，作为实际执行记录 |
| Capability 私有消息 | 继续留在原私有 lane 和 delegation/run 作用域 |
| runId、traceId、预算、输入消费 | 复用 Root 必要运行字段；新 run 初始化，原生 interrupt 恢复时保留，不再复制一个 `runSupervisorState.run` |
| 交付、产物、授权、运行出口 | 交付保存在工具结果中；产物索引、授权与运行出口复用必要字段，授权按当前 generation 校验，不由模型任意修改 |

### runSupervisorState 与 snapshot

snapshot 不是另一个对象或状态字段，而是 **已保存的 Supervisor 业务状态在后续读取时的称呼**。
Entry Answer 从保存的 `runSupervisorState` 了解计划进度，从 Root 的可见消息和交付记录获取结果上下文。
不复制一份计划，不引入“候选/采用”协议，也不保存上一轮 Supervisor 实例。
`run` 前缀表达状态属于一次 Supervisor 运行；checkpoint 可保留其历史值供参考，
不代表新 run 自动恢复上一轮 Supervisor 的工作现场。

新 run 重置的是 Supervisor 工作现场，不是删除作为后续参考的计划与执行事实。
旧工作消息可以物理保留在原作用域，但不再作为本轮 Supervisor 工作历史自动载入；
重置工作视图不要求清空 Root 全部消息。

## 入口与恢复

新 run 仅由 `buildOrchestratorRunInput` 初始化并绑定用户消息；`prepare` 校验身份，
不再补造另一份 run。Entry 将路由调用与确认提交到 Root 后直接进入 Supervisor，
不通过 `Send` 复制整份 Root state。Supervisor 从本轮最新主会话工具消息识别
`plan_request`（Entry）或其他执行边界（Boundary），原生恢复读取原 checkpoint。
Entry ToolNode 仅执行当前路由调用；旧 run 的 ToolMessage 不参与本次工具去重，
避免 provider 复用调用 ID 时把新请求误判为已执行。实际调用与确认仍配对保存在 Root。

执行预算统一在 Supervisor 调用前检查，普通执行返回和暂停恢复共用该检查点，
不再增加空的预算节点。Answer 仍独立发布主会话回复，从本轮 Supervisor 已保存的
自然回复或 `review_current.reply` 读取正文，不另存 `runSupervisorReply`。
入口、压缩、执行和暂停节点的普通异常统一记录 Root 终止错误；原生 interrupt
和取消不转换成普通失败。回复消息统一标记 runId 与 traceId。

**原生 interrupt 按原生机制恢复；其他情况一律先经过 Entry Answer。**

| 入口 | 处理 |
| --- | --- |
| 原生 interrupt | 恢复原 checkpoint、run、delegation 与调用现场，不重置工作上下文和预算 |
| 其他运行 | 新 run，经 Entry Answer；参考保存的业务状态与可见结果，不自动重放旧调用或恢复旧执行实例 |

Entry Answer 保留现有 `plan_request` 发起规划，新增 `continue` 表达继续未完成工作：

- `plan_request` → Supervisor Entry mode。
- `continue` → Supervisor Boundary mode，根据已有进度验收、调整或推进。

`continue` 不是原生 resume，也不是 snapshot 采用工具。Entry Answer 可以直接回复，
无需因为有旧计划就进入 Supervisor；直接回复不抹掉已有业务进度。

Boundary 不以独立 active delegation 非空作为前提。例如 A 已验收、B 尚未执行，
等待用户后正常结束，新 run 可以经 Entry Answer 进入 Boundary 安排 B，
不复活 A、不重复验收 A，也不重交整份计划。
Entry/Boundary 的校验以计划事实为准，不依赖旧 active delegation 字段。

task 是计划任务，delegation 是具体执行实例。同一 run 内可以对同一 delegation 做多次 attempt；
非原生新 run 若继续处理该任务，产生本轮执行实例，不自动续读旧 delegation 私有历史。
旧消息留在原 lane，不放宽现有精确作用域查询。

入口不由 AIMessage/ToolMessage 是否存在或是否配对决定。原生 interrupt 可发生在不同位置；
非原生取消或失败不能冒充原生恢复，也不自动重跑可能已产生副作用的执行。

## 消息交接：内部控制与 Root 执行

### 工具职责

三个控制工具保留在 Supervisor 内部，均可导向同一 Capability 执行过程：

| 工具 | 调度含义 |
| --- | --- |
| `submit_plan` | 提交计划，选择第一项执行 |
| `review_current` | 根据整体进度验收、继续当前任务或推进下一项；没有待验收任务时不虚构旧任务的完成判断 |
| `adjust_plan` | 保留已完成进度，调整后续安排，选择当前应执行项 |
| `capability_details` | 内部查询，正常返回查询结果并继续 createAgent 循环，不交给 Root 执行 |

无工作可执行、需要提问或结束时，落实相应计划/进度并走已有回复出口，
不为了统一形状创建空的 delegation 调用。

`review_current` 的 `reply` 是本轮停止执行并回复的出口，不是进度通知：
继续当前任务或推进下一项时省略它；填写后不产生 delegation 调用。
需要用户信息、暂不验收时可省略 `completed` 并填写 `reply`，计划进度保持不变；
也可直接自然回复。已交付任务在不回复、准备继续调度时必须明确完成判断。

### 调用形状

```text
Supervisor 内部
  AIMessage：submit_plan / review_current / adjust_plan，调用 C
  ToolMessage：提交/交接确认，关联 C

  内部工具或退出适配完成确定性转换
  handoff：AIMessage(delegate_capability，调用 D，执行参数)

Root
  保存调用 D 与必要业务更新，checkpoint
  capability 节点执行工具调用 D → 工具内部的独立 executor
  ToolMessage：实际执行结果，关联 D
  → Supervisor 正常判断下一步，或进入暂停/失败等出口
```

这里的 proposal 是调度决定及其交接含义，**交给 Root 的载体就是 delegation AIMessage**，
不是 `runSupervisorState.proposal`。Root 不先存一份 proposal、再切节点取出并重新拼调用。

控制调用 C 保留原始参数和提交确认。派生调用 D 使用独立调用 ID，携带执行所需参数，
保留来源动作、控制调用及 delegation/run 关联；不覆盖 C，也不增加一轮模型派发。
计划变更随本次交接落实到业务状态，不另外保存“待处理计划”或临时交接容器。

Supervisor 工作上下文与 Root 执行消息各自完整。配对仅表达“结果属于哪次调用”及
工具消息协议完整性，不负责调度、验收或恢复，不扩展为两套调用状态机。
C 的确认不是执行成功，D 的结果也不是任务验收通过。

### 退出与执行边界

内部工具使用确认 ToolMessage 与 `returnDirect` 退出；
结束一次 Supervisor invoke 不等于结束业务 run。
调整的是交接输出：工具或退出适配直接形成 delegation 调用消息，
不通过持久化 proposal slot 或额外模型调用中转。

`Command.PARENT` 是可用的框架交接方式，但不是必须新增的层次。
当前使用 createAgent invoke 返回后的确定性交接适配；不引入 `onHandoff` 回调加中间状态，
不新增外部 `supervisor_tools` ToolNode，也不把 executor 搬入 Supervisor 工具内部。

调用适配不将整份输入重复写入 createAgent state；只读参数绑定在本次调用中，
系统提示词使用原生 `systemPrompt` 配置。内部仅保留详情读取所需的名称集合 reducer，
每次由 Root 的已披露记录初始化；调用结束后将结果合并回 Root。

Root 接纳交接时校验调用与任务、能力、运行身份的一致性，一起提交必要业务更新和执行消息，
再进入现有 `capability` 节点。执行完成时一起提交结果消息与执行事实；
原生恢复不重新派发已经提交的调用。框架 checkpoint 不保证外部副作用恰好一次，
仍需保留已有审核、拒绝、取消和错误处理。

### Middleware 的边界

`SupervisorControlValidation` 只在工具执行前检查响应格式、当前可用工具、控制调用
独占性和参数 schema，不计算计划更新。内部控制工具只确认收到调用并通过
`returnDirect` 结束 createAgent；确认不表示 Root 已接受该业务决定。
完整业务校验与状态推导只发生在两个边界：Supervisor 生成 handoff 时，以及 Root
接收 handoff 时。每个边界只计算一次，复用该结果装配消息或提交状态；不新增中转状态。

`ToolProtocol` 只整理模型输入中的工具调用配对，不改写 Root 或私有历史，也不处理
Announce。历史 Announce 的数据投影仅保留在 Entry Answer 和 Supervisor 读取 Root
历史的位置；当前 Capability 执行使用真实工具消息对，不加载这层旧消息转换。
详情披露状态、公共 system prompt、Capability 的压缩／轮数限制／工具审批职责不变。

### lane 归属不变

| 消息 | 可见范围 |
| --- | --- |
| 用户消息、主会话回复 | 原主会话 |
| delegation 调用与结果 | 替代原来交给主会话的 Announce，作为主会话执行记录；来源 Capability 用 metadata 表示 |
| Capability 内部执行消息 | 原 `capability:*` 私有 lane，不随结果一起公开 |
| Supervisor 内部控制、确认及查询消息 | Supervisor 工作上下文，不因迁入 Root 就变成主会话消息 |

Supervisor 工作消息已迁入 Root，使用 `supervisor` lane。
[查询器](../../../packages/pet-agent/src/agent/messages/query.ts)按本轮 runId 精确选择工作历史，
与主会话执行记录共同组成 Supervisor 模型上下文；不扩大 Capability 私有历史可见范围。
压缩主会话时保留未完成计划任务的实际调用及结果，也保留原私有 lane 记录。

每组调用与结果一起选入模型上下文。失败遗留的半组消息沿用
[工具协议安全过滤](../../../packages/pet-agent/src/agent/messages/protocol.ts)处理输入；
不删除原 checkpoint 事实、不补造成功结果，也不据此改变入口。

## 现有字段与实现如何收敛

以下字段已完成读写迁移。旧类型或 Announce 解析若仍用于历史读取、测试和报告，
不代表它们仍是运行状态通道。

| 当前结构 | 处置 |
| --- | --- |
| `taskActiveDelegation` | 删除独立容器；必要任务进度归入计划，执行身份/交付引用由调用与事实记录表达 |
| `taskRunContinuation` | 删除；snapshot 就是保存的业务状态，不另设生命周期 |
| `runSupervisorSession.plan` | 归入 `runSupervisorState.plan`，不保留两份计划 |
| `runSupervisorSession.messages` | 迁入 Root 消息存储，保持工作归属并按新 run 重置工作视图 |
| `runSupervisorSession.pendingCall` | 删除；实际执行消息与 checkpoint 表达调用现场 |
| 计划中的 `executing` / `returned` | 删除；计划只记录验收/替换决定，执行进度读取最新工具调用及结果；Host 仍可投影为 active |
| `sessionDelegationResults` | 删除重复交付存储；从 Root 的实际配对 ToolMessage 读取 |
| Root 的 `taskPauseInterrupt` | 删除重复路由标志；读取本轮工具结果的 paused，原生暂停节点与 Capability 内部暂停协议保留 |
| `RunSupervisorDispatch.root` | 删除整份状态副本；Entry 将路由消息提交 Root 后直接跳转，Supervisor 读取统一 Root state |
| `runSupervisorReply` | 删除正文中转槽；Answer 从本轮已提交的 Supervisor 消息发布回复 |
| `prepare` 的 reset 兜底、空预算节点 | 删除；新 run 统一由输入 builder 初始化，预算在 Supervisor 入口统一检查 |
| `supervisorCommand` / 草案中的 `proposal` 字段 | 不再作为持久交接槽；内部控制消息及 handoff AIMessage 表达决定 |
| `runNextDelegation` / 草案中的 `nextAttempt` | 收敛到本次调用参数与必要业务事实，删除可推导的重复状态 |
| 草案中的 `lastOutcome`、嵌套 `run` | 不引入；复用原消息、运行身份、预算及出口 |
| 模型侧第四个 `delegate_capability` 工具与派发回跳 | 移除额外模型轮次；保留执行调用/结果契约，由 Supervisor 退出边界派生调用 |
| 非原生 `resume_active` 入口旁路 | 删除；经 Entry Answer 的 `continue` 进入正常调度 |
| 进度投影、回复/错误出口、暂停、授权与产物字段 | 保留必要语义与唯一来源，不顺带重做 Host、资源存储或错误系统 |

#795 基线使用 proposal slot、独立工作消息、pending call 和额外 delegation 模型轮次；
当前从刚完成的内部工具消息对读取决定，派生实际调用，由 Root 校验并与计划更新一起提交。
主要接入位置：
[控制协议](../../../packages/pet-agent/src/agent/orchestrator/runSupervisor/protocol.ts)、
[消息交接](../../../packages/pet-agent/src/agent/orchestrator/runSupervisor/messageHandoff.ts)、
[Supervisor agent](../../../packages/pet-agent/src/agent/orchestrator/runSupervisor/agent.ts)、
[Root 适配](../../../packages/pet-agent/src/agent/orchestrator/runtime/nodes/runSupervisor.ts)、
[Capability 节点](../../../packages/pet-agent/src/agent/orchestrator/runtime/nodes/capability.ts)、
[状态定义](../../../packages/pet-agent/src/agent/orchestrator/state.ts)。

## LangChain 参考

2026-09-11 查阅的官方 TypeScript 文档与源码。以下是参考方法，不是本仓库已通过验证的证据；
上游源码链接为 main，接入时需核对安装版本。

| 参考 | 借鉴内容与边界 |
| --- | --- |
| [Handoffs：Multiple agent subgraphs](https://docs.langchain.com/oss/javascript/langchain/multi-agent/handoffs#multiple-agent-subgraphs) | 使用 `Command.PARENT` 和配对确认传递控制权；借鉴交接语义与上下文选择，不照搬其路由状态 |
| [Supervisor handoff.ts](https://github.com/langchain-ai/langgraphjs/blob/main/libs/langgraph-supervisor/src/handoff.ts) | `createHandoffBackMessages()` 由程序生成工具调用/结果，说明交接记录不必再经模型生成；该 helper 属内部用途，不直接依赖 |
| [Deep Agents subagents.ts](https://github.com/langchain-ai/deepagentsjs/blob/main/libs/deepagents/src/middleware/subagents.ts) | `task` 工具 invoke subagent 并用 ToolMessage 返回交付；借鉴结果边界，不照搬其工具内执行拓扑 |

官方交接确认只表示控制转移，不能当作我们的 Capability 执行结果。
没有现成组件直接完成本项目三个控制工具到 delegation 调用的业务转换；
在现有 Supervisor 边界适配即可，不引入整套 `createSupervisor` 或新的交接框架。

## 验证与范围

验证以下行为，不通过比较提示词字面文本来验收：

- 两组消息分别正确配对，原始控制调用不被改写；Root 直接接收执行调用，无额外模型派发轮次。
- 新 run 重置 Supervisor 工作视图，但 Entry Answer 仍能参考业务状态和主会话结果；
  原生 interrupt 保留原身份、预算与调用现场。
- A 已验收、B 待执行时能够继续或调整，不依赖独立 active delegation，不重复验收或提交计划。
- 主会话执行记录、Supervisor 工作消息、Capability 私有消息的可见边界正确，
  不自动继承旧 run 私有现场，不生成 Announce XML。
- 交接提交、执行前后 checkpoint、审核拒绝、暂停、取消、失败及无执行分支正确；
  不丢已提交进度、不重放已提交调用、不恢复旧授权。
- executor 的 briefing、Toolkit 生命周期、交付与验收分离、产物身份和原生流式输出保持正常；
  检查模型轮数、attempt 预算和图步数，避免额外路由耗尽递归限制。
- Capability 返回不改业务计划；缺失交付返回错误 ToolMessage 后可由 Supervisor 重试，
  最新失败不能被旧成功结果掩盖，授权与产物事实仍独立提交。
- 旧会话可读；旧拓扑挂起运行明确报告不兼容，不静默迁移或重跑副作用。

[新的消息交接测试](../../../packages/pet-agent/src/agent/orchestrator/runSupervisor/messageHandoff.test.ts)
覆盖控制校验、两组配对和计划推进；
[生产图调用与恢复测试](../../../packages/pet-agent/src/agent/orchestrator/runSupervisor/handoff.test.ts)
使用真实 createAgent、Root 图与 Capability executor，覆盖无额外模型派发、
原生 interrupt、执行前后 checkpoint、跨 run 的 Entry `continue` 和工作 lane 隔离。
脚本模型测试不等同于真实模型 eval；两者的验证结果分别记录。

### 本次验证记录（2026-09-11）

| 验证 | 结果 |
| --- | --- |
| pet-agent 全量单元与集成测试 | 498 / 498 通过，包含真实 createAgent、生产 Root 图、无交付重试、最新结果验收、Entry 交接/调用 ID 隔离、消息回复发布、统一错误出口与原生恢复预算测试 |
| pet-agent 源码与 eval 类型检查、本地端类型检查 | 通过 |
| 本地端全量测试 | 620 通过、5 跳过；端口及子进程测试在沙箱外执行 |
| Host 计划投影与事件 | 纳入本次本地端全量测试，执行进度从消息推导，保留 completed/pending/active 展示语义 |
| 前一轮默认模型 `qwen3.8-max` 决策 eval | Boundary 9、计划调整 4、详情查询 7 个场景均取得通过结果；包含失败场景修正后的定向复跑，不是单次零失败运行；本次状态清理未重跑真实模型 eval |

真实模型 eval 只使用合成任务和执行证据，不执行业务工具，关闭远程 tracing。
它验证调度语义，不替代生产图的 checkpoint、授权或副作用测试。
本轮发现并修正了 `reply` 被误当成进度通知、详情读取被误当成执行前置步骤，
以及“暂缓验收并提问”被校验错误拦截的问题。提问用例按“不派发、不改计划”
验收，允许自然回复和等价的控制工具回复，不通过限定某一种表达形式来判定成败。

本次不新增并行调度、独立存储、快照采用协议或外部工具节点层，不涉及已暂停的 macOS companion。
旧交接协议已从当前文档中移除，历史内容可通过 Git 查看。
[合并时设计](https://github.com/pinpawo/pinpawo-agent/blob/b8b43353969aa3c4dd9e87db620f79a5b3dd6cca/docs/design/agent-runtime/run-scoped-supervisor-session.md)
记录 #795 基线；当前重构方向以本文为准。
