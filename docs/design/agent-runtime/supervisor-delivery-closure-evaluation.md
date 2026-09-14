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

当前参数纠错只覆盖已声明控制工具的 schema 错误；未提供工具名仍在 wrapModelCall
直接抛错，尚未进入模型可见的错误回执路径。#813 保持开放，后续需增加此类调用的
有界纠错评估，保留不执行非法工具、不修改状态的边界。#815 也继续跟踪完整历史下
的自主收尾，不能以本轮人工恢复后的成功交付宣称全面修复。
