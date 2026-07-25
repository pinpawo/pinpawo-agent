# Pet Agent Toolkit Composition Design

> 状态：Historical。V2 使用 Toolkit-owned `ToolDefinition` 和静态 required
> `AgentCapability.uses`；下文 Toolset / `createRuntime` 示例不再有效。
> 日期：2026-05-14
> 后续方向：本文保留 Toolkit 组合的历史理由。已接受的目标契约见
> [Capability / Toolkit Contract V2](./PET_AGENT_CAPABILITY_TOOLKIT_V2_DESIGN.md)，
> 其中 Capability 只能通过静态强依赖 `uses` 获得 Toolkit，并删除 Toolset。

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
  一组相关 tools + instructions + availability。
  例如 browser toolkit、bash toolkit、memory toolkit、web_search toolkit。

capability
  面向业务目标的可委派能力。
  通过 uses 组合 toolkit，再叠加自己的业务 tools、instructions、resultSchema。

orchestrator
  唯一编排者，决定委派哪个 capability，以及多个 capability 的先后顺序。
```

核心规则：

- toolkit 不是可委派目标，只是可复用工具包。
- capability 才是 orchestrator 的委派目标。
- subagent 不直接调用其他 subagent 或 capability。
- capability 之间的数据流只经过 orchestrator：`A result -> orchestrator state/context -> B task/context_summary`。

## 3. 为什么不是 capability extends capability

`extends` 容易让人以为继承整个 capability，包括 description、availability、instructions、tools、middleware、resultSchema 和执行语义。

这会产生几个问题：

- resultSchema 难合并：A extends B 时，B 的结构化结果是否属于 A 的结果。
- prompt 隐式耦合：修改 B 的 instructions 可能影响所有继承者。
- 权限边界变模糊：继承的是工具权限还是完整执行权。
- 容易演化成 subagent 嵌套调用，破坏 orchestrator 的唯一编排职责。

所以使用组合语义：

```ts
createRuntime: () => ({
  uses: ['browser', 'bash'],
  tools: businessTools,
  instructions: businessInstructions,
})
```

`uses` 表示 capability 需要哪些 toolkit，而不是继承其他 capability。

## 4. 运行时装配

orchestrator 创建 subagent 前完成 toolkit 解析：

```txt
capability.createRuntime()
  -> runtime.uses
  -> resolve toolkits
  -> tools = declared toolkit tools + capability.tools
  -> instructions = handoff + toolkit.instructions + capability.instructions
  -> createSubagent(...)
```

旧设计曾让 general lane 使用所有已注册 Toolkit：

```txt
general fallback Capability
  tools = global tools + all toolkit tools
  instructions = handoff + all toolkit instructions + general instructions
```

capability lane 只使用自己声明的 toolkit：

```txt
capability subagent
  tools = declared toolkit tools + capability tools
  instructions = handoff + declared toolkit instructions + capability instructions
```

当前模型不再保留这条差异：`general` 是普通 fallback Capability，和其他
Capability 一样，只有显式声明 `uses` 时才接收对应 Toolkit。

## 5. Toolkit Policy 与 HITL

> 最新的通用 HITL policy preset 设计见
> `docs/TOOLKIT_HITL_POLICY_PRESETS_DESIGN.md`。本节保留 toolkit policy
> wrapper 的原始分层说明；preset 的职责边界以后者为准。

toolkit 可以为工具声明 human review policy。policy 不改变模型看到的工具形态：工具名、描述和 schema 保持不变，运行时在 toolkit 装配阶段把原始工具包一层 wrapper。

这层 policy 只回答一个问题：这次 tool call 是否需要 human review。它不负责决定“工具是否存在”，也不把“不允许”建模为 public state。工具面由 toolkit 装配决定；参数非法、硬性禁止的调用由 raw tool 自己返回错误。

```ts
const bashToolkit = {
  name: 'bash',
  tools: [runShellTool],
  policy: {
    toolReview: {
      run_shell: {
        request: ({ input }) => {
          if (!needsReview(input)) return null;
          return reviewSpec;
        },
        applyEdit: ({ editedAction }) => editedAction.args,
      },
    },
  },
};
```

wrapper 的职责：

- `request()` 返回 `null`：直接调用原始工具。
- `request()` 返回 `ReviewSpec`：wrapper 生成 canonical `review` interrupt payload，包含 `review`；tool action review 额外携带当前 `pendingAction`，恢复后读取人类决策。
- human `approve`：调用原始工具。
- human `edit`：V1 review options 不暴露 edit；后续如需要再以结构化 option/input 扩展。
- human `reject/respond`：不调用原始工具，返回结构化 cancelled 结果。

`ReviewSpec` 是 UI/runtime 的 canonical 交互协议；旧 request adapter 已移除。这样 shell、browser、filesystem 等工具族可以独立定义自己的 HITL 策略，同一个底层工具在不同 toolkit 中也可以有不同 review policy。

### Shell review 分层

shell policy 使用确定性规则做默认判断：

- 硬性禁止：保留在 `run_shell` raw tool 内，例如 `sudo`、`git reset --hard`、heredoc、输出重定向写文件。
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
const browserToolkit = {
  name: 'browser',
  description: '浏览器网页访问、登录态复用、JS 渲染页面读取、点击输入等待和页面内容提取。',
  tools: [browser_open, browser_click, browser_extract],
  instructions: [
    '优先使用 browser_open 打开目标页面。',
    '需要登录、验证码或手动操作时保持可见浏览器窗口。',
  ],
};

const browserCapability = {
  name: 'browser',
  description: '使用本机浏览器打开网页、交互并提取内容。',
  createRuntime: () => ({
    uses: ['browser'],
    instructions: ['你是浏览器任务执行器。'],
  }),
};
```

当用户直接要求浏览器操作时，orchestrator 委派 `browserCapability`。

当其他业务 capability 需要浏览器时，它声明：

```ts
createRuntime: () => ({
  uses: ['browser'],
  instructions: ['读取网页内容后，整理成趋势摘要。'],
})
```

它不会调用 `browserCapability`，只复用 `browserToolkit`。

## 7. Bash 示例

bash 也作为 toolkit，而不是一个必须独立委派的 capability：

```ts
const bashToolkit = {
  name: 'bash',
  description: '本地文件读写、目录操作、代码搜索、补丁应用和受控 shell 命令执行。',
  tools: [read_file, view_file_chunk, grep_search, apply_patch, run_shell],
  instructions: [
    '优先使用语义具体的文件工具。',
    'run_shell 只作为兜底工具。',
    '高风险 shell 命令必须走 toolkit policy 的人类审批流程。',
  ],
  policy: {
    toolReview: {
      run_shell: shellReviewPolicy,
    },
  },
};
```

能力示例：

```ts
const capabilityCreator = {
  name: 'capability_creator',
  createRuntime: () => ({
    uses: ['bash'],
    tools: [scaffold_capability_plugin, validate_capability_plugin],
    instructions: capabilityCreatorInstructions,
  }),
};
```

## 8. 边界约束

- toolkit 不应该包含业务 resultSchema。
- toolkit instructions 只描述工具族的正确使用方式，不描述具体业务目标。
- capability instructions 描述业务目标、结果格式和任务约束。
- orchestrator 仍然是唯一可以决定“下一步委派谁”的组件。
- 如果多个 capability 高频组合成固定流程，应创建更高阶 workflow capability，而不是让 capability 互调。

## 9. 当前实现

当前实现已支持：

- `AgentToolkit` 类型。
- `CapabilityRuntime.uses`。
- invoke/configurable 中传入 `toolkits`。
- browser toolkit + browser capability 薄包装。
- bash toolkit，封装 local-agent 的本地文件和 shell 工具。
- `general` fallback Capability 只装配其 `uses` 声明的 Toolkit tools。
- capability lane 按 `uses` 装配 toolkit tools。
- toolkit policy wrapper 可对单个工具调用执行 allow/deny/HITL review。

后续可以继续演进：

- 按权限拆分 `bash.readonly`、`bash.write`、`bash.shell`。
- 在 UI/日志中展示 subagent 使用了哪些 toolkit。
