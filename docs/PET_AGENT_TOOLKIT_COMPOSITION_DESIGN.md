# Capability / Toolkit 组合设计

> 状态：Implemented V2
> 更新：2026-07-27

本文解释为什么 Capability 通过 Toolkit 组合，而不是互相继承或调用。公共类型、
编译规则和 host 组装顺序以
[Capability / Toolkit V2 契约](./PET_AGENT_API_CAPABILITY_TOOLKIT.md)为准。

## 1. 背景

capability 之间会出现复用需求。例如：

- `browser` 能力本身可以作为独立委派目标，处理打开网页、复用登录态、点击输入和提取页面内容。
- 其他业务 capability 也可能需要浏览器工具，例如调研网页、抓取渲染后的内容、登录后读取平台数据。
- `bash`/本地文件工具也是类似情况：它既是通用执行能力，也会被 capability creator、代码编辑、文件整理等能力复用。

如果让 capability A 直接调用 capability B，会把 subagent 变成递归 orchestrator，带来路由权、权限、状态、结果协议和观测链路的混乱。

因此新增一层 **toolkit**，用于表达“工具族复用”，而不是“capability 互相调用”。

## 2. 分层模型

系统分为四层：

```txt
tool
  最小可调用动作，例如 browser_open、read_file、run_shell。

toolkit
  一组相关 ToolDefinition + instructions + availability。
  例如 browser toolkit、bash toolkit、memory toolkit、web_search toolkit。

capability
  面向业务目标的可委派能力。
  通过静态 uses 组合 toolkit，并提供自己的 Markdown instructions 与 lifecycle。

orchestrator
  唯一编排者，决定委派哪个 capability，以及多个 capability 的先后顺序。
```

核心规则：

- toolkit 不是可委派目标，只是可复用工具包。
- capability 才是 orchestrator 的委派目标。
- subagent 不直接调用其他 subagent 或 capability。
- capability 之间的数据流只经过 orchestrator：`A result -> orchestrator state/context -> B task/context_summary`。

## 3. 为什么不是 capability extends capability

`extends` 容易让人以为继承整个 Capability，包括 description、instructions、
Toolkit 权限、lifecycle、artifact 语义和执行方式。

这会产生几个问题：

- 结果语义难合并：A extends B 时，B 的 artifact 和 announce 是否属于 A 的交付。
- prompt 隐式耦合：修改 B 的 instructions 可能影响所有继承者。
- 权限边界变模糊：继承的是工具权限还是完整执行权。
- 容易演化成 subagent 嵌套调用，破坏 orchestrator 的唯一编排职责。

所以使用组合语义：

```ts
defineCapability({
  uses: ['browser', 'bash'],
  instructions: businessInstructions,
})
```

`uses` 表示 capability 需要哪些 toolkit，而不是继承其他 capability。

### 场景扩展的含义

“扩展一套属于自己的 Capability，并组合不同场景”在 V2 中拆成两个明确动作：

- 业务场景变化：新增或改写 Capability 的 description / Markdown instructions。
- 可执行能力变化：在 `uses` 中组合已有 Toolkit，或编码实现一个新的 Toolkit。

多个 Capability 可以声明相同 Toolkit。共享 Markdown 片段可以在构建时用普通
代码或文档模板复用，但 runtime 不提供 `Capability extends Capability`；
否则 instructions、路由语义和工具权限会重新耦合在一起。

`uses` 只有 required 语义，没有 `optionalUses`。如果一个降级实现仍满足同一个
Toolkit 的语义契约，可以由 Toolkit factory 在内部选择实现；如果降级后的能力
已经不能完成原任务，就应让 Capability 明确不可用，而不是给模型暴露一个名义上
存在、实际能力不同的 Toolkit。

## 4. 运行时装配

orchestrator 创建 subagent 前，从已编译 registry 完成 toolkit 解析：

```txt
capability.uses
  -> resolve toolkits
  -> tools = declared toolkit tools
  -> instructions = framework + actor + toolkit.instructions
                    + capability.instructions + host runtime environment
  -> createSubagent(...)
```

当前任务通过 delegation briefing message 进入私有 lane，不重复进入稳定 system
prompt。Toolkit instructions 按 `uses` 的解析顺序装配。

General 不使用独立 lane 或隐式工具面。它是一个名为 `general` 的普通
Capability，显式声明自己的 Toolkit 依赖：

```txt
services/local-agent/src/capabilities/general/
├── CAPABILITY.md
└── index.ts
```

该目录和其他内建 Capability 通过同一注册入口进入 runtime。`CAPABILITY.md`
静态声明完整 `uses`；registry 不追加、过滤或改写 General 的依赖。
Capability Planner 通过与其他 Capability 相同的文档探索与选择流程决定是否
使用 `general`。之后仍然统一使用：

```txt
lane = capability:general
tools = tools from general.uses
instructions = framework + declared Toolkit instructions + general instructions
```

`general` 是 local-agent host 的保留名，用户 Capability 不能覆盖它。

所有 Capability 都只使用自己声明的 Toolkit：

```txt
capability subagent
  tools = declared toolkit tools
  instructions = handoff + declared toolkit instructions + capability instructions
```

Toolkit 注册不等于授权。只有 Capability 的 `uses` 才建立工具权限边界；
缺少任一 required Toolkit 时，该 Capability 在本次 registry generation 中不可用。
Toolkit `availability` 在编译前由调用入口或 host 解析；
`compileAgentRegistry()` 本身只编译传入的有效 inventory。单个 Capability 的依赖
解析失败进入 `unavailableCapabilities`，host 必须报告这份诊断。
因此 local-agent chat 的内部组装契约要求同时提供稳定 `threadId` 和
`CapabilityArtifactStore`；host 不能通过省略 thread scope 静默移除 General
或其他声明了 `artifact_discovery` 的 Capability。

Capability Planner 探索的是 compiled registry 物化出的只读 Capability Document
Workspace。Capability 的 `CAPABILITY.md` 是发现与选择依据；Toolkit scope 仍然是
执行期权限边界，并通过文档中的静态 `uses` 声明可见。Planner 不接收截断后的
registry context，也不使用代码关键词检索。

## 5. Toolkit Policy 与 HITL

> 最新的通用 HITL policy preset 设计见
> `docs/TOOLKIT_HITL_POLICY_PRESETS_DESIGN.md`。本节保留 toolkit policy
> wrapper 的原始分层说明；preset 的职责边界以后者为准。

toolkit 可以为工具声明 human review policy。policy 不改变模型看到的工具形态：工具名、描述和 schema 保持不变，运行时在 toolkit 装配阶段把原始工具包一层 wrapper。

这层 policy 只回答一个问题：这次 tool call 是否需要 human review。它不负责决定“工具是否存在”，也不把“不允许”建模为 public state。工具面由 toolkit 装配决定；参数非法、硬性禁止的调用由 raw tool 自己返回错误。

```ts
const bashToolkit = defineToolkit({
  name: 'bash',
  description: '本地文件、搜索和受控 shell 工具。',
  tools: [{
    tool: runShellTool,
    operation: { title: '执行命令' },
    review: {
      request: ({ input }) => {
        if (!needsReview(input)) return null;
        return reviewSpec;
      },
    },
  }],
});
```

wrapper 的职责：

- `request()` 返回 `null`：直接调用原始工具。
- `request()` 返回 `ReviewSpec`：wrapper 生成 canonical `review` interrupt payload，包含 `review`；tool action review 额外携带当前 `pendingAction`，恢复后读取人类决策。
- human `approve`：调用原始工具。
- human `edit`：V1 review options 不暴露 edit；后续如需要再以结构化 option/input 扩展。
- human `respond`：不调用原始工具，返回结构化 cancelled 结果并把用户补充作为新的规划指导。
- human `reject` / run interrupt：不调用本批任何工具；用 `RemoveMessage` 撤销承载整批 tool calls 的 AI action，不生成 synthetic cancelled `ToolMessage`，并保留 pending delegation 供显式 continuation。

`ReviewSpec` 是 UI/runtime 的 canonical 交互协议；旧 request adapter 已移除。这样 shell、browser、filesystem 等工具族可以独立定义自己的 HITL 策略，同一个底层工具在不同 toolkit 中也可以有不同 review policy。

### Shell review 分层

shell policy 使用确定性规则做默认判断：

- 硬性禁止：保留在 `run_shell` raw tool 内，例如 `sudo`、`git reset --hard`、破坏性系统命令和会等待交互式 stdin 的命令。命令自身携带内容的 heredoc 与输出重定向不是独立安全边界，其效果由 review policy 根据具体 command 和 scope 判断。
- 已授权或低风险：`request()` 返回 `null`，直接执行，例如普通只读命令，或当前会话已经授权的命令范式。
- 高风险：返回 `ReviewSpec`，例如删除文件、git 写操作、发布、部署、权限变更、远程脚本执行。
- 不支持 HITL 的执行界面：`request()` 返回 `null`，raw tool 返回“需要 human review”的确定性错误，不触发无法恢复的 interrupt。

如果未来引入模型判断，只能放在“中间敏感度”区间，并且建议只允许模型把调用升级为 review，不能把强制 review 或硬性禁止降级为直接执行。也就是说：

```txt
hard-blocked -> raw tool error
must-review  -> review
safe/authorized -> no review
ambiguous -> optional model classifier -> review or no review
```

模型判断可以复用 `ToolkitContext.models`，但它不应该成为唯一安全边界。

## 6. Browser 示例

browser 拆成两部分：

```ts
const browserToolkit = defineToolkit({
  name: 'browser',
  description: '浏览器网页访问、登录态复用、JS 渲染页面读取、点击输入等待和页面内容提取。',
  tools: [
    { tool: browser_open },
    { tool: browser_click },
    { tool: browser_extract },
  ],
  instructions: [
    '优先使用 browser_open 打开目标页面。',
    '需要登录、验证码或手动操作时保持可见浏览器窗口。',
  ].join('\n'),
});

const browserCapability = defineCapability({
  name: 'browser',
  description: '使用本机浏览器打开网页、交互并提取内容。',
  uses: ['browser'],
  instructions: defineInstructionDocument({
    content: '# Browser\n\n你是浏览器任务执行器。',
  }),
});
```

当用户直接要求浏览器操作时，orchestrator 委派 `browserCapability`。

当其他业务 capability 需要浏览器时，它声明：

```ts
defineCapability({
  name: 'trend_research',
  description: '读取网页内容并整理趋势摘要。',
  uses: ['browser'],
  instructions: defineInstructionDocument({
    content: '# Trend research\n\n读取网页内容后，整理成趋势摘要。',
  }),
});
```

它不会调用 `browserCapability`，只复用 `browserToolkit`。

## 7. Bash 示例

bash 也作为 toolkit，而不是一个必须独立委派的 capability：

```ts
const bashToolkit = defineToolkit({
  name: 'bash',
  description: '本地文件读写、目录操作、代码搜索、补丁应用和受控 shell 命令执行。',
  tools: [
    { tool: read_file },
    { tool: view_file_chunk },
    { tool: grep_search },
    { tool: apply_patch },
    { tool: run_shell, review: shellReviewPolicy },
  ],
  instructions: [
    '优先使用语义具体的文件工具。',
    'run_shell 只作为兜底工具。',
    '高风险 shell 命令必须走 toolkit policy 的人类审批流程。',
  ].join('\n'),
});
```

能力示例：

```ts
const capabilityCreator = defineCapability({
  name: 'capability_creator',
  description: '生成、修改并验证用户自定义 CAPABILITY.md 目录。',
  uses: ['bash', 'capability_creator'],
  instructions: defineInstructionDocument({
    content: capabilityCreatorInstructions,
  }),
});
```

## 8. 边界约束

- Toolkit 不应该包含业务 artifact/result lifecycle。
- toolkit instructions 只描述工具族的正确使用方式，不描述具体业务目标。
- capability instructions 描述业务目标、结果格式和任务约束。
- orchestrator 仍然是唯一可以决定“下一步委派谁”的组件。
- 如果多个 capability 高频组合成固定流程，应创建更高阶 workflow capability，而不是让 capability 互调。

## 9. 当前实现

当前实现已支持：

- `AgentToolkit` 类型。
- `AgentCapability.uses`。
- invoke/configurable 中传入 `toolkits`。
- browser toolkit 与使用它的 capability。
- bash toolkit，封装 local-agent 的本地文件和 shell 工具。
- General 作为普通 Capability，按自己的 `uses` 装配 toolkit tools。
- 所有 delegation 统一使用 `capability:<name>` lane 和 capability executor node。
- toolkit policy wrapper 可对单个工具调用执行 allow/deny/HITL review。
- 单个 Capability 编译失败的隔离诊断，以及 registry 级重复名称的 fail-fast。
- Capability 目录的 `CAPABILITY.md` authoring，以及可选的 finalize-only
  lifecycle entry。

Capability V2 把所有 delegation lane 收敛为 `capability:<name>`。local-agent
不解释旧 `general` lane checkpoint，而是使用新的
`checkpoints-capability-v2` / `checkpoints-tui-capability-v2` durable state
namespace；artifact storage 仍按原 thread scope 保持连续。

后续可以继续演进：

- 按权限拆分 `bash.readonly`、`bash.write`、`bash.shell`。
- 在 UI/日志中展示 subagent 使用了哪些 toolkit。
- 为更多 host surface 统一暴露同一份 compiled registry diagnostics，避免各自
  重算可用性。
