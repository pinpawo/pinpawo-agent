# Supervisor 与 root 交互协议

状态：issue #755 的设计草案，按 2026-09-06 讨论的方向整体重写。本文描述目标设计；实现进度见文末。

[English version](delegation-boundary-protocol.md)。中英文描述同一套设计。文件路径沿用原名，避免已有链接失效。

## 要解决的问题

Supervisor 应当是 root 编排循环中的决策者：Entry 根据 goal 建立执行计划；后续每次被调用时，只从 root 当前 main messages 读取对话和执行证据，判断结果是否对齐既定 goal 和当前任务，应该采纳推进还是继续完善。Capability subagent 正常返回的结果先作为现有 Announce 消息进入 main，无需等到验收。root 负责落实决定并记录新的事实。Supervisor 不因新的执行结果而自行改变目标或重写计划；需要变更时直接询问用户。

需要统一的是这套交互分工。此前结果标记、控制命令、root 路由和最终回复逻辑都承担了一部分完成判断，导致相同问题在多处被重复处理。单独删掉 `completionReason`，或者增加一个结束命令，都不足以解决这个问题。

这次设计以一轮完整交互为主线：**root 提供当前上下文 → Supervisor 判断 → 返回决定或回复 → root 落实 → 执行产生新事实 → 下一次判断。** `completionReason`、Announce、`returnDirect` 和状态清理都围绕这条主线安排。

## 交互中的分工

| 组件 | 负责什么 |
| --- | --- |
| root Orchestrator | 持有正式消息历史、goal、活动 delegation 和编排状态；提供每轮输入，校验并落实决定，执行派发与收尾 |
| Supervisor | Entry 下建立实现 goal 的计划；Boundary 下检查执行结果与 goal、既定任务是否对齐，采纳并按计划推进，或让同一个 delegation 继续完善；需要条件或计划变更时直接问用户 |
| Capability | 执行委派任务，处理自身工具反馈，产出可供判断的结果 |
| 用户 | 补充所需条件，决定是否改变 goal 或计划；运行因架构或未处理异常停止后，决定后续动作 |

Supervisor 每次重新读取 root 的当前上下文，但当前事实变化不意味着执行约定随之变化。goal、Entry 准备好的 Capability 披露和提交后的计划按 `RUN-STABLE` 理解；执行期间变化的是结果证据和任务进度。它不维护另一份独立主对话，也不在后台持续监听 Capability 内部每次工具调用。

计划稳定指任务内容、范围和顺序不由 Supervisor 自行增删或改排。验收当前任务、派发既定下一项、缩短剩余项，是执行进度变化，不是修改计划；不为这一区分增加第二份计划或新的状态协议。若需要改变计划，Supervisor 说明原因和建议，先询问用户；用户确认后，后续调用才落实变更。首次根据用户 goal 建立计划不要求额外增加一次审批。

文中的“采纳”指 Supervisor 判断**当前 delegation 的任务已经满足要求**，对应现有的验收效果。Supervisor 可以综合多次尝试的结果作判断；这里不增加逐条选择消息、部分验收或按 Announce 分配完成状态的协议。

## 一轮完整交互

```text
root 当前上下文 + goal
  → Supervisor / Entry：怎样实现这次 goal？
  → root 落实返回的决定
  → Capability 执行当前 delegation
  → root 将结果作为 Announce 写入 main messages
  → Supervisor / Boundary：可以采纳并推进，还是继续完善？
  → root 派发下一项、继续当前任务，或输出回复结束本轮
```

这里的循环是 root 的编排循环。Supervisor 内部可以为了了解 Capability 多次调用探索工具，Capability 内部也有自己的模型和工具循环；它们并不每一步都触发一次新的 root 决策。

### root 每次提供什么

每次调用都从 root 当前状态构造输入，而不是重放上一次 Supervisor 的原始对话。

| 输入 | Entry | Boundary |
| --- | --- | --- |
| root 当前主对话：用户上下文、普通回复、Announce 执行事实（包括尚未验收的结果） | 有 | 有 |
| 本次 goal | 有 | 有 |
| 可用 Capability 信息及已披露的文档 | 建立计划前可按需探索 | 执行循环中复用已准备的信息；新 run 收到用户补充时，可在恢复执行前按确认的调整准备所需信息 |
| 尚未执行的计划 | 新任务可为空；恢复时沿用已有计划，除非用户已确认变更 | 有，用于核对当前进度和既定下一项 |
| 当前 delegation 的身份和任务 | 无活动 delegation | 有，用于关联 main 中的结果；不另外传结果正文 |

“看着 root messages”指读取 `root.messages` 的主对话投影。当前存储中还可能包含私有通道，不能直接把原始数组全部交给 Supervisor。main 是对话与执行证据的唯一输入通路；goal、固定计划和当前 delegation 关联仍是 root 持有的编排状态。Boundary 不再读取 Capability 私有范围，也不再附带 `announceAttempts` 或另一份结果正文。

Supervisor 的探索、工具调用和中间文本只属于本次调用；Capability 的私有 Human/AI/Tool 历史留在自身委派范围。跨界传递的是任务事实和结果证据。

### Entry：怎样实现 goal

Supervisor 结合用户目标、已有成果和可用 Capability，决定接下来实际需要做什么。已有事实可以减少需要执行的工作，不必从头重复。

有可执行工作时，提交有序计划，root 派发第一项并保存剩余项。缺少必须由用户提供的信息，或当前应直接作答时，Supervisor 返回完整自然回复，root 结束本轮。

Entry 没有活动 delegation，因此不发生验收或继续当前任务。显式恢复时若只有剩余计划而没有活动 delegation，仍使用 Entry，读取最新上下文后沿既定计划继续。恢复本身不授权重新规划；发现计划已不可执行时先问用户。

如果 Entry 在尚未提交计划、也没有活动 delegation 时直接提问，问题留在 main。用户回答后沿普通对话进入 `entryAnswer`，由它结合 main 上下文确定本次 goal，再交给 Supervisor；不为尚未建立的执行工作制造 `resume_active` 或挂起状态。

### Boundary：采纳推进，还是继续完善

Capability 正常返回结果后，root 先写入 main，再调用 Supervisor。Supervisor 按 Announce 已有的 `delegationId`、`runId`、`announceMessageId` 及消息顺序识别当前任务的多次结果。沿用已有识别属性，无需新增身份字段或消息类型，也不能假定最新结果已经包含之前所有证据。消息到模型的投影应保留这些关联信息。

Supervisor 结合 goal 和 root 当前主对话判断：

- 当前任务已满足要求且与 goal 对齐：采纳结果，按既定计划推进或回复用户。
- 当前任务还缺内容或验证，同一个 delegation 可以补足：继续当前任务，可附带具体反馈。
- 当前执行方向已不适合、需要修改计划：说明偏差和建议，询问用户，不自行替换执行。用户确认后才落实替换，保留旧证据，但不把旧任务标记为完成。
- 当前无法自主推进，需要用户提供条件：直接说明情况，保留未完成任务。

剩余计划用于对照既定安排。Boundary 主要判断 Capability 的结果是否满足当前任务、是否服务于 goal；计划遇到阻碍时可以停下来询问，不能把“重新检查”当作自由重写计划的授权。采纳一个 delegation，不等于整个 goal 完成。

## 一个返回边界，两类正常输出

root 图中的 `runSupervisor` 节点基于 main messages 调用 Supervisor agent 并取得决定。调用内工具历史是临时的，正式状态仍由 root 持有。Supervisor 只返回已有的控制提案或 `{ reply }`；发生未处理异常时直接抛出。沿用已有 Capability 披露返回字段传递 Entry 准备的信息，Boundary 保持该执行范围不变。

工具负责表达操作，普通文本负责表达回复。沿用现有三个控制工具即可：

| 返回方式 | 适用时机 | root 落实的效果 |
| --- | --- | --- |
| `submit_plan({ tasks })` | Entry 建立或恢复计划 | 无活动 delegation 时提交计划并派发第一项；不承担验收 |
| `continue_current({ feedback?, remainingPlan? })` | Boundary 中当前任务还需完善，或收到用户补充后继续 | 保留同一个 delegation、任务和私有历史，携带反馈继续；默认保留后续计划，用户确认修改时可同时更新后续计划 |
| `accept_result({ reply?, remainingPlan? })` | Boundary 验收当前任务 | 记录验收；默认沿既定后续计划推进。提供 reply 时输出回复并结束本轮，保留后续计划；没有后续任务时必须提供最终回复。remainingPlan 省略则保留，提供时仅允许用户确认的调整 |
| 普通最终文本 | Entry 或 Boundary 中直接回复用户 | 原文输出，保留已有未完成任务和剩余计划，不隐式验收或派发 |

三个工具分别表达建立计划、继续当前任务和验收结果。移除 `acceptCurrent`，验收只通过 `accept_result` 表达；root 不根据 Entry/Boundary 自动猜测是否验收。当前任务的用户取消或替换沿已有任务控制入口处理，不隐藏在计划工具的布尔参数中。

沿用这些字段不等于保留模型任意重写计划的权限。正常推进必须对应既定下一项和剩余项；用户确认的调整依据保存在 root 主对话中，不新增审批工具、确认标记或另一套变更协议。root 校验计划推进的结构一致性，Supervisor 根据用户表达判断获准变更的范围。

`continue_current.remainingPlan` 只表示当前 delegation 之后的任务，不包含当前任务。省略时保留原后续计划；提供数组时，以用户确认后的任务列表替换后续计划；提供 `[]` 表示用户确认取消全部后续项。空数组不代表当前 delegation 完成或被取消。root 在同一次状态更新中落实后续计划与继续反馈，随后恢复同一个 delegation，不新增 `update_plan` 工具。

一次 Supervisor 调用最多返回一个控制决定。验收和派发、验收和回复分别由一个提案一起表达，root 一次性落实相关状态变化。探索工具的中间返回不会被误认为最终决定。

### 普通文本与采纳后的回复

普通文本结束的是**本轮运行**，不改变已有任务是否验收。比如“请提供测试账号”会保留当前 delegation；即使文本误写成“已经全部完成”，root 也不会据此验收。

当前任务已经完成、但需要询问独立的下一步时，应使用 `accept_result` 同时提供问题和既定剩余计划。在 Boundary 判断整体目标完成且计划确无剩余项时，同样使用 `accept_result`，并给出空的剩余计划；Entry 无活动任务时，直接自然回复即可。不能用“goal 已完成”的判断跳过尚未完成的计划项；认为这些项可以取消时先问用户。

两条路径最终都由已有 `answer` 节点输出一条 assistant 回复，并完成本轮清理，不再让模型改写或让 root 分类判断正文。与控制调用同时出现的普通文本不构成第二份回复；控制路径以提案为准，用户回复取自 `accept_result.reply`。

`answer` 是当前实现出口。后续统一由 Finalizer node 处理收尾；其职责和实现等 Supervisor 优化完成后再设计，本方案不把现有节点固定为最终架构。

没有控制提案时，适配层只接受最后一条非空、没有工具调用的 AI 文本。空输出或只有工具消息的输出走错误路径，不从旧消息里找一条替代回复。

### Supervisor 直接问用户

缺少条件、执行结果与 goal 不对齐且现有任务无法补足、或建议修改计划时，由 Supervisor 节点直接生成问题，说明需要用户补充或决定什么。当前任务未完成时走普通回复；可采纳当前任务时通过 `accept_result` 一并回复。无需再安排一个模型节点替它组织问题。

最简单的交互是：展示问题并保存未完成工作，用户在该工作的继续入口回答，然后以已有 `resume_active` 语义进入下一次调用。回答进入 root 主对话，Supervisor 按最新输入继续判断；补充条件不等于同意改计划，用户未同意时不能改派。界面应把继续原工作的入口展示出来，不要求用户知道内部命令，也不能把该入口的回答当作 `supersede_active`。

当前 delegation 尚未结束时，用户回答或明确提出的计划调整都作为新的 HumanMessage 加入 main，保留 delegation 身份、私有历史、已有 Announce 和剩余计划，再进入 Supervisor / Boundary。消息到达本身不验收、不结束、不替换当前 delegation，也不先清空状态转去重新规划。Supervisor 根据补充判断：属于当前任务的条件或做法，就用反馈继续同一个 delegation；明确要求调整计划，就按用户授权通过现有控制决定落实。需要替换执行时也由该决定处理，不能把“收到补充”当作替换信号。

有用户补充是一次有效的判断输入，即使没有新的 Announce，也不必让 subagent 先重跑。若当前任务尚无结果，Supervisor 可以澄清、给出继续反馈或处理用户明确要求的调整，但不得验收没有证据的任务。无结果的执行异常仍按错误路径停止；这里是用户主动续接后的判断，不是自动补救循环。

计划和披露的稳定边界是执行循环。新 run 的这次判断可以根据用户明确的调整准备所需 Capability 信息，再恢复执行；不要求先结束当前 delegation 或新增一种 Supervisor 模式。用户确认的含义由 Supervisor 从主对话理解，root 负责结构与执行合法性校验，不新增语义审批。

普通提问不依赖 `interrupted` 事件，也不挂起内部 agent 调用。Review 或用户主动暂停继续使用已有中断机制；不为 Supervisor 提问再建一套等待状态机。

## root 落实决定并进入下一轮

root 校验返回值的结构、模式、Capability 范围、活动 delegation 和计划推进是否一致，然后改变状态。它不再独立判断结果是否完整，也不根据停止原因否决 Supervisor 的语义判断。

| 决定 | 当前 delegation 和证据 | 后续执行 |
| --- | --- | --- |
| 采纳并推进 | 对 main 中已有结果记录任务验收，结束原私有执行范围，不再次搬运或发布结果 | 创建并执行下一项 delegation |
| 继续完善 | 保留原 delegation 身份、任务和全部私有上下文；可同时保存用户确认的后续计划调整 | 在同一个 delegation 上继续；反馈进入下一次执行简报，不替换当前任务 |
| 用户确认后的替换 | main 保留原结果，不标记任务成功，结束原执行范围 | 按用户确认的调整创建并执行替代任务 |
| 采纳并回复 | 对 main 中已有结果记录任务验收 | 保存剩余计划，输出回复结束本轮 |
| 普通回复 | 保留活动 delegation 和未采纳证据（若有） | 保存未完成工作，输出回复结束本轮 |

发布执行记录和采纳任务分开进行。main 表示发生过的事实，不是只收录已完成任务的清单。采纳标记由 root 根据提案写入现有消息元数据和委派摘要，不改写原始结果；其他 main 消费者也不能把结果出现当作已经成功。

下一次 Supervisor 调用读取更新后的 root 上下文。控制工具自己的 ToolMessage、Supervisor 的中间文本和 Capability 私有工具记录不会一起进入主对话。原始调用详情由 tracing 记录。

### 执行结果怎样回到 Boundary

沿用现有 Announce 表示 delegation 的结果证据：记录来源、任务、消息身份和完整结果，不携带完成判断。序列化字段和版本由[Announce 实现参考](../../reference/runtime/delegation-announces.md)负责，本文不重复定义 schema。

执行正常停止且选中了新的可交付结果时，root 生成 Announce 并直接写入 main，然后进入 Boundary。这里的可交付结果不要求任务已完成：执行到一半的自然回复、失败尝试或缺失条件说明，同样可以是结果证据。每次输出沿用一个 Announce 身份，继续执行后追加下一次结果；不把同一输出在私有范围和 main 各保存一份 Announce。内部停止原因不参与验收，因而 `completionReason` 可以退出跨层协议，只留必要诊断。

未处理异常不生成 Announce。执行停止却没有可交付结果时，也不制造空 Announce 或自动进入空 Boundary；保存现有记录后停止本轮，向用户报告。用户之后主动补充并续接时，可按上面的用户输入路径进入 Supervisor。Review、取消和中断继续遵循已有机制。

### 只在新一轮启动时检查压缩

这里的“一轮”指一次 root run，不是 Supervisor 与 Capability 之间的一次 loop。沿用 `prepare → compactContext` 的入口：新 run 启动时检查水位，需要时压缩旧历史；进入执行循环后不再触发 root 消息压缩，也不单独裁剪 Announce。本轮新增的结果及其先前尝试保持完整，直到本轮结束，避免影响验收。

现有水位是扣除生成与推理预留后的可用输入窗口的 75%，剩余约 25% 用于本轮新增上下文。上下文保护同时依靠压缩后的保留规则，而不只依赖这份余量。

每次压缩沿用两条保留规则：保留最近若干条消息，并完整保留当前未完成 delegation 的所有 Announce，即使它们已落在最近消息范围之外。利用已有活动任务与 Announce metadata 中的身份关联判断即可；其余旧历史正常压缩。因此续接未完成任务也可以检查并执行压缩，不必跳过整个压缩步骤。

Announce 进入 main 后，保护条件应依据它已有的委派身份，而不是是否带有私有 lane 标签。需要验收的多次结果保留原文，不用摘要替代。即使以后调整压缩水位或旧历史保留范围，这条规则仍然成立，不增加保护状态、额外结果副本或 fallback。Capability 内部私有上下文的维护仍由 subagent 自己负责。

## 异常由谁处理

交互设计只需要明确两个处理位置，不新增一套错误类型系统。

| 错误所在边界 | 行为 |
| --- | --- |
| 工具契约允许调用方处理的操作错误 | 通过已有工具错误结果交给调用它的 LLM；LLM 可以调整调用、改变做法或说明阻碍 |
| 架构、协议或未处理异常 | 沿用节点错误清理和抛出路径，停止本轮并展示错误，由用户决定后续动作 |

Capability 的工具反馈由 Capability 模型处理，Supervisor 的探索工具反馈由 Supervisor 模型处理。LLM 根据反馈继续执行，是正常工具循环的一部分，不需要 root 再包一层统一修复循环。

错误是否可作为工具反馈，取决于已有工具契约。不能因为错误发生在工具函数里，就把程序缺陷、状态损坏或任意异常全部转换成可重试的 ToolMessage。

非法控制响应、委派状态不一致、检查点不兼容等问题属于流程或协议错误，不能让 Supervisor 再猜一条补救命令。未处理的模型服务、执行、摘要或收尾异常也沿用错误出口，不包装成自然回复或结果证据。

停止后保留原始诊断和可恢复记录，展示具体下一步。用户可以补充条件、显式继续或重新发起任务，能否恢复取决于原有机制。保留状态不意味着自动继续、重试、改派或采纳。Host 已有的致命与可恢复错误分类继续使用，不因本协议都要求停止本轮而合并。

## 用 LangChain 和 LangGraph 实现交接

Supervisor 是 root 节点内部等待完成的一次 agent 调用。内部调用结束时，结果返回 root；是否继续派发或结束外层图，由 root 决定。

### 控制工具使用 returnDirect

三个控制工具在注册时设置 `returnDirect: true`，工具实现直接返回只包含 `update` 的 LangGraph `Command`：

```ts
// proposal 是已有的业务提案；工具注册时设置 returnDirect: true。
return new Command({
  update: {
    supervisorCommand: proposal,
    messages: [new ToolMessage({
      name: toolName,
      tool_call_id: runtime.toolCallId,
      content: 'Proposal recorded.',
    })],
  },
});
```

`supervisorCommand` 只保存本次调用的结果。ToolMessage 的调用 id 补全请求/响应配对，工具名称让当前 LangChain 路由识别 `returnDirect`。这条消息是私有确认，不是命令传输文本或用户回复。

`agent.invoke` 返回后，适配层直接读取提案，按现有 runner 类型返回 root。root 再构造自己的 `Command` 落实业务状态和路由。内部控制工具不使用 `Command.PARENT` 跳进父图。

这样可以删除 JSON 往返解析、控制工具的 `wrapToolCall` 转换、用于退出内部调用的 `goto: END`／`jumpTo`，以及下一轮模型入口里的命令退出判断。普通文本仍走 agent 正常终止路径，不需要 finish 工具或额外退出 hook。

### 校验发生在工具执行之前

模型 wrapper 保留提示词、工具选择和完整响应校验。控制调用必须独占该次响应的工具调用列表；多个控制调用、探索与控制混合调用、格式不合法的控制提案，均在任何工具执行前拒绝。

不能选择第一个控制、把冲突决定串行执行，或增加自动纠正轮次。root 收到返回值后仍校验一次业务边界，因为生产适配器和测试注入的 runner 都必须遵守同一约定。

明确支持时，可用供应商原生选项关闭 Supervisor 的并行工具生成，同时保留自动工具选择以支持自然回复。未知接口不硬塞参数，不增加能力注册表或删除参数重试。该选项减少非法输出，不能替代执行前校验；仅含探索工具的批次仍然合法。Capability 的工具调度不随之改变。

### 框架依据及验证范围

官方[子图组合指南](https://docs.langchain.com/oss/javascript/langgraph/use-subgraphs#call-a-subgraph-inside-a-node)支持父节点调用子图并转换返回值；[returnDirect](https://reference.langchain.com/javascript/langchain/index/Tool/returnDirect)用于工具调用后结束 agent 循环。[Command 文档](https://docs.langchain.com/oss/javascript/langgraph/graph-api#command)说明 `goto` 增加动态出边，不覆盖已有静态出边。

此前用 LangChain 1.5.2、LangGraph 1.4.7 和本地假模型验证：普通工具和 `Command({ update, goto: END })` 都触发两次模型调用，`returnDirect` 配合 `Command({ update })` 只有一次，状态更新得到保留。这支持实现选择，但不代表正式 Supervisor 集成已经完成验证。

## 本轮结束与后续恢复

自然回复或 `accept_result` 的回复都结束当前 root run，不创建 `interrupt`，也不把内部 Supervisor 调用留在挂起状态。

有未完成工作时，使用已有续接快照保存必要的 goal、活动 delegation 关联和剩余计划，清理本轮 Supervisor 会话。后续显式继续时，根据最新 root 上下文初始化新会话：活动 delegation 收到用户补充或有结果可评估时先进入 Boundary；没有补充也没有结果时沿现有机制恢复执行；只有剩余计划时进入 Entry。没有 delegation 和剩余计划的提问则沿普通对话回到 `entryAnswer`。Review 等中断仍由已有机制处理，不统一改成这种普通回复路径。

新的 run 可以根据用户确认重新准备计划及所需 Capability 信息；仅创建新会话或收到继续请求，不代表获准改计划。用户回答 Supervisor 的问题也是继续原工作的入口，不应因前一轮正常结束就丢失关联。

root 检查点负责已提交的状态变化和待执行节点。恢复已提交决定时，不重复验收或派发；在决定提交前失败，则可能需要重新调用 Supervisor。调用内的 `supervisorCommand` 不是持久化决定缓存。

控制工具没有外部执行副作用，不增加单独账本。外部 Capability 工具继续遵守已有幂等要求，`returnDirect` 不提供外部操作“恰好执行一次”的保证。

## 用完整场景检验设计

以“修复缺陷、验证测试，再准备发布说明”为例：

1. Entry 看现有 root 上下文，提交“修复并验证”和“准备发布说明”的计划。
2. 第一次结果只有补丁、没有测试证据，先作为 Announce 进入 main。Boundary 据此让同一 delegation 继续补测；root 保留它的执行上下文。
3. 下一次结果包含测试通过证据，追加到 main。Boundary 综合 main 中两次完整结果，采纳当前任务并派发发布说明；root 记录验收，不重复发布结果。
4. 发布说明完成后，Boundary 根据更新后的主对话采纳结果，通过 `accept_result` 输出最终回复和空计划。

如果测试工具返回可处理的参数错误，Capability LLM 消化后继续；如果检查点或协议状态损坏，运行停止，由用户决定下一步。如果后续任务需要用户提供发布目的地，则在当前任务可采纳时使用 `accept_result` 携带问题和剩余计划；当前任务本身尚未完成时，普通回复保留它。两种情况不混成一个“已完成”标记。

如果执行中发现必须先升级依赖才能继续，且这超出既定任务范围，Supervisor 直接说明原因并询问是否调整计划。用户只提供测试账号时，仍按原计划执行；明确同意增加升级任务后，后续调用才应用该调整。补测、修正同一任务的实现细节不属于这类计划变更。

以下检查针对交互行为，不做提示词字面匹配测试：

| 验证重点 | 必须观察到的行为 |
| --- | --- |
| 每轮上下文 | 对话与执行证据只来自当前 main；不读取私有 delegation 结果通道，不重复注入结果；已有消息身份准确关联当前任务 |
| Entry 决定 | 可执行时提交计划；应提问或作答时自然返回；不产生对不存在任务的验收 |
| 继续完善 | 保留同一任务和私有历史，反馈到达下一次执行；省略后续计划时保持原值，用户确认后的数组更新与继续一次落实，空数组不结束当前任务 |
| 采纳与替换 | 采纳后按既定计划推进；替换先获用户确认，保留证据但不记录成功 |
| 计划稳定 | 没有用户确认时不得增删、改排任务或改变 goal；正常任务进度不触发额外确认 |
| 用户交互 | Supervisor 直接提问，继续入口的回答回到原 goal 和未完成工作；未确认变更时保留原计划 |
| 提问入口 | 尚未建计划时回答经 `entryAnswer`；已有 delegation 时补充先入 main 再到 Supervisor，不自动结束或替换任务；没有结果时不得验收 |
| 结果输入 | 多次尝试有序可见；不同正常停止机制不影响输入；无结果或未处理异常不自动制造 Boundary，用户主动补充后可重新判断 |
| 发布与验收 | 部分完成的自然结果在验收前进入 main；出现不等于成功，验收不重复发布 |
| 压缩时机与保留 | root 仅在新 run 入口检查压缩；压缩保留最近消息及当前未完成 delegation 的全部 Announce，后者即使超出最近范围也保留原文；其余旧历史可正常压缩 |
| 工具后返回 | 每个控制工具记录提案后不再调用模型；探索仍可继续模型循环 |
| 文本后返回 | 原文只输出一次；不隐式验收，不丢失未完成工作；空或仅工具输出不能复用旧回复 |
| 非法控制批次 | 多控制、探索混合控制、错误结构或范围在执行前被拒绝，无部分效果、无修复轮次 |
| 错误处理 | 可处理工具错误到当前 LLM；架构异常停止，无自动补救派发 |
| 恢复与隔离 | root 重放不重复已提交效果；新会话从正式事实恢复；私有消息和确认消息不进入主对话 |

自然语言中的完成声明必须由模型正确表达为控制决定。该语义选择需要真实模型评测；不能因为本地结构测试通过，就认为模型一定会正确选择。

## 实施顺序与遗留清理

先固定每轮输入、返回值和 root 效果，再替换内部实现。沿用三个控制工具和现有 runner 接口，不同时重做会话存储、完整 Finalizer 或中断体系。

| 整理对象 | 处理方向 |
| --- | --- |
| 多处重复的规划与完成判断 | 提示词规定 Supervisor 的判断职责，工具说明描述效果，root 只校验并执行 |
| 单独的 Boundary 结果输入与验收时搬运 | Announce 先进入 main；删除私有结果提取、重复结果投影和验收时重新发布；保留身份关联及任务验收记录 |
| 内部控制工具退出逻辑 | 改用 `Command({ update })` 和 `returnDirect`，删除序列化中转及重复退出控制 |
| `completionReason` 和停止原因 veto | 从跨层结果与判断中移除，仅保留必要运行时诊断 |
| 第二次最终回复生成、旧结束原因命令 | 使用提供的回复文本，移除竞争的命令与模型改写路径 |
| 最近命令缓存和错误 fallback | 使用现有 root 检查点和错误出口，不增加决定缓存、协议修复或供应商协商循环 |

每一步用上述完整场景检查。更新提示词和工具说明时保持一个决策目标，不把同一套策略复制到多个位置。

### 当前实现状态

2026-09-07 工具职责收敛：`submit_plan` 仅用于 Entry，`accept_result` 统一验收并推进或回复；root 的确定性处理由 `runSupervisor` 节点中的 TypeScript 分支及 LangGraph `Command` 承载，没有第二个判断模型。以上接口调整待开发落实。

以下实现记录指本地工作区，相关代码尚未提交；本次提交仅包含文档，不能据此认为 PR 已包含这些实现。

工作区已有三个提案、自然回复、root 状态处理、续接快照和 `completionReason` 清理。`returnDirect` 集成、供应商并行参数设置，以及本次明确的稳定计划约束、执行期间固定披露和普通提问续接入口尚需落实与验证。现有实现仍允许 Boundary 重写剩余计划并继续探索，不能视为已符合此约束。统一 Finalizer node 留到 Supervisor 优化之后。本文修改设计，没有修改运行时代码。

`continue_current` 当前代码只有可选 `feedback`；可选 `remainingPlan`、对应校验和 root 一次更新的效果是本次明确的待实现接口扩展。

本次补齐的续接目标还要求：用户补充先到 Supervisor，准备所需信息后再继续当前 delegation。现有 pending 恢复路由仍可能直接进入 Capability，Boundary 输入仍强制要求 Announce；这些需要随用户补充路径调整，不能因文档已明确就视为已经实现。

Announce 已有识别字段，root 图也已只在 run 入口检查压缩；压缩已经保留最近消息和当前 delegation 的 Announce。尚待实现的是结果直接发布到 main、移除独立 Boundary 结果输入、调整现有模型投影与验收时搬运，以及让既有压缩保护按 Announce 身份匹配 main 中的结果。当前实现仍先把 Announce 存入私有范围，再于交接时放入 main；现有保护匹配仍依赖私有 lane 标签，不能直接视为已保护迁移后的 main Announce。

此前共享运行时 458 项测试，以及全仓测试、类型检查、构建和上下文审计通过。这些是前一版实现的验证记录，不验证本次设计中的待实现部分。本地 `packages/pet-agent/evals/supervisor-boundary.eval.ts` 包含四个虚构场景的真实模型评测，尚未随文档提交，仍需出站授权且尚未通过验证。

## 相关文档

本文负责整体交互；细节由已有文档维护，不在这里另建概念或重复定义字段：

- [Supervisor session](run-scoped-supervisor-session.md)：run 内语义状态和会话生命周期。
- [Announce 实现参考](../../reference/runtime/delegation-announces.md)：结果身份、版本、交接元数据与模型投影。
- [上下文注入图](../../reference/runtime/context-injection-map.md)：消息归属和选择规则。
- [错误处理参考](../../reference/api/error-handling.md)及 [Guard 设计](../../reference/runtime/guards.md)：现有错误出口、内部限制和诊断。
