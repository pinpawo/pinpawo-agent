---
name: wiki_maintenance
description: 根据代码、review 与 task 进度维护项目 Wiki 的整体概览。
uses:
  - bash
  - git
  - kanban-observation
version: 1
---

# Wiki Maintenance

维护一个由 LLM 持续编译、相互链接并随项目演进的 Markdown Wiki。Wiki 是项目知识的
持久成果：新证据会被整合进已有知识，而不是只生成一次性的任务摘要。

本 Capability 采用 Andrej Karpathy 的
[LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
模式，并映射到 Studio 项目：

- **事实来源**：当前 workdir 的代码、配置、现有文档、review 结论和 Kanban task 状态。
  它们是可核验的项目事实，由各自领域继续维护。
- **Wiki**：当前 workdir 的 `wiki/` Markdown。你负责创建、修订、关联和整理这些页面，
  让人和后续 Agent 都能快速理解项目。
- **维护约定**：本 Capability 定义 Wiki 的结构和工作原则；随着项目知识形态稳定，约定也可
  继续演进。

## Reconcile

Wiki ingest 触发器唤醒你时，把触发事件当作本次变化的线索，并完成一次知识对齐：

1. 先阅读现有 Wiki，确认已有结构、结论和待补充内容。
2. 从代码、review 和当前 Kanban task 快照中核验与本次变化有关的事实。
3. 将新事实整合到本次变化直接影响的页面：更新概览与当前状态，补充决策及其理由，连接相关
   主题，并明确新证据对旧结论的加强、修订或冲突。
4. 保留事实来源、适用范围和不确定性，使读者可以回到代码、review 或 task 记录复核。
5. 随 Wiki 增长维护可导航的入口。`wiki/PROJECT.md` 承载项目全貌；需要更多主题页时，从概览
   链接到它们，并让相关页面彼此可达。

## Query and synthesis

收到知识问题时，先从项目概览定位相关页面，再结合事实来源回答。对项目有持续价值的比较、
解释或新联系可以写回 Wiki，使本次探索成为后续任务可复用的知识。

## Wiki health

日常 reconcile 检查本次涉及页面及其直接链接。收到明确的 Wiki health 或 lint 请求时，再对整个
Wiki 检查页面矛盾、陈旧结论、孤立页面、缺失链接、未解释的重要概念和知识空白。把仍未确认
的内容明确记录为风险或开放问题。

Kanban task 的创建、状态推进和阻塞判断由负责这些 task 的 Pet 完成。你的交付是更新后的 Wiki
文档，并在完成时说明修改了哪些页面、依据是什么，以及还有哪些事项需要关注。
