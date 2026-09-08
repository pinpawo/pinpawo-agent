# Supervisor Capability 搜索效率 eval

运行 `npm run eval:supervisor-search -w @pinpawo/pet-agent`。使用本地模型 Profile 和服务端默认参数，不执行 Capability 业务工具，也不上传 tracing。

可选环境变量：

- `PROMPT_EVAL_PROFILE_ID`：选择模型，与其他 decision eval 相同。
- `SEARCH_EVAL_REPEATS`：每个场景重复次数，默认 1；观察稳定性建议多轮。
- `EVAL_CASES`：逗号分隔的场景名；未知名称报错。
- `SEARCH_EVAL_REPORT_PATH`：完整 JSON 报告路径，默认系统临时目录。

| 场景 | 阶段 | 最大搜索调用数 | 行为要求 |
|---|---|---:|---|
| entry-exact-capability | Entry | 1 | 按明确 Capability 名披露后提交计划 |
| entry-disclosed-capability | Entry | 0 | 已披露文档足够，直接提交计划 |
| entry-two-responsibilities | Entry | 2 | 为两种职责披露文档并提交完整计划；允许一调用多 terms 或并行两调用 |
| entry-user-choice-before-work | Entry | 0 | 用户要求先询问，不先探索 |
| boundary-accept-no-discovery | Boundary | 0 | 已有证据足够，验收并回复 |
| boundary-continue-no-discovery | Boundary | 0 | 测试未执行，将缺口交回当前 delegation |

这些是受控 fixture 的效率预期，不是通用运行时限制。注册表含 5 个职责互异的 Capability，包括干扰候选。每例使用新 runner，首次路由清单生成计入模型调用与耗时，避免只呈现缓存命中的结果。

报告复用现有 search diagnostics，包含搜索次数、含搜索的模型轮数、查询、返回的披露信息，并新增：

- 每次模型/工具调用的开始时间、持续时间、完成/失败/仍等待状态。
- 模型提出的工具名称，帮助区分提出调用和实际执行。
- 相同 terms（忽略大小写和顺序）的重复搜索次数。
- 模型调用总数、整体耗时，以及独立的行为/搜索预算判定。

并行两次 search 计为两次调用、一轮。工具结果按回调完成顺序记录；详细时序按 run id 关联工具的开始/结束事件。实际执行次数超过预算或相同查询重复都判失败。超时/异常仍输出已收集的调用轨迹；没有返回的调用保留 pending，不能把它的耗时误记为零。

局限：这是 Supervisor 专项，不运行 root 全图；现有完整生命周期 eval 继续负责节点交接和 checkpoint 验收。不同措辞但语义相同的重复查询需要结合 searchResults 人工检查，当前重复计数不做额外模型判断。一次通过不代表长期稳定率。

## 首轮结果（2026-09-08）

DeepSeek V4 Pro 与 Qwen3.8 Max 使用服务端默认参数，各跑一轮，均 5/6 通过。两者搜索次数一致：

| 场景 | DeepSeek | Qwen |
|---|---:|---:|
| 明确单 Capability | 1 | 1 |
| 文档已披露 | 1（预期 0，失败） | 1（预期 0，失败） |
| 两种职责 | 2，同一轮 | 2，同一轮 |
| 先询问用户 | 0 | 0 |
| Boundary 验收 | 0 | 0 |
| Boundary 继续 | 0 | 0 |

失败均为再次搜索已披露的 repository，返回无新增文档，最终控制动作仍正确。本轮没有观察到多轮搜索失控；保留该失败作为效率回归目标，不调整阈值迁就结果。时序同时表明首次路由清单生成也是模型调用，不能把其耗时误归为 capability_search。
