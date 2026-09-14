# Root、Supervisor 与 Capability 的状态与交接

状态：已接入运行图；本文为待 review 的工作设计稿，未落实的调整单列在“遗留项”。
更新于 2026-09-14；早期实现来源为 [PR #798](https://github.com/pinpawo/pinpawo-agent/pull/798)
及 [PR #799](https://github.com/pinpawo/pinpawo-agent/pull/799) 的提示职责与自主调整改动。

Root 状态、Entry `continue`、Supervisor 消息交接、Capability 执行及 Host 计划投影已统一接入。
不再保留独立 active delegation、continuation、pending call 或下一次执行临时槽。

## 核心结构

Root 承载会话、整体执行流程和 checkpoint。Supervisor 在这个流程中负责规划、验收和
调度，工作上下文是 run-scope。Capability executor 独立负责具体执行。

设计方向是让模型决定如何完成任务，让程序维护权限、消息协议、状态提交和恢复等
执行约束。Supervisor 在任务执行返回后检查方向与结果，不接管 executor 内每一次
工具选择；executor 可以在任务和授权范围内自主探索。保持这一边界，不以增加
持久子代理、调度状态或模型回跳作为优化目标。

**Supervisor 保留计划与验收调用及其确认；委派由 Supervisor 的同一次 delegate_capability
调用交给 Root 执行，Root 返回配对的实际结果。委派的局部确认不保留，不生成第二次调用，
也不增加中间 proposal 状态。**

| 部分 | 职责 |
| --- | --- |
| Root | 保存状态与消息，落实调度更新，执行节点路由，管理入口、checkpoint、暂停、失败和回复发布 |
| Entry Answer | 非原生恢复运行的入口，结合用户输入与已有状态，回答、发起规划或继续工作 |
| Supervisor | 使用 createAgent，依据整体状态决定计划、验收和后续执行；不在内部执行 Capability |
| Capability 工具执行 | 对 Root 表现为一次 `delegate_capability` tool call，由 `capability` 节点承载执行；工具内部复用独立 executor，不验收自身结果、不决定下一任务 |

工具调用是对外边界，executor 是内部实现：一次调用内部仍完成
briefing → Toolkit 绑定 → createAgent 执行 → finalize → 交付，再返回对应 ToolMessage。
这些步骤不是 Root 上的多次工具调用，也不需要因工具化拆掉原 executor 封装。

Subagent 返回本次执行的 `output` 文本（无交付时为 `null`）、私有消息和产物；
finalize 可以直接替换 `output`，不必向私有历史追加一条消息再通过消息 ID 查找交付。
executor 将 output 包装为交付事实，由 Root 写入配对的 ToolMessage；交付引用与
私有消息 ID 不耦合。不再生成 Announce，不保留 `announceMessageId` 交付选择接口。
Subagent 只从本次新增的有效回复提取 output，不能把旧回复、工具调用或预算停止提示
当作本次交付；是否完成任务仍由 Supervisor 验收。

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
或嵌套 `run` 容器。调用参数与已有事实能够推导的当前状态，不重复放进 state；派发时的任务与执行身份作为
消息内部元数据保存，防止后续计划调整改变历史执行含义。

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
自然回复读取正文，不另存 `runSupervisorReply`。
入口、压缩、执行和暂停节点的普通异常统一记录 Root 终止错误；原生 interrupt
和取消不转换成普通失败。回复消息统一标记 runId 与 traceId。

**原生 interrupt 按原生机制恢复；其他情况一律先经过 Entry Answer。**

| 入口 | 处理 |
| --- | --- |
| 原生 interrupt | 恢复原 checkpoint、run、delegation 与调用现场，不重置工作上下文和预算 |
| 其他运行 | 新 run，经 Entry Answer；参考保存的业务状态与可见结果，不自动重放旧调用或恢复旧执行实例 |

Entry Answer 使用 `plan_request` 发起规划，使用 `continue` 表达继续未完成工作：

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

本次调整依据 [Studio E2E #803](https://github.com/pinpawo/pinpawo-agent/issues/803)：
验收与下一步行动分离，由 Supervisor 模型在工具结果返回后继续决定。

| 工具 | 含义与返回 |
| --- | --- |
| `submit_plan` | 建立计划，返回计划事实；不派发执行 |
| `review_current` | 验收当前交付或记录需要补做，返回更新后的计划；不要求 reply，不派发执行 |
| `adjust_plan` | 调整未完成计划并保留已完成进度，返回计划事实；不派发执行 |
| `delegate_capability` | 模型无参数地决定执行当前计划项；运行时注入 briefing 并交接给 Root |
| `capability_details` | 返回能力详情，继续模型循环 |

控制工具均不使用 `returnDirect`。模型可以连续调整、验收，之后选择执行、提问或
自然回复。只有 `delegate_capability` 的成功工具回执才结束 Supervisor 循环并交接给 Root；
错误回执继续返回模型，不能因工具名称是执行工具而提前结束。

Supervisor 优先沿用适用的现有计划，非必要不重排。补做要求通过 `review_current(false)` 记录，随本次委派自动注入 briefing；只有新要求
或具体证据表明原安排不适用、能力选错或存在遗漏时，才决定最小调整。`adjust_plan.tasks`
只列剩余工作，运行时自动保留已完成事项。保留当前能力和交付身份使用 continue；replace
不携带旧交付作为新任务的验收依据。这是模型职责与工具语义，不新增强制路由或重排次数限制。

工具自身校验参数，`wrapToolCall` 把框架抛出的参数解析错误转换为匹配 call ID 的
`status: error` ToolMessage，保留详细校验信息；不在 `afterModel` 重复校验或手动跳转。
SDK 已识别名称和 ID、但 JSON 参数无法解析的调用，保留原始参数进入同一工具错误
回执路径，不执行工具，不猜测或补全参数。缺少调用身份或非 AIMessage 仍视为协议错误。
连续错误由原有 recursionLimit 截断，不在 middleware 内另起无限重试循环。
未知或本轮未提供的工具使用框架原生错误回执（含可用工具名），让模型沿正常工具循环
在同轮修正。错误调用不执行工具、不提交计划或派发 Capability；成功调用仍按原有
schema 与业务约束校验。无交付验收、非法能力等可纠正的决策错误也返回错误回执和当前计划，
让模型继续判断；成功的前序控制仍参与最终提交。纠错遵守调用方 recursionLimit，取消、
中断、缺失执行身份与协议完整性错误继续传播。
没有待执行任务不构成失败，也不自动生成答案；Supervisor 通过普通 AIMessage 回复。

### 工具状态与 Root 提交

每次 Supervisor invoke 从 Root 的计划与执行事实开始。内部工具按本次已完成的控制调用
顺序推导当前计划，在 ToolMessage 中返回计划事实供模型决策。工具不直接修改外部资源，
不创建独立的持久 Supervisor state/proposal/nextExecution 槽。

invoke 结束时，Root 验证并按顺序应用本次已完成的控制调用。无论模型最终选择执行还是
自然回复，都提交计划更新与工作消息。执行时将 Supervisor 的 `delegate_capability`
请求交接为主会话记录，保持空参数并规范化调用 ID；briefing 放入运行时执行快照，不创建第二条
调用。执行快照写入内部元数据，Capability 仍在 Root 节点执行并返回实际结果。

```text
Supervisor: review_current → ToolMessage(更新后的计划)
          → 模型继续判断
          → 自然回复，或调整计划后继续判断，或 delegate_capability
Root:      验证控制记录，提交计划 + 消息
          → answer，或执行明确交接的 Capability
```

业务更新只能从匹配、成功的控制工具消息推导；不接受模型伪造的执行身份或 ToolMessage。
工具执行时和 Root 接收时复用同一纯转换函数。每条控制 ID 在本 run 只接纳一次。
非法能力、无交付验收、未返回的重复执行等仍属于状态一致性检查；下一步做什么由模型决定。
单次模型响应中的控制调用保持顺序明确，避免并行修改同一计划。

### 生命周期与恢复

计划事实仍只有 goal/plan；执行身份与结果仍保存在 Root 工具消息对。
在 Supervisor invoke 返回前发生取消或异常，不提交部分内存状态，也不会执行 Capability。
Root 提交后沿用现有 checkpoint / Capability interrupt 恢复，不重放已提交的执行副作用。
delegation 交接只接受 delegate_capability 协议，回复只读取 Supervisor 的自然 AIMessage。
不为旧 review.reply 或旧 delegation 参数增加兼容读取；协议变化不承诺恢复旧 checkpoint。
当前协议内的原生 interrupt、checkpoint 恢复和执行去重继续保留。

### 提示与校验

System prompt 表达目标、权限、验收原则；工具说明表达各自效果。删除“review 同时选择
后续执行或提供 reply”的耦合约定。不增加“最后一项必须提供 reply”的例外校验。
Middleware 检查调用协议与 schema；工具返回真实状态，供下一轮模型判断。

### 验收

- review 最后一项后模型自然回复：计划完成、一个最终主会话回复、Capability 不再执行。
- submit/adjust/review 后均能再次调用模型；仅 delegate_capability 产生 delegation。
- review 后继续执行、调整后执行、仍有 pending 任务时提问，均保持正确状态。
- 多次工具调用的状态一致，Root 防篡改/去重与原生恢复保持有效。

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

交付、验收和 run 结束均不主动清空 Capability lane。留存记录不会扩大模型可见范围：
同一 run 的同一 delegation 可继续读取，其他 delegation 和新 run 仍按精确作用域隔离。
Subagent 自身摘要产生的私有消息替换仍需同步，避免下次执行重新带回已压缩的旧上下文；
这不是交付后的整 lane 删除。长期留存会增加 checkpoint 存储、序列化及扫描成本，
若后续需要清理，应另定历史保留策略，不混入交付协议。

每组调用与结果一起选入模型上下文。失败遗留的半组消息沿用
[工具协议安全过滤](../../../packages/pet-agent/src/agent/messages/protocol.ts)处理输入；
不删除原 checkpoint 事实、不补造成功结果，也不据此改变入口。

## 实现入口


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
没有现成组件直接完成本项目计划验收与单次委派请求的状态提交、执行快照校验；
在现有 Supervisor 边界适配即可，不引入整套 `createSupervisor` 或新的交接框架。

## 验证与范围

验证以下行为，不通过比较提示词字面文本来验收：

- 计划/验收记录配对，委派仅有一次请求与实际结果；模型参数保持不变，调用 ID 按 run 规范化，无额外 Root 模型派发轮次。
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
- 当前拓扑内恢复正确；不要求跨协议或跨拓扑兼容旧 checkpoint，不静默迁移或重跑副作用。

[新的消息交接测试](../../../packages/pet-agent/src/agent/orchestrator/runSupervisor/messageHandoff.test.ts)
覆盖控制校验、单次委派配对和计划推进；
[生产图调用与恢复测试](../../../packages/pet-agent/src/agent/orchestrator/runSupervisor/handoff.test.ts)
使用真实 createAgent、Root 图与 Capability executor，覆盖显式执行后的直接交接、
原生 interrupt、执行前后 checkpoint、跨 run 的 Entry `continue` 和工作 lane 隔离。
脚本模型测试不等同于真实模型 eval；两者的验证结果分别记录。

真实模型 eval 使用合成任务和执行证据，不执行业务工具，关闭远程 tracing。
它验证调度语义，不替代 checkpoint、授权或副作用测试。提问用例按“不派发、不改计划”
验收，使用自然回复，允许提问前记录不改变计划的验收判断。

本文不设计并行调度、独立存储、快照采用协议或额外外部工具节点层。
已完成迁移清单、旧协议和阶段性测试结果不再内嵌，见
[历史版本](https://github.com/pinpawo/pinpawo-agent/blob/c6f55ee196f00849fe8b9565eaa5bb4aaa6444cf/docs/design/agent-runtime/run-scoped-supervisor-session.md)。

## 遗留项（2026-09-12 核对）

以下是当前实现与上述简化方向的差距，不表示这些行为已修改。

| 项目 | 当前事实与整理方向 |
| --- | --- |
| 上下文标签不准确 | [输入构造](../../../packages/pet-agent/src/agent/orchestrator/prompts/runSupervisorAgent.ts)的 `remaining_plan` 实际传入整份计划，含 completed/superseded。应明确它是完整计划，而不是再增加一份过滤后的持久状态。 |
| Review 框架兼容代码 | [Toolkit Review](../../../packages/pet-agent/src/agent/orchestrator/toolkitReviewMiddleware.ts)为 #749 / langgraphjs#2667 读取私有 scratchpad，避免嵌套 interrupt 恢复时重复全局审核。删除前需在实际安装版本上复现并验证原生恢复；不能仅因标记 temporary 就删除。 |
| 已废弃授权类型仍在使用 | [globalReviewPolicy.ts](../../../packages/pet-agent/src/agent/orchestrator/review/globalReviewPolicy.ts)仍导出 `BuiltinGlobalReviewPolicyMode` 别名，local-agent 有实际消费者。可逐步改用 agent-contracts 的 `ToolAuthorizationMode`，不能只删除 pet-agent 导出。 |

历史 Announce 读取、工具协议输入过滤和 Capability 私有消息留存不是待删除的运行状态。
它们分别承担旧会话读取、模型输入配对安全和隔离历史保存；是否淘汰历史兼容或缩短
留存周期应单独决定，不混入 Supervisor 调度重构。


## 后续草案：将回复发布合并到 Root 提交（未实施）

2026-09-14，基于 PR #804 的 review 继续讨论。以下为下一次独立改动的建议，不描述当前运行行为。

### 当前事实

- `answer` 不调用模型；它从已提交的 Supervisor 工作消息读取回复，生成主会话 AIMessage，补齐消息时间与 run/trace，清理终止标志。
- `runSupervisor` 先提交计划和工作消息，再路由到 `answer` 发布；因此正常回复经过两个 Root 提交步骤。
- 迭代预算停止和 `checkpoint_incompatible` 也走 `answer`；普通异常仍由 `runTermination` 记录并重新抛出。
- `entryAnswer` 已能直接写主会话回复并结束，不应与末端 `answer` 混为一谈。
- Host 原始流适配会隐藏 `runSupervisor` 命名空间，并通过 `answer` 节点名识别主回复；root values 与最终 checkpoint 另行提供已提交的主会话消息。

证据：[answer](../../../packages/pet-agent/src/agent/orchestrator/runtime/nodes/answer.ts)、
[Supervisor Root 节点](../../../packages/pet-agent/src/agent/orchestrator/runtime/nodes/runSupervisor.ts)、
[运行终止](../../../packages/pet-agent/src/agent/orchestrator/runtime/runTermination.ts)、
[Host 流适配](../../../services/local-agent/src/events/rootStreamEventAdapter.ts)、
[会话发布](../../../services/local-agent/src/chatSessionAdapter.ts)。

### 建议职责与提交方式

提取无模型调用的回复发布函数，接收明确的回复文本和当前运行身份，返回主会话消息及必要的收尾更新。该函数不判断任务完成、不选择下一步、不重写模型文本、不引入独立 reply/pending 状态字段。

Supervisor 返回自然回复时，Root 使用已经验收的结果，在一次更新中提交计划、Supervisor 工作消息和主会话回复，然后进入 END。用户提问同样是合法回复，保留 pending 计划；是否回复不要求计划全部完成。`delegate_capability` 的成功回执结束 Supervisor 循环并进入 Capability，执行分支不调用回复发布函数。

运行停止原因由程序单独格式化：迭代预算停止及 checkpoint 不兼容时，复用发布函数输出运行状态并结束；真正异常保持原来的失败通道。保留 Entry 的职责，必要时复用消息构造函数，但不在本次重构中改变 Entry 的决策或提示机制。

### Host 与消息可见性

不能简单地把整个 runSupervisor 节点列为用户可见，否则内部模型的中间文本会成为聊天内容。正式回复以 Root 已提交的当前 run 主会话消息为依据，按消息身份去重；Supervisor/Capability 的私有工作继续保持隔离。

优先复用现有 main lane、runId、traceId 和 messageId。先用真实协议流验证节点状态写入时携带哪些消息字段；若 messages 事件不足以可靠判断归属，就从 root values/最终 checkpoint 提取已提交的主回复。不要为识别最终回复新增另一份持久业务状态，也不要通过比较文本内容代替消息身份。

2026-09-14 隔离实验：同一段已提交回复，经独立 answer 节点时适配器输出一条 assistant.delta；改为由 runSupervisor 同时提交后，最终 root values 中仍有正确的主回复，但 assistant.delta 为零。两种情况下均未泄露内部模型文本。现有 Host 流适配 9 项测试通过；这说明需要补充新发布路径的事件测试，不能只依据现有测试为绿判断可直接删节点。

验收时须同时检查 message.delta 与 message.completed 的 messageId 和文本一致，不能只验证最终 checkpoint 有一条 AIMessage。此重构不承诺让 Supervisor 内部文本实时对用户输出。

### checkpoint 范围

按用户 2026-09-14 的明确决定，后续重构直接移除 answer 节点及其路由，不保留旧 checkpoint 专用入口、旧 schema、迁移分支或支持窗口。跨协议或图拓扑的旧 checkpoint 恢复不作为设计约束。

新拓扑内部仍验证原生暂停恢复、消息只发布一次和执行不重复；不能以兼容旧数据为由静默重跑可能已有副作用的工作。

### 实施与验收顺序

1. 提取发布/停止格式化函数，验证文本、身份和收尾状态；保持现有图行为。
2. 在真实 Root 协议流下验证 Host 对已提交主回复的识别与去重，同时排除内部模型文本和工作消息。
3. 将正常回复和运行停止改为提交后直接 END，删除 answer 节点及其路由。
4. 覆盖自然回复、保留 pending 的提问、执行交接不发最终答复、当前拓扑内的 checkpoint 恢复、重复恢复不重复发布、预算停止、不兼容 checkpoint 和普通异常。

收益是减少正常回复的一次图节点调度和一次状态提交，并统一回复发布责任；当前 answer 没有模型调用，因此不宣称节省一次模型调用或实现新的 token 流式能力。

## Supervisor 单一委派交接（2026-09-14 实施草案）

此前三个计划/验收工具均可能立即派发，Root 因而保存 `{ control, execution }` 包装。
执行已从这些工具拆出后，该包装不再表示多种执行来源。本次将 `execute_current` 合并为
Supervisor 的 `delegate_capability`，由同一次模型工具调用交接 Root；不再生成第二次
同义的 Root 工具调用，不保留旧工具别名或旧 checkpoint 参数兼容。

模型调用参数为 `{}`。规划和调整工具的 task 承载完整执行说明与预期交付，运行时
从已确认计划组装 briefing。Capability、taskId、delegationId、initial/continue 同样由
运行时确定，不让模型在委派时重新编写另一份任务。

计划和验收工具仍返回事实供模型继续决策。delegate_capability 校验成功后结束本次
Supervisor 循环，Root 一次提交更新后的计划和该委派请求，再进入 Capability 节点。
局部交接确认不进入长期历史；实际执行结果使用同一条已规范化的工具调用 id 返回。
保留 run 范围的 id 规范化，避免不同 run 的模型 call id 复用碰撞。

执行快照只存于规范委派消息的运行时元数据，包含任务身份、能力、当时任务内容、
delegation 身份、执行模式与 briefing；执行正文只从此快照读取。主会话保留一组
请求/实际结果，当前与历史调用参数均为 `{}`，不向模型工具参数注入内部数据。原始模型调用 id 作为
来源关联保留。Root 仍从 Supervisor 决策序列重算计划和执行快照并校验交接，避免提交
被改写、重复或未授权的执行；不增加另一份 pending/dispatch 状态。

执行历史读取、暂停恢复和上下文压缩都从该元数据取快照，不能用现有计划反推旧任务。
Host 的 readCapabilityExecutions 返回结构保持稳定，继续供计划进度和交付展示使用。
回归覆盖单次派发、错误自纠、验收、continue/replace、新 run、重复调用 id、篡改、
暂停恢复、压缩保留、Host 投影及 Studio 工作→反馈能力交接。旧协议 checkpoint 不迁移。

### 从计划注入 briefing（2026-09-15，替代模型编写正文）

模型只调用 `delegate_capability({})`，主会话保存的调用也保持空参数。工具通过 LangChain
注入的 `ToolRuntime.state.messages` 读取本次已确认控制序列，结合 Root 输入推导当前
计划并构建执行快照。快照中的 `briefing: string` 正文为
格式化 JSON：当前 `task`、按执行顺序排列的 `plan`（capability/task/status），以及本次
Supervisor invoke 中 `review_current(false)` 的 `feedback`（若有）。其他计划项仅供
上下文参考，本次只执行当前任务。验收通过或重新规划后清除本次补做意见。

同一个控制序列确定计划、执行快照和 briefing；Root 重放校验时重新组装并比对正文，
拒绝篡改。不增加模型调用、第二条委派请求或独立的待提交状态。交接过程不改写
AIMessage 的 args；模型输入与历史调用共享空参数 schema，briefing 属于内部执行快照。
旧的自由 briefing 参数会返回参数错误供模型纠正。

完整说明在 submit_plan/adjust_plan 时确定，因此 task 不再使用 2000 字符上限，保留
首尾空白、缩进与换行，仅拒绝全空白内容。内部临时 HumanMessage 仍可用 XML 分隔
目标、当前任务与 briefing，安全转义且不持久化到 Capability 私有历史。执行身份只读取
元数据，不从正文解析。用户暂停恢复 guidance 属于独立用户输入协议，保持不变。

验收主要依赖 Capability 返回的结果。模型在存在实质偏差、明显缺项或自相矛盾时才
要求补做；不因措辞、格式或一般性改进反复执行，不增加逐项取证工具或强制核查流程。
运行时只保留任务归属等基本一致性检查，不代替模型判断交付质量。

Capability 同时读取主会话中的前项实际交付，后续任务可以直接引用已有结果；无需仅为
传递结果而将整段交付复制进 task 或调整计划。该可见性通过跨任务执行回归验证。
