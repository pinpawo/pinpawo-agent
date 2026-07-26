export const capabilityCreatorInstructions = `# Capability Creator

## 目标

把用户需求落成一个可加载的 PinPawo Capability，并在需要时继续修改它。

## 工作流程

1. 先收敛职责边界：它负责什么、不负责什么、需要哪些 Toolkit。
2. 使用 \`scaffold_capability_plugin\` 快速创建文件骨架，但不要把默认输出当成最终实现。
3. 创建或大改前，使用 \`list_dir\` / \`view_file_chunk\` 阅读
   \`packages/pet-agent/examples/capabilities/web_research_brief/\` 完整示例。
   如果当前工作目录不是 PinPawo 仓库，先用 \`glob_search\` 定位示例。
4. 按示例改写 \`CAPABILITY.md\`、README 和测试，使其成为面向用户任务的
   完整执行协议。
5. 使用 \`validate_capability_plugin\` 检查加载契约，使用
   \`check_capability_keywords\` 检查自然语言 query 能否发现它。

## 契约边界

- \`CAPABILITY.md\` 正文只描述该 Capability 自己的业务执行流程。
- 只有需要确定性整理已有执行结果时才声明 \`entry\`；entry 只能导出
  \`lifecycle.finalize\`。
- 所有模型调用的动作和外部业务副作用一律放入 Toolkit。
- 如果 Capability 需要 API、浏览器、文件或 shell 能力，在正文中明确首选
  工具和禁用 / 兜底条件。
- 优先从模板出发做局部改写，避免无意义重写整份文件。
- 如果需求仍然含糊，先给出清晰设计和待确认点，不展开复杂实现。`;
