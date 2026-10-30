---
name: wiki_maintenance
description: 根据代码、审查与任务进度维护项目 Wiki 的整体概览。
uses:
  - files
  - shell
  - web
  - git
  - github
  - channel
  - project_files
version: 1
---

# Wiki Maintenance

维护相互链接、随项目持续更新的 Markdown Wiki。Wiki 是项目知识的
持久成果：新证据会被整合进已有知识，而不是只生成一次性的任务摘要。

采用 Andrej Karpathy 的
[LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
方法维护项目知识：

- **事实来源**：当前工作区的代码、配置、现有文档、审查结论和明确交接的公开结果。
  使用这些来源核验文档中的结论。
- **Wiki**：Studio 配置的独立知识目录内的 Markdown，与 Knowledge 使用相同目录。默认配置在 `.pinpawo/studio.json` 的 `@pinpawo-plugin/project-files` 插件选项 `wikiDirectory`；旧配置的 `directory` 仍以 Studio 工作目录为基准。优先使用 `project_files` 工具，不按代码 worktree 猜测知识目录。代码和来源可以在其他 worktree 核验；任务或项目规则另有要求时遵循其约束。
- **维护约定**：本文说明 Wiki 的结构和维护方式；随着项目知识形态稳定，约定也可
  继续演进。

## 更新知识

收到 Wiki 更新请求时，以请求中提到的变化为线索：

1. 使用 `project_files_list` 和 `project_files_read` 阅读现有 Wiki，确认结构、结论和待补充内容；以读取返回的 digest 调用 `project_files_write` 更新已有页面，新建页面的 `expectedDigest` 为 null。若内容冲突，重新读取并合并，不覆盖他人修改。写入遵循现有审核；权限不足或审核未通过时如实说明，不能绕过或虚报完成。
2. 从代码、审查和本次交接的公开结果中核验与本次变化有关的事实。
3. 将新事实整合到本次变化直接影响的页面：更新概览与当前状态，补充决策及其理由，连接相关
   主题，并明确新证据对旧结论的加强、修订或冲突。
4. 保留事实来源、适用范围和不确定性，使读者可以回到代码、审查或交付证据复核。
5. 随 Wiki 增长维护可导航的入口。Wiki 根目录的 `PROJECT.md` 承载项目全貌；需要更多主题页时，从概览
   链接到它们，并让相关页面彼此可达。

## 查询与整理

收到知识问题时，先从项目概览定位相关页面，再结合事实来源回答。对项目有持续价值的比较、
解释或新联系可以写回 Wiki，使本次探索成为后续任务可复用的知识。

## 检查文档质量

日常更新检查本次涉及页面及其直接链接。收到检查整个 Wiki 的请求时，再对整个
Wiki 检查页面矛盾、陈旧结论、孤立页面、缺失链接、未解释的重要概念和知识空白。把仍未确认
的内容明确记录为风险或开放问题。

你的交付是更新后的 Wiki 文档，并在完成时说明修改了哪些页面、依据是什么，
以及还有哪些事项需要关注。
