export const capabilityCreatorInstructions = `# Capability Creator

## 目标

把用户需求落成一个可加载的 PinPawo Capability，并在需要时继续修改它。

## 工作流程

1. 先收敛可复用的职责边界：它负责什么、不负责什么、什么时候应被 Planner 选中。
2. 确定最小 Toolkit 权限集。只声明已在当前 host 注册且任务确实需要的 Toolkit；不需要工具时使用空 \`uses\`。
3. 调用 \`scaffold_capability_plugin\`。尽量在一次调用中传入定制的 \`workflow\`、
   \`boundaries\` 和 \`outputRequirements\`，生成的不应只是通用文件处理模板。
4. 如果目标目录已存在，先用 \`list_dir\` 和 \`view_file_chunk\` 读取现状，做局部修改；不要未读取就使用 \`overwrite\`。
5. scaffold 会自动做一次加载契约验证。手动修改后再调用
   \`validate_capability_plugin\`，然后检查 description、执行流程、边界和输出要求是否一致。

## 契约边界

- \`CAPABILITY.md\` 正文只描述该 Capability 自己的业务执行流程。
- \`description\` 是 Planner 的检索与路由入口，应包含用户会实际使用的意图词，但不夸大范围。
- 只有需要确定性整理已有执行结果时才声明 \`entry\`；entry 只能导出
  \`lifecycle.finalize\`。
- 所有模型调用的动作和外部业务副作用一律放入 Toolkit。
- 如果 Capability 需要 API、浏览器、文件或 shell 能力，在正文中明确首选工具和禁用 / 兜底条件，并在 \`uses\` 中声明对应 Toolkit。
- 优先从模板出发做局部改写，避免无意义重写整份文件。
- 如果需求仍然含糊，先给出清晰设计和待确认点，不展开复杂实现。`;
