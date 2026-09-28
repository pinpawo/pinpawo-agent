# 仅贡献说明的 Toolkit

> 状态：Draft，待实现评审；更新：2026-09-28

## 动机与边界

Studio Plugin 需要向指定 Pet 的 Capability 提供共享阅读约定，例如引导执行
agent 从 `wiki/PROJECT.md` 了解项目。复用 `AgentToolkit.instructions` 与
`Capability.uses`，无需新增 system prompt 注入 API，也不重复写入每个 PET.md。

Toolkit 必须显式提供 `tools` 数组；允许 `tools: []`，但此时 `instructions`
必须是非空白字符串。有工具的现有 Toolkit 不变。完全空的 Toolkit 仍然无效。

## 执行路径

Plugin 注册 Toolkit → Host inventory → Capability.uses 编译 → 执行时注入
`toolkit:<name>` system prompt section。现有装配与执行路径保留零工具 Toolkit；
本次实现只放宽定义校验，不增加另一条注入通路。

说明只影响引用 Toolkit 的 Capability，不进入未引用它的 Capability 或成为
PET.md 那样的 Pet 根上下文。它不授予任何工具能力；需要读文件时，Capability
应另外引用具有读取工具的 Toolkit。仍遵守现有 availability 与依赖缺失规则。

注入的是 Plugin 作者提供的静态说明，不是 Wiki 正文。文件仍由执行 agent
按需读取；不新增动态 instructions 回调、自动文件加载、全局提示词 hook，
也不在本次修改默认 Studio 的 Wiki Plugin 或各 Pet 配置。

## 验证与迁移

验证空数组配有效说明可注册；缺少数组、非法说明、空白说明加空数组仍被拒绝。
通过真实 orchestrator 执行和动态标记检查说明进入模型 system message，
且只进入声明了 uses 的 Capability，不进入持久对话消息。

已有 Toolkit 无需迁移。Plugin 作者可新增纯说明 Toolkit，目标 Capability
显式引用即可。此草案需经实现评审后再决定是否提升为正式设计。
