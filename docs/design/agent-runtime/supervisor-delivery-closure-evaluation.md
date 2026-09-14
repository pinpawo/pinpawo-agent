# Supervisor 交付收尾评估（草案）

## 问题与边界

#815 的观察是：工作能力产出审阅文本，Supervisor 却回复已提交看板，实际提交能力未执行。
它不能单独证明整个 Supervisor 设计错误。需要区分能力职责披露、交付证据、计划缺项与历史干扰。

本评估只调用真实 Supervisor 模型；Capability 交付使用合成 fixture，不能代替真实 Studio E2E。
不访问业务仓库，不执行实际看板操作。example 和预期输出保存在
`packages/pet-agent/evals/datasets/supervisor-delivery-closure.ts`。

## 可观察判定

- 缺少提交且目标要求提交：下一次实际 delegation 选择 reporting。
- 复核已经完成：不能以再次复核代替补齐提交。
- 已有已验收复核及提交回执：自然收尾，避免重复提交。
- 用户只要求聊天答复：允许自然回复，不强制 reporting。
- 入口先执行 review 是合法选择；无需强制模型一次预排所有后续步骤。

判定读取经生产 handoff 校验的 delegation 与计划，不以回复中的“完成”文字作为成功证据，
也不要求固定的 submit/review/adjust 调用顺序。

## 方法

先冻结案例运行基线，再在相同案例、同一模型配置上运行候选变更。区分模型错误、超时和
夹具缺少前序证据；不把请求失败算作业务决策错误。保存逐例决策、最终计划及原始合成消息。
应特别检查错误声称写入、重复工作、重复提交和不必要的询问。

候选优化只澄清 Supervisor 的通用职责：当前工作验收与整个用户目标收尾分开判断，
根据能力职责和实际交付区分内容产出与外部动作。不加入 Studio 专用路由、强制 reporting，
也不以硬编码工具名认定通用任务完成。

## 运行

`npm run eval:supervisor-delivery-closure --workspace @pinpawo/pet-agent`

支持 `PROMPT_EVAL_PROFILE_ID`、`PROMPT_EVAL_REPEATS`（1–10）、`PROMPT_EVAL_CASE`、
`PROMPT_EVAL_OUTPUT_DIR`。默认复用本机模型配置，三个并发请求，每例限制 240 秒与 100 graph steps。

同步合成 examples：

`AGENT_EVAL_DATASET=supervisor-delivery-closure npm run eval:langfuse:sync-datasets --workspace @pinpawo/pet-agent`

现有本机 Langfuse 尚不可访问；同步未成功，不宣称平台上已经存在本数据集。

## 首轮观察（2026-09-14）

同一已配置模型（DeepSeek V4 Pro），8 个修正后的基础案例各运行一次；更贴近 E2E 的
摘要披露与旧计划案例各重复两次。后者作为第 9 个 example 保留在数据集中。

| 版本 | 调用样本 | 预期动作通过 | 超时 | 其他运行异常 | 已观察到错误收尾决策 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 原版 | 10 | 7 | 2 | 1 | 0 |
| 职责表述候选 | 10 | 8 | 2 | 0 | 0 |

以上是小样本观察，不是稳定成功率。原版的其他运行异常当时只记录了 Error 名称，无法
进一步归因；runner 已补充后续失败详情和提示词/数据集指纹记录。不能把此次异常减少
当作候选优化有效的证明。

最初一组夹具漏掉了“前序复核已验收”的事实，且口头提交案例的复核证据过于简略，导致
模型重做复核。补齐后重新运行，以上表格不混入那组探索结果。

#815 的现场“未提交却声称已提交”尚未在真实模型评估中稳定复现。评分器的单元测试
能够识别这一失败，清晰证据场景的模型也能作出正确决策。当前仅保留通用职责表述候选，
不将其认定为已验证修复；需要继续用真实 Studio 与完整历史形态检验。#815 保持开放。

本轮 PetAgent 516 项测试及类型检查通过。合成 example 与结论已补充到 #815；平台同步
因本机 Langfuse 不可达而未完成。

## 超时诊断补充

为避免把所有失败归为服务慢，runner 新增逐次模型开始/结束/错误事件、耗时、token usage
和控制调用记录；事件即时写入 timing.jsonl，失败时也保留，不记录真实业务工作区数据。

单独串行重跑 e2e-review-delivery（候选）得到以下观察：输入首次约 2,453 tokens，
四次模型调用共 213.5 秒，推理 tokens 共 18,518。

| 调用 | 秒 | 推理 tokens | 决策 |
| --- | ---: | ---: | --- |
| 1 | 136.3 | 12,055 | adjust_plan；误把已完成 T-OLD 重新放入待办 |
| 2 | 35.3 | 3,199 | adjust_plan；说明并移除旧任务重复项 |
| 3 | 5.2 | 306 | review_current；尝试验收重新规划后的任务 |
| 4 | 36.6 | 2,958 | execute_current |

最终失败为 `Accepting a task requires its returned delivery.`：替换计划后，新任务身份没有
对应的交付，不能直接使用被替换任务的旧交付验收。因此这不是纯网络延迟，也不是此次
单独重跑触发了整例超时；它揭示了旧任务干扰、重规划与交付身份连续性问题。此前未保留
详情的 Error 不可追溯认定为同一个错误。

请求客户端默认 timeout 为 120 秒、maxRetries=0，评估另外使用 240 秒总 AbortSignal。
本地 SDK 的 fetchWithTimeout 在 fetch 返回后清理计时器，因此该 120 秒不能当作完整
响应读取的墙钟上限。这次单请求 136 秒的观察与此边界相符。

应将模型推理预算、已完成任务上下文投影、adjust_plan 的 continue/replace 决策与交付
身份分别评估；不以单纯增加总超时时限作为修复。保留此次失败，候选尚不能认定有效。

## 非必要不重排的后续验证

根据用户明确要求，Supervisor 优先沿用适用的现有计划；只有具体证据或新要求使计划
不适用时才最小调整。同步澄清 adjust_plan 的剩余工作输入与 continue 的身份保留语义，
未引入运行时调整次数限制。

评估额外观察 adjustments 与已完成任务是否被重新列为 pending。已有 reporting 待办的
案例要求零调整；确有遗漏或职责错配的案例允许一次必要调整。这些阈值只属于具体合成
案例的验收预期，不是生产路由约束。

两次真实模型样本均通过：

- pending-report：约 11 秒，零次 adjust_plan，验收后直接执行既有 reporting。
- e2e-review-delivery：约 116 秒，一次 adjust_plan，使用 continue 保留原审阅交付，仅
  拆出尚未完成的 reporting；没有复活旧任务，没有无对应交付的验收错误。

第二例首条模型响应仍耗时约 110 秒。结果支持本次计划稳定性方向，但样本量小，不能
据此认定长推理或 #815 已全面解决。517 项测试和类型检查通过。

## 后续 Studio 实机观察

切换到 DeepSeek V4.1 Flash 后，一轮实际实现与独立复核最终都通过 reporting 工具
提交了完整结果；看板保存内容与工具输入一致，完成事件也触发了 Wiki 更新。
这只证明本轮交接成功，不代表全过程无需干预：Executor 的恢复入口及交付收尾、
Wiki 的后续入口均出现过 `Supervisor called a tool unavailable in this invocation.`。
协调者把错误另行反馈后才继续完成。这些是运行观察，不是稳定失败率或模型对比。

该次实机运行的参数纠错只覆盖已声明控制工具的 schema 错误；未提供工具名仍在 wrapModelCall
直接抛错，尚未进入模型可见的错误回执路径。#813 保持开放，后续需增加此类调用的
有界纠错评估，保留不执行非法工具、不修改状态的边界。#815 也继续跟踪完整历史下
的自主收尾，不能以本轮人工恢复后的成功交付宣称全面修复。

## 工具层纠错简化

后续实现删除 afterModel 的重复 schema 校验与跳转，使用 wrapToolCall 捕获工具框架的
参数解析错误并显式标记错误回执。未知工具由 ToolNode 原生返回带可用工具名的错误，
不再被 wrapModelCall 提前拦截。模型沿正常工具循环自行修正，执行工具仍仅在成功时
交接；没有新增提示词规则或自动重排策略。

真实 graph 回归覆盖四类控制参数错误，以及入口、交付 Boundary 的未知工具调用；
后者包含误用 delegate_capability 和本轮未开放的 capability_details。确认错误不提交
状态、修正后仅派发一次，连续参数/未知工具错误受递归预算限制。业务约束错误、取消、
可恢复 interrupt 和文档预算错误维持原有失败或中断语义。

这些确定性回归覆盖 #813 已观察到的两个错误恢复分支，但不等于已重新跑过完整真实
模型 E2E，也不证明 #815 的自主收尾决策稳定性。

## 历史工具调用压力对照（2026-09-14）

针对 #813 的另一假设：Supervisor 看到大量 `delegate_capability` 历史调用，是否会
模仿这些记录而调用未提供的工具。新增独立 runner
`packages/pet-agent/evals/supervisor-tool-history.eval.ts`，通过真实 Supervisor graph
与本机已配置的 DeepSeek V4.1 Flash（API 模型名 `deepseek-flash`）运行合成场景。
只模拟交付证据，不调用 Capability 执行方，也不访问真实仓库或看板。

三个对照组：

- baseline：仅移除新增的工具范围说明段落，保留其余当前提示词和运行时纠错机制。
- prompt：当前生产提示词和原始历史工具消息。
- projection：当前提示词，在模型输入边界将历史派发和结果转成只读数据消息。
  原始执行参数、结果、call id 与元数据保留；不改 Root 状态，不转换本轮新调用或错误回执。
  该投影仅存在于 eval helper，没有接入生产。

场景包括新计划 Entry、审阅已返回且 reporting 待办的 Boundary，以及已有计划、长历史
之后用户说“继续”的恢复 Entry。分别插入 0、40、120、300 组历史调用和结果；Boundary
额外包含当前任务的一组真实形态合成交付。历史任务使用独立 task id，避免混入当前任务
验收证据。每组均校验实际送入模型的历史调用数量，记录模型每轮原始调用，不能把
Supervisor 返回后运行时生成的合法 `delegate_capability` 派发算作模型误调用。

有效样本共 51 次 Supervisor invocation、99 次模型响应：

| 对照 | invocation 数 | 模型误调用 delegate_capability | 其他未提供工具调用 | 正确最终交接 |
| --- | ---: | ---: | ---: | ---: |
| baseline | 21 | 0 | 0 | 21 |
| prompt | 21 | 0 | 0 | 21 |
| projection | 9 | 0 | 0 | 9 |

0/40/120 组覆盖 Entry 与 Boundary，新旧提示词每个组合重复 2 次，共 24 次；300 组
覆盖三个场景与三个方案，每个组合重复 3 次，共 27 次。projection 只与相同的 300 组
场景比较，不把不同历史长度混在一起计算性能优劣。

另观察到 6 次参数错误：5 次给 submit_plan 增加不支持的 goal，1 次给 task 增加
不支持的 task_note。均收到框架错误反馈后在同一 invocation 自行修正并正确交接。
这支持参数恢复路径的有效性，不构成未知工具恢复的真实模型验证。

**结论：本次未复现工具名误用。** 不能将历史数量当作已确认根因，也不能认定提示词
已消除风险；旧提示词同样通过。没有观察到足以支持生产消息投影改造的收益，暂时保留
明确的工具范围提示与错误恢复。合成历史内容较规整，不能代替现场完整 checkpoint 中
交错的计划、重试、错误反馈、能力文档与业务上下文。下一步若真实 trace 再次出现误用，
应先脱敏提取该轮完整输入，作为固定反例再比较投影方案。

投影若后续采用，应仅改变 Supervisor 的模型视图，保留 Root 的标准工具协议记录作为
执行、验收、回放依据；保留执行状态、task/delegation 身份及交付正文，避免为消除模仿
而丢失验收证据。本轮并未证明投影对 interrupt、复杂混合工具消息与完整 Studio 生命周期
的生产兼容性，不据此直接接入运行时。

运行方式：

```sh
npm run eval:supervisor-tool-history --workspace=@pinpawo/pet-agent
HISTORY_COUNTS=300 HISTORY_MODES=entry,boundary,resume HISTORY_VARIANTS=baseline,prompt,projection PROMPT_EVAL_REPEATS=3 npm run eval:supervisor-tool-history --workspace=@pinpawo/pet-agent
```

支持 `PROMPT_EVAL_PROFILE_ID`、`PROMPT_EVAL_OUTPUT_DIR`；每个 runner 两路并发，
每例 150 秒和 24 graph steps 上限，模型网络层不自动重试。结果保存完整合成首轮输入、
输入哈希、逐轮调用、token usage、耗时及最终交接评分。该次有效结果保存在本机
`/tmp/supervisor-tool-history-v2`、`/tmp/supervisor-tool-history-300` 和
`/tmp/supervisor-tool-history-resume`；启动时用于校验采集链路与夹具的无效试跑不计入表格。
