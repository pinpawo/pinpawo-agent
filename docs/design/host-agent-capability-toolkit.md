# Host / Agent / Capability / Toolkit 领域关系与装配约束

> 状态：Accepted design；实现迁移由
> [issue #645](https://github.com/pinpawo/pinpawo-agent/issues/645) 跟踪
> 更新：2026-08-16

本文固定 Host、Agent、Capability 与 Toolkit 的领域关系，并约束 Chat Host、
Studio Host 和未来 Host surface 的装配方式。Capability / Toolkit 的当前公共类型
仍以 [Capability / Toolkit V2 契约](../reference/extensions/capability-toolkit.md)
为准；Toolkit 的执行环境依赖（ShellRS / BrowserRS）见
[Toolkit 的 RS 依赖](../reference/extensions/toolkit-rs.md)（#856）。

本文中的 inventory、execution boundary、Host Toolkit 协调器和统一诊断已按 #645
进入当前实现。当历史设计中的 `local tools`、
`host tools`、`capability-private tools`、Browser 专属 lifecycle/diagnostics 或
`BrowserIntegration` 与本文冲突时，只能把这些表述作为历史实现背景，不能据此
新增公共架构层。
Studio Host 已按 #643 提取为独立入口，不再嵌入 Chat Host (`LocalAgentHost`)。
Resident Pet 的双访问面及 local-agent 装配边界另见
[Resident Pet Host Ports](agent-runtime/resident-pet-host-ports.md)：Studio 只消费
dispatch，TUI 的直接对话通过独立 conversation adapter，不增加新的 Agent 领域角色。

## 1. 核心关系

系统只有四个需要在顶层讨论的领域角色：

```text
Host
  ├─ 读取配置并选择 Capability / Toolkit definitions
  ├─ 创建并持有一个或多个 Agent Runtime
  └─ 创建并持有 RS 实例（ShellRS、BrowserRS）
       └─ 按 Toolkit 的 requires 声明注入 Toolkit 工厂

Agent Runtime
  └─ 编译并执行 Capability
       └─ Capability.uses 解析 Toolkit
            ├─ tools / instructions / operation metadata / review policy
            └─ availability（依赖 RS 的 Toolkit 取自 RS.status()）
```

RS 不是与 Host、Agent、Capability、Toolkit 平级的扩展概念，也不进入 Agent 运行期：
Agent 只看到静态 Tool，Tool 在每次调用时用 Agent session（threadId）与 workdir
访问 Host 注入的 RS 实例。

## 2. 领域职责

### Host

Host 是进程或产品入口的装配边界。它负责：

- 读取 Host 配置，并据此选择 Capability 与 Toolkit definitions；
- 定义 inventory 的来源、优先级、重复名称失败规则和 provenance；
- 创建、持有和关闭 Agent Runtime；Studio Host 可以持有多个常驻 Agent Runtime；
- 创建并持有进程内 RS 实例，按 Toolkit 的 `requires` 声明注入；RS 启动失败只
  影响依赖它的 Toolkit 的 availability；
- 提供 transport、API、TUI/Web adapter、持久化 port 和全局 review mode 等
  Host concerns。

Host 不解释某个 Toolkit 的 backend、连接协议、工具语义或资源所有权，也不复制
RS 的内部状态（进程、输出、tab、target、CDP session）。

### Agent

Agent 是接收 invocation 并执行任务的运行单元。它负责：

- 使用同一个常驻 Chat runtime / graph 处理 invocation；
- 从编译后的 registry 选择并执行 Capability；
- 使用 Host 提供的同一份 workdir snapshot 构造 execution prompt 与 review context；
- 通过 `ToolRuntime.context` 传递 thread、run、delegation identity 和按 Toolkit name
  索引的 opaque Runtime ports，并通过 `ToolRuntime.signal` 传递 cancellation；
- 通过 Host 注入的通用 manager 获取 Toolkit execution bindings。

Agent 不读取 Host 配置，不拥有 Browser、shell、git 等专属生命周期，也不在
graph state 之外维护第二份 Toolkit 业务状态。Agent 运行期不创建、识别或管理
RS；它只看到静态 Tool。

### Capability

Capability 是面向业务目标的可委派行为单元，只拥有：

- 稳定名称和路由描述；
- Markdown instructions；
- required `uses`；
- 可选的确定性 finalize lifecycle。

Capability 不拥有 tools、backend、availability、workdir、Runtime 或 Host 配置。
需要执行编码动作时，必须通过 `uses` 引用 Toolkit。

### Toolkit

Toolkit 是可执行能力和工具策略的唯一归属，负责：

- tools 与工具族 instructions；
- operation metadata；
- 单个工具的 review requirement / policy；
- Toolkit availability；
- 可选的 RS 依赖声明（`requires`），仅供 Host 装配。

Host 配置中的全局 review mode 仍属于 Host Configuration；Toolkit 只声明工具级
规则。Human review 的请求/响应属于 Agent 与交互边界，不能因此把全局配置或
交互状态搬进 Toolkit。

`StudioPlugin` 是 Studio control-plane 扩展形态，不是第五个 Agent 扩展领域，也不是
`AgentToolkit` 的子类型。它可以通过 `toolkits` 定义出口声明零个或多个 Toolkit；Host 将
它们纳入统一 inventory，Agent 侧再由 `Capability.uses` 选择。Plugin lifecycle 只使用
Studio context 的 dispatch、event 与 hook，不能参与 Capability 选择或 Pet runtime 装配。详见
[Studio Independent Host Runtime](studio/independent-host-runtime.md)。

Capability 完全属于 Agent。Plugin 和 Studio 都不得注册、贡献或隐式附带 Capability；
即使某个 Capability 会使用 Plugin 定义的 Toolkit，也必须由 Agent Host 独立装配。
Studio Host 根据 `petId` 从
`pets/<petId>/capabilities/<capability>/CAPABILITY.md` 严格加载。目录成员同时表达
该 Pet 的定义来源与选择，不再通过 Pet JSON 名称列表或 Plugin resolver 装配。
不同 Pet 的 Capability registry 相互隔离；`general` 仍由 Agent Host 作为 baseline
提供。

## 3. 静态定义、选择、可用性与运行状态

以下概念必须分开，不能统一称为 `enabled` 或“可用”：

```text
Toolkit definitions
  -> Host config selection
  -> selected Toolkit definitions
  -> start optional Runtime roots
  -> Toolkit availability evaluation
  -> effective Toolkit inventory
  -> compile Capability bindings
```

- **Host config selection**：产品配置是否选择某个 Toolkit definition，归 Host。
- **Toolkit availability**：该 Toolkit 的静态契约在当前环境能否成立，归 Toolkit。
- **Runtime diagnostics**：已选择 Toolkit 的 Runtime 当前是否 ready/degraded/failed，
  是实时观测，不改变 Capability 的静态权限含义。
- **Runtime root / execution binding**：动态资源，不进入 inventory、Supervisor workspace、
  prompt 或 checkpoint。

Inventory 合并必须是确定性的：来源和顺序可追溯，重复 Capability/Toolkit 名称
必须显式失败，不能依赖“最后一个覆盖”或让不同入口各自重算。

## 4. RS 状态

旧的 `ToolkitRuntimeManager` 统一诊断已随 #856 删除。每个 RS 实例通过
`status()` 报告可用性与可诊断原因；Host 的 `getRSStatus()` 汇总其创建的实例，
不按 Toolkit 名称分支。RS 内部的恢复策略与资源状态由 RS 自己管理。

## 5. Browser 与 local-machine Toolkit 的归位

Browser、bash、git 都是普通 Toolkit：

- Browser backend/driver、bridge、session、ownership 和 live state 属于
  `ChromeExtensionBrowserRS`；Browser Capability 只声明 `uses: ['browser']`。
- Browser 包分别导出 Capability、Toolkit 工厂、BrowserRS 契约与实现。local-agent 的
  composition root 根据 Host 配置创建 RS 实例并装配 Toolkit；bash、git、
  project-inspection 共享一个 `PosixShellRS`。
- 当前所谓 `local tools` 不是领域概念。它们是 local-machine / Node Host 提供的
  Toolkit definitions；CLI 只是其中一类 Host 入口。
- `bash` 当前包含文件、搜索、JSON、网络、shell、process 等工具，`git` 同时包含
  本地 git 与 GitHub 操作。后续是否拆分必须按 authority、availability、review
  policy 和 RS 依赖决定，不能按目录或现有名称机械拆分。
- operation registry 必须由最终 Toolkit definitions 派生，不能维护一份平级的
  flat tools inventory。

## 6. 架构一致性约束

以下规则适用于 Chat Host、Studio Host 和未来 Host surface：

1. 新 Capability 只需要注册定义和 `uses`，不应修改 Host lifecycle。
2. 新 Toolkit 只需要注册定义及可选 Runtime，不应修改 Agent graph 或 Host 的
   Toolkit-name 分支。
3. 所有暴露给 Capability subagent 的可执行业务/外部 Tool 必须归属一个 Toolkit；
   不存在 direct host tools、capability-private tools 或与 Toolkit 平级的
   LocalTools。Run Supervisor 的框架内部 control action 不属于扩展 inventory，
   不应为了形式统一伪装成 Host Toolkit；具体 command contract 由
   [Root、Supervisor 与 Capability 的状态与交接](agent-runtime/run-scoped-supervisor-session.md)
   统一定义。
4. Host 将同一份 workdir snapshot 提供给 Agent prompt 与 review/authorization
   context。Tool 的 path、cwd、command 等参数由模型决定并保持原样；不得为了
   workdir scoping 引入审核前改写 Tool 输入的阶段。Toolkit 在执行时用原始参数
   与 Host 提供的执行上下文解释相对路径和默认 cwd。
5. shutdown 一个 Host 只释放它自己创建的 RS 实例，不能释放另一个 Host 的进程或连接。
6. Chat 与 Studio 使用相同领域模型。Studio 只改变 Host 如何配置、持有和 invoke
   多个常驻 Agent Runtime，不创造 Studio 专属 Tool/Toolkit/Runtime 体系。
   Chat Host (`LocalAgentHost`) 和 Studio Host (`StudioHost`) 是两个独立的
   package / 装配入口；Chat CLI 不再通过 `--mode` 分流创建 Studio。
   两个 Host 共享能力供给（toolkit / capability / model）以及 checkpointer 的装配方式。
   local-agent 通过中性的 `host-runtime` 子路径暴露 `HostCapabilityAssembly`，Studio
   复用该 Host 装配能力而不复制代码；具体 local wire adapter 则通过独立的
   `local-server-transport` 子路径暴露，不属于 Host runtime，也不是 Studio core API。
   两个 Host 各自持有独立 checkpoint root，不共享 writer ownership、transport
   composition 或 Chat session state。依赖方向只能是 Studio → local-agent public
   surfaces；local-agent Chat 路径不得反向 import Studio。
7. Studio Host 只声明 `StudioPluginResolver` port，不静态 import kanban、scheduler
   或其他具体 Plugin。Plugin 实现可以依赖 Studio contract，并由应用 composition root
   注入；“配置中出现 Plugin id”不等于 Studio package 依赖该 Plugin。Resolver 只返回
   Plugin，不返回 Capability；Plugin 定义的 Toolkit 必须在 resident Pet 构建前进入
   Host 的统一 inventory。Agent Capability 由 Studio Host 按 `petId` 从约定目录加载，
   每个 Pet 的目录成员直接表达其定义与选择。
8. BrowserIntegration、BrowserProvider、LocalTools 或 RuntimeEnvironment 不能作为
   新的公共架构层；普通构造辅助不得反向定义领域模型。
9. 如果实现需要改变稳定的 Pet Agent Chat graph、wire、checkpoint、Capability
   行为或 review policy，必须单独说明影响并获得明确确认。

## 7. 文档用词约束

新文档和代码评审统一使用：

- `Host`：产品/进程装配与所有权边界；
- `Agent Runtime`：常驻、可反复 invoke 的 Agent 执行单元；
- `Capability`：业务行为与 `uses`；
- `Toolkit`：tools、工具策略、availability 和可选的 RS 依赖声明；
- `RS`（ShellRS、BrowserRS）：持有执行环境与按 Agent session 划分的交互状态，由 Host
  创建并注入 Toolkit；
- `local-machine Toolkit` 或 `local Host built-in Toolkit`：取代含糊的
  `local tools` / `CLI tools`。

`runtimeEnvironment` 已用于传给模型的 Host 环境说明字符串，不得复用为新的资源
装配对象名称。尚未有必要把本模型包装成新的公共 `HostAgentEnvironment` 类型；
先以职责和契约约束实现，等至少两个 Host 的真实调用方稳定后再提取公共类型。
