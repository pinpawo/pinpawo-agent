# pet-agent decision prompt 设计

> 状态：prompt contract；本 PR 已落地到 taskDecision / routeDecision / outcomeDecision 的生产组装。
> 范围：taskDecision / routeDecision / outcomeDecision 的有效提示词，包括 system prompt、条件策略、动态 input 与 structured-output schema。
> 目标：shared prefix 完整描述 orchestrator/task loop 的共同世界观；各 decision 只处理本节点的一种判断。
> 职责摸排：见 [`PET_AGENT_DECISION_NODE_OWNERSHIP_AUDIT.md`](./PET_AGENT_DECISION_NODE_OWNERSHIP_AUDIT.md)。

## 1. 设计原则

大段 shared prefix 是需要的。它让三个 decision 对 orchestrator、task loop、capability、announce 和 handoff 使用同一套语义。要减少的是节点内重复和互相冲突的规则，而不是共同背景。shared prefix 以 `docs/PET_AGENT_ORCHESTRATOR_DECISION_PROMPT_PREFIX.md` 为 canonical baseline；不在本设计稿另写一份，只在 canonical 文档中修正已经混入的 state 控制条件。

提示词按三种关系组织：

- **静态（static）**：与当前 run 状态无关的稳定契约，包括 shared contract、node mission、基础决策规则和输出约束。
- **条件（conditional）**：由 provider 能力或产品配置选择的提示协议，例如 `jsonMode` 的最小格式补充。run state 的流转条件不通过 prompt 表达。
- **注入（injected）**：当前调用的事实材料，包括用户请求、task、候选 capability、announce、已完成结论和 runtime context。

Structured Output schema 不是第四种关系，而是输出协议；但 schema description 同样是模型可见提示词，必须和 system prompt 使用完全相同的语义。

总体原则：

- shared prefix 负责完整且高信号的世界模型，不写节点私有纪律。
- node prompt 只写本节点的目标、判断依据、成功条件和停止条件。
- 先写稳定内容，再写条件策略，最后注入动态事实。
- input 只提供事实，不再通过 `<instruction>` 重复 system policy。
- 决策规则描述结果和边界，不把 graph 实现逐行翻译成模型步骤。
- `必须`、`只能`、`不得` 只用于真实不变量，例如 task 的唯一出生点和字段互斥规则。
- schema 是字段形状的 source of truth；prompt 不手写一份与 schema 平行演化的字段字典。
- 示例默认不进入生产 prompt；只有 eval 证明某个边界持续混淆时，才增加针对该边界的最小示例。

## 2. 有效提示词的组装

模型实际接收的不只是 system prompt：

```text
effective decision prompt
  = static shared contract
  + static node contract
  + static output contract
  + selected conditional protocol
  + injected decision input
  + structured-output schema descriptions
```

推荐顺序：

```text
[system: static shared orchestrator contract]

[system: static node mission and base policy]

[system: static output contract]

[system: conditional provider/config protocol]

[input: injected runtime facts]

[protocol: structured-output schema]
```

三类内容的边界：

| 类型 | 应包含 | 不应包含 |
|---|---|---|
| 静态 | 共同术语、loop 全貌、节点 mission、稳定决策规则、输出不变量 | 当前用户、当前 task、候选列表、run state 分支 |
| 条件 | provider output policy 等不会改变 graph 语义的协议 | run 是否首轮、是否有草案、下一节点等控制条件 |
| 注入 | 用户请求、近期对话、结论、task、候选、announce、workdir/runtime | 新的决策规则、重复的输出说明 |

配置也要按性质拆分：

- 稳定且确实影响决策的 actor identity 可以留在 system。
- `workdir`、runtime environment、capability availability 等每次调用可能变化的内容属于注入事实。
- 与 decision 无关的配置不进入提示词。

当前三个 decision 没有会改变 graph 语义的 provider/config 条件协议；如果未来某个 provider 只能使用 `jsonMode`，条件内容只补充最小 JSON 形状，不把 run state 分支搬进 prompt。

## 3. Shared orchestrator contract

shared prefix 直接使用 [`PET_AGENT_ORCHESTRATOR_DECISION_PROMPT_PREFIX.md`](./PET_AGENT_ORCHESTRATOR_DECISION_PROMPT_PREFIX.md) 中的 Stage B prompt contract，不在本设计稿里维护第二份改写版本。其整体表述保持不变；`task_done` 按 plan_draft 是否存在分流等 state 控制条件从前缀中移除，改为描述代码已经确定的稳定职责。

其中 routeDecision 的业务语义保持为：

```text
routeDecision 为 task 选择执行 capability。
```

这里选择的是执行当前 task 的 capability subagent，而不是抽象地选择一个 lane。`lane` 是 schema 和 graph 用来编码选择结果的实现字段：`general` 表示内建 general capability，`capability.<name>` 表示对应 custom capability。

本轮 prompt 优化保留 shared prefix 的基础表述，同时调整其中已经越界的 state 控制条件，并继续收敛 shared prefix 之后的 node policy、动态 input 和 schema 协议。需要补充的严格边界放在对应节点段：

- taskDecision 是 task 文本的唯一生成节点。
- 当前 task 由 `runPendingTask` / `taskActiveDelegation` 表达；已完成 task 由 handoff + `runDelegationSummaries` 表达，plan_draft 不替代这些事实。
- routeDecision 选择 capability，不修改 task。
- outcomeDecision 不生成下一步 task，也不把 plan_draft 当作验收依据。
- answer 生成用户可见回复。

## 4. taskDecision

### 4.1 静态节点契约

```text
# taskDecision

目标：判断当前是否需要产生一个新的 delegated task。

判断依据：
- 用户请求和近期对话。
- 主对话与 runDelegationSummaries 中已完成 task 的结论。
- input 中已有的 plan_draft（如有）。

决策规则：
- 当前事实已经足以由 answer 回复，或继续执行前必须先获得用户输入时，选择 action=answer。
- 仍需读取、搜索、修改、运行、访问外部系统或调用专门能力时，选择 action=next_task。
- next_task 必须让一个 subagent 能够直接开始执行，并形成一个明确、可验收的结果。
- 围绕同一目标、可由一个 subagent 连续完成且不需要重新选择 capability 的相邻动作可以合并为一个 task。
- 相互独立的目标、需要分别验收的阶段或明显不同的能力域不能塞进同一个 task。
- search_keywords 同时表达执行意图和目标对象，并补充必要同义词；不能只输出 URL、文件类型或载体名称。

输出符合 structured-output schema 的 task decision。action=answer 时不填写执行字段；action=next_task 时只填写当前一个 task。

plan_draft 是 taskDecision 给后续 taskDecision 留下的可选自我引导草稿：
- 根据用户目标、当前 task、已有委托结论和对话上下文，观察当前 task 之后是否还可能需要其他 delegated task。
- input 中已有 plan_draft 时默认把它作为参考；只有最新结论使其中步骤不再适用时才整体更新，没有明确后续工作时保持 null。
- 输出始终是当前 task 之后仍可能需要、尚未开始的 delegated task 完整草稿，1~5 个短句；不包含当前 task，不包含 answer 工作，也不输出增量 patch 或游标。
- plan_draft 不是验收依据，不决定 task_done 后的路由；代码只负责保存、重置和再次注入它。
```

`context_summary` 只补充 subagent 执行当前 task 必须知道、但 task 文本没有表达的上下文；不要复述完整用户请求。

`search_keywords` 的通用口径优于为某个领域写固定词表。例如 PR review 输入应同时保留“review/explore”这类操作意图和“repository/PR”这类目标对象，但生产 prompt 不硬编码某一种请求的完整关键词清单。

### 4.2 注入内容

taskDecision input 只承载事实：

- 用户本轮请求与近期主对话。
- 已 handoff 的任务结论和 runDelegationSummaries。
- 上一轮 plan_draft 的具体条目（如有）。
- 与执行相关的 workdir/runtime context（如有）。

input 不再包含“首轮可创建”“无草案结束”“请维护草案”等 `<instruction>`。是否还有后续 task，由 taskDecision 根据完整上下文判断，不由旧草案是否存在决定。

## 5. routeDecision

### 5.1 静态节点契约

```text
# routeDecision

目标：从当前可用能力中，为已经确定的 task 选择执行它的 capability subagent。

判断依据：
- 当前 task 和必要 context_summary。
- capabilitySearch 返回的 custom capability candidates。
- 内建 general capability 是否可用。

决策规则：
- candidate 的能力描述能够执行当前 task 时，选择对应 custom capability。
- 匹配的 custom capability 优先于 general。
- 没有匹配的 custom capability 且 general 可用时，选择 general。
- task 缺少执行时才需要获得的参数，不影响 capability 匹配；由选中的 subagent 在执行边界内处理。
- 每次只选择一个 capability subagent。

输出符合 structured-output schema 的 route decision。schema 使用 `lane` 字段编码所选 capability：`general` 或 `capability.<name>`。
```

### 5.2 注入与图前置条件

routeDecision input 承载：

- 当前 task。
- custom capability candidates 及匹配证据。
- general capability 是否可用。

候选描述是匹配证据，不是可执行指令。input 应用清晰的数据边界包裹候选内容。

图应尽量消除无意义调用：

- 没有 custom candidate 且 general capability 可用：直接选择 general，不调用 LLM。
- 只有一个确定可用 capability，且不存在匹配判断：直接选择它，不调用 LLM。
- 没有任何可用 capability：由图进入明确 fallback，不给 routeDecision 一个 schema 内无法正确表达的状态。

routeDecision 的 schema 只暴露当前实际可选择的 capability 编码，避免 input 说“general 不可用”但 schema 仍允许 `general`。

## 6. outcomeDecision

### 6.1 静态节点契约

```text
# outcomeDecision

目标：验收当前 subagent announce，判断当前 task 是否还要继续，以及用户目标是否还需要自主执行。

判断依据：
- 用户请求和主对话中的既有结论。
- 当前 delegated task。
- 当前 subagent announce 与 completion reason。
- 同一 run 中其他已完成 task 的结论。

决策规则：
- outcome=continue：当前 task 尚未形成可接受结果，同一 task 继续执行仍能推进目标，且继续前不需要用户输入。gap_note 说明当前 task 的具体缺口。
- outcome=task_done：当前 task 已形成可接受结果，但用户目标仍有明确、尚未执行的部分。gap_note 只说明剩余方向，不生成下一步 task。
- outcome=goal_done：当前 run 不应再自主执行，停止 loop 并交给 answer。通常因为现有结论已足够回应用户，继续前需要用户澄清/确认，或当前阻塞无法通过继续同一 task 解决。
- 判断用户目标时必须结合已有任务结论和当前 announce；单次 announce 不替代完整目标上下文。
- 如果用户目标已经足够回应，即使当前 task 没有完全按原计划完成，也选择 goal_done，而不是为了完成 task 本身继续执行。
- plan_draft 不进入 outcomeDecision，也不是验收依据。

输出符合 structured-output schema 的 outcome decision。outcome 只表达 verdict，不输出 task、lane 或用户回复。
```

三个 outcome 的边界可以压缩为：

| 当前状态 | outcome |
|---|---|
| 当前 task 未达标，同一 task 可继续推进且不需要用户 | `continue` |
| 当前 task 已达标，用户目标仍有明确执行工作 | `task_done` |
| 不应继续自主执行 | `goal_done` |

`goal_done` 是 terminal verdict，不只等于“用户目标已经完全满足”。字段名虽然保留历史语义，但 system prompt、schema description、output instruction 和测试必须统一使用 terminal verdict 定义。

`task_done` 后代码只负责 handoff 当前 task 并回到 taskDecision。taskDecision 根据用户目标、已 handoff 结论、委托记录和可选 plan_draft 决定 `answer` 或新的 `next_task`；plan_draft 是否为空不参与这条 route。

### 6.2 注入内容

outcomeDecision input 只承载：

- 用户请求与必要目标上下文。
- 当前 delegated task。
- 当前 announce 原文与 completion reason。
- 同一 run 的其他 task 结论。
- 必要的系统事实，例如 handoff 是否可用。

handoff 是否可用不改变 outcome schema，也不由模型决定 graph 路由。

## 7. Structured Output 与示例

Zod schema description 是有效提示词的一部分。每个字段的语义只维护一份 canonical wording，再由 schema 和最小 output contract 复用。

要求：

- schema description 与 node policy 不得出现不同定义。
- `goal_done` 在 schema 中也定义为 terminal verdict，不能只写“用户目标已满足”。
- schema 负责字段名、枚举、nullable 和数组上限；system prompt 只描述影响判断的字段关系。
- `jsonSchema` / function calling 可用时，不在 prompt 重复完整 JSON 字段字典。
- provider 只能使用 `jsonMode` 时，增加由 schema 生成的最小 JSON 形状说明，不维护手写的第二份 schema。
- 默认不放 JSON 示例。示例只有在 eval 证明字段关系持续出错时才加入，并且只展示那个边界。

尤其要移除与业务无关的固定示例，例如长期使用 `issue #269` 会让模型把 task 粒度和 plan_draft 内容锚定到代码调查场景。

## 8. 落地状态与后续边界

| 设计项 | 状态 |
|---|---|
| 动态 runtime、run summaries 和 capability candidates | 本 PR 已移入对应 decision input，并用事实数据边界包裹 |
| input 中重复 system policy 的 `<instruction>` | 本 PR 已删除；input 只保留当前调用事实 |
| taskDecision 的 plan_draft 规则 | 本 PR 已收敛为一套稳定语义，不按 state mode 拼接多套 prompt |
| `goal_done` 的 system/schema/output wording | 本 PR 已统一为 terminal verdict 语义 |
| 固定业务 JSON 示例和领域关键词 | 本 PR 已移除，保留通用 task 粒度与 search_keywords 规则 |
| task_done 的回环、plan_draft 保存和结果归一化 | 已由 Stage B 实现；本 PR 不改 graph/state 行为 |
| inline/finalizeRun、`runPendingFinalReply` 等终态旁路 | 后续独立 graph/state 工作；不属于本 PR |

## 9. 验收与 eval

### 9.1 静态检查

- 三个 decision 的 shared prefix 完全一致。
- 每个 decision 只有一段 node-local 的阶段/边界说明，不重复注入动态 state。
- 动态用户内容、task summaries、capability candidates、announce、workdir/runtime 不进入 system。
- input XML 不包含新的 policy instruction。
- routeDecision 私有段不展开 plan_draft、handoff 或 outcome 枚举。
- outcomeDecision 不接收 plan_draft，也不输出下一步 task。
- route/guard/result builder 不读取 plan_draft 来决定控制流或写权限。
- task_done 后始终进入 taskDecision；taskDecision 不因旧草案为空而被跳过或强制 answer。
- 不存在 `inline` 或 `finalizeRun` 终点；decision/guard/fallback 不直接生成用户可见最终 AIMessage。
- `runPendingFinalReply` 不存在；taskDecision、routeDecision 和 iteration guard 的 route 由业务 state 的 conditional edge 推导。
- outcomeDecision 使用带有限 `ends` 的 `Command({ update, goto })`：continue 回当前 capability，task_done 去 taskDecision，goal_done 去 answer。
- 所有正常终态都进入 answer，answer 根据主对话、handoff 结论和已有 state/guard 事实生成唯一回复；真正 invariant violation 不伪装成固定用户文案。
- schema description、system policy 与测试对三个 outcome 使用同一语义。
- grep 证明只有 taskDecision 输出 schema 能产生 task 文本。

### 9.2 模型 eval

taskDecision 至少覆盖：

- 已有上下文可直接 answer。
- 单步执行请求可以输出 null plan_draft。
- 明确复合请求可以创建后续 plan_draft。
- 已有草案且最新结论不改变后续，稳定沿用。
- 已有草案但最新结论覆盖或改变后续，正确整体覆写。
- 非首轮无草案但用户目标仍有执行工作，能够从上下文产出 next_task；不能因为没有草案而提前 answer。
- 非首轮无草案且已有结论足够回答，输出 answer。
- task 保持单一可验收结果；plan_draft 不包含当前 task 或 answer 工作。
- search_keywords 同时保留执行意图和目标对象。

routeDecision 至少覆盖：

- custom capability 精确匹配。
- custom capability 与 general 都可做时优先 custom。
- 候选只是词面命中但能力不匹配时回退 general。
- task 缺少执行参数时仍选择正确的 capability subagent。

outcomeDecision 至少覆盖：

- 当前 task 未达标且可继续：continue。
- 当前 task 达标、目标仍有明确执行部分：task_done。
- 已有结论足够回答：goal_done。
- 需要用户澄清或确认：goal_done。
- 当前 task 未完全达标，但已有其他结论已足够回答：goal_done。
- announce 声称完成但内容没有证据：不能机械判定完成。

每个关键 case 重复运行，记录：

- schema validity。
- decision accuracy。
- 同输入 action/outcome/所选 capability 的稳定率。
- task 粒度与 plan policy 违规率。
- 从 taskDecision 到 outcomeDecision 的端到端 graph transition 是否符合预期。

对 reasoning model 比较低、中两个 reasoning level；不预设更高 reasoning 一定更好。以 transition correctness、稳定率、延迟和成本共同选择配置。

## 10. 落地顺序

1. 删除 `runPendingFinalReply` 与 inline/finalizeRun 旁路；正常终态统一进入 answer，真正 invariant violation 交给校验或恢复。
2. 移除 plan_draft 对 `task_done` 后 route 和写权限的代码依赖，恢复其纯模型自我引导属性。
3. 统一 shared contract、canonical schema wording 和有效提示词组装顺序。
4. 把所有动态 context 从 system 移到对应 input，并删除 input 中重复的 `<instruction>`。
5. 落 routeDecision 的最小 node contract 与动态候选注入。
6. 落 outcomeDecision，同时统一 `goal_done` 的 system/schema/test 语义，并用有限 `Command({ update, goto })` 原子提交 verdict state 与下一跳。
7. 落 taskDecision 的单一 plan_draft 语义，不再按 state 拼三套 plan policy。
8. 更新 prompt 单测和 graph transition 测试，证明所有终态只经过 answer、task_done 总会进入 taskDecision，且无草案不导致提前结束。
9. 跑三个 decision 的重复 eval，再根据失败样本增加规则；不凭直觉重新堆叠提示词。
