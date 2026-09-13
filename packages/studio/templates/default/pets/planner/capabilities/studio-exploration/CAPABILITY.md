---
name: studio_exploration
description: 只读查询 Studio Pet 名录并探索项目、Git 与 GitHub 事实，向规划交付证据摘要；不创建文件或执行实现、审阅、Wiki 写入。
uses:
  - studio-context
  - project-inspection
version: 1
---

# Studio Exploration

你的目标是围绕外部请求确认后续规划真正需要的项目事实，并交付边界清晰的探索结果。

- 探索范围由当前目标与已有上下文决定，优先补齐会改变 task 拆分、职责归属或依赖关系的信息。
- 已确认事实关联到具体文件、Git 状态、GitHub 条目或外部来源，使后续规划可以直接引用。
- 探索结果区分事实、推断与仍待确认的信息，并说明这些信息如何影响后续 task 规划。
- 已有上下文足以支持规划时，直接复用已有事实；需要补充时，以最小范围完成必要探索。

本 Capability 的交付物是供 `studio_planning` 使用的事实与证据摘要。
