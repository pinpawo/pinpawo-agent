# Capability / Toolkit V2 契约

> 状态：Current
> 更新：2026-07-27
>
> 读者：Capability 与 Toolkit 作者、host 集成者。如果这是你第一次使用
> PinPawo Agent，请先阅读[Core Concepts](../../concepts/core-concepts.md)和
> [Architecture](../../concepts/architecture.md)。

本文是 `packages/pet-agent` 对 Capability / Toolkit V2 的公共契约说明。
Host、Agent、Capability、Toolkit 之间的 accepted ownership 与跨 Host 装配约束见
[领域关系设计](../../design/host-agent-capability-toolkit.md)。
工具审核策略与恢复见[Review 设计](../../design/agent-runtime/review.md)，目录插件格式见
[Capability 目录协议](capability-directory.md)。

## 1. 核心模型

```text
ToolDefinition
  └─ 组成 AgentToolkit（编码实现、不可委派）
       └─ 被 AgentCapability.uses 静态引用
            └─ 编译为 CompiledCapability
                 └─ 由 Run Supervisor 选择并在独立 subagent 中执行
```

只有两个扩展概念：

- **Capability**：面向业务目标的可委派执行单元。
- **Toolkit**：编码实现的工具、共享说明和工具级策略集合；可仅提供说明。

Capability 不继承或调用另一个 Capability。多个场景需要复用工具能力时，
通过 `uses` 组合 Toolkit；多个 Capability 的先后关系由 orchestrator 编排。

组合只复用工具能力，不继承其他 Capability 的 instructions、权限或结果生命周期。
Toolkit instructions 描述工具族的使用方式或共享上下文指引，Capability instructions 描述任务约束和
结果要求；具体任务通过 delegation briefing 传入。Toolkit 不拥有业务交付生命周期。
这样避免修改一个 Capability 时隐式改变其他 Capability 的提示或权限。

## 2. Capability

### 2.1 契约

```ts
type AgentCapability = {
  readonly name: string;
  readonly description: string;
  readonly uses: readonly string[];
  readonly instructions: InstructionDocument;
  readonly lifecycle?: {
    finalize?: CapabilityFinalizeHook;
  };
};

type InstructionDocument = {
  readonly content: string;
  readonly digest: string;
};
```

字段语义：

- `name`：稳定 route id；使用小写字母、数字、`_` 或 `-`。
- `description`：Capability 文档的摘要，帮助 Supervisor 判断是否继续阅读正文。
- `uses`：required Toolkit 列表，也是该 Capability 的完整工具权限边界。
- `instructions`：一个非空 Markdown 文档；digest 由
  `defineInstructionDocument()` 生成并校验。
- `lifecycle.finalize`：可选的确定性收尾 hook，用于整理已有执行结果、
  调整本次 `output`；context 的 `messages` 是只读输入。

`uses` 可以是空数组，此时 Capability 是 instructions-only，但仍然通过同一
subagent 执行路径运行。V2 没有 optional Toolkit 依赖：声明在 `uses` 中就表示
缺少它时该 Capability 不可用。

### 2.2 代码定义

```ts
const inspect = defineCapability({
  name: 'inspect',
  description: '检查代码库并整理证据。',
  uses: ['files', 'shell', 'git'],
  instructions: defineInstructionDocument({
    content: '# Inspect\n\n只读取并总结与当前任务相关的内容。',
  }),
});
```

代码形式适合内建 Capability、需要注入确定性 `finalize` 的 Capability，以及
由 host 在启动时组装的定义。Capability 本身不能声明 tools；需要编码实现的动作
必须进入 Toolkit。

### 2.3 目录定义

```text
inspect/
├── CAPABILITY.md
└── index.js        # 可选；只能导出 lifecycle.finalize
```

```md
---
name: inspect
description: "检查代码库并整理证据。"
uses:
  - files
  - shell
  - git
version: 1
---

# Inspect

只读取并总结与当前任务相关的内容。
```

`CAPABILITY.md` 同时承载路由 metadata、Toolkit 权限声明和 Markdown
instructions。纯 Markdown 与带 `finalize` 的目录 Capability 使用同一个
`AgentCapability` 契约；它们不是两类 runtime。

`description` 应使用 YAML 双引号字符串；内容包含 `:`、`#`、引号或前后空白时，
需要按 YAML 字符串规则正确引用和转义。解析器继续接受早期 v1 loader 生成或
读取过的未引用 description，但新文档不应依赖该兼容语法。

`uses` 的 block list 使用空格缩进，不使用 Tab；Tab 兼容仅用于读取已有 v1 文档。

## 3. Toolkit

### 3.1 契约

```ts
type AgentToolkit = {
  readonly name: string;
  readonly description: string;
  readonly tools: readonly ToolDefinition[];
  readonly instructions?: string;
  readonly availability?: ToolkitAvailabilityCheck;
  readonly reviewGuidance?: ToolkitReviewGuidance;
  readonly requires?: Readonly<Record<string, ToolkitRSRequirement>>;
};

type ToolDefinition = {
  readonly tool: NamedStructuredTool;
  readonly operation?: ToolOperationMetadata;
  readonly review?: ToolReviewPolicy;
};
```

字段语义：

- `name` / `description`：Toolkit 的稳定身份和能力范围。
- `tools`：可执行的 LangChain Structured Tool 数组，必须显式提供；有非空白
  `instructions` 时允许为 `[]`。工具与说明不能同时为空。
- `instructions`：工具族的使用规则或共享上下文指引，会进入使用该 Toolkit 的
  subagent system prompt。仅提供说明不会授予文件读取或其他工具能力。
- `availability`：host 组装本次 registry generation 前执行的可用性检查。
- `reviewGuidance`：Toolkit 提供给全局 review 判断的允许/询问边界。
- `requires`：可选的执行环境（RS）依赖声明，只供 Host 装配使用；见
  [Toolkit 的 RS 依赖](toolkit-rs.md)。
- `ToolDefinition.operation`：工具调用的展示和摘要 metadata。
- `ToolDefinition.review`：单个工具的确定性 review policy。

仅贡献说明的 Toolkit 可用于提供 Wiki 入口等阅读约定：

```ts
const projectKnowledge = defineToolkit({
  name: 'project-knowledge',
  description: '项目知识入口与阅读约定。',
  tools: [],
  instructions: '需要项目背景时，先阅读当前工作目录下的 wiki/PROJECT.md，再按链接阅读相关页面。',
});
```

Plugin 将它加入 `toolkits`，目标 Pet 的 Capability 在 `uses` 中引用
`project-knowledge`，并同时引用提供文件读取能力的 Toolkit。只有引用它的
Capability 执行时才注入说明；不会自动读取入口文件，也不会将说明提升为 Pet
全局上下文。方案边界见[设计草案](../../design/toolkits/instructions-only.md)。

Toolkit 必须由代码定义；它不是 Markdown skill，也不是 orchestrator 的委派目标。

```ts
const shellToolkit = defineToolkit({
  name: 'shell',
  description: '执行 shell 命令与托管长任务。',
  tools: [{
    tool: createRunShellTool(shell),
    operation: { title: '执行命令' },
    review: shellReviewPolicy,
  }],
  instructions: '短查询用免审批的 inspect_shell；run_shell 只作为兜底。',
  requires: { shell: SHELL_RS_REQUIREMENT },
});
```

LangChain Tool 可能包含可变运行时内部状态。registry 会冻结
`ToolDefinition` 绑定和 metadata，但保留原始 Tool 实例身份；host 必须约定在
一个 registry generation 内不修改已注册 Tool 的 `name`。

### 3.2 执行环境依赖（RS）

需要实际执行环境和跨调用交互状态的 Toolkit（shell 进程、浏览器标签）不自己持有
生命周期，而是通过类型化工厂接收 Host 注入的 RS 实例，并在 `requires` 中声明契约、
版本和 `agent-session` 会话绑定。框架只校验声明格式，运行期不创建、识别或管理 RS；
Tools 是静态的，每次调用从 `ToolRuntime.context.executionScope` 读取 Agent session
（threadId）与 workdir，并把它们交给 RS。

RS 的 `status()` 是依赖它的 Toolkit 的可用性来源。完整契约、ShellRS / BrowserRS
语义与 Host 装配见 [Toolkit 的 RS 依赖](toolkit-rs.md)。

### 3.3 可用性

`compileAgentRegistry()` 只负责编译传入的有效 Toolkit inventory，不执行
`availability`。调用入口或 host 必须先解析可用性：

```text
Host RS instances started (failures stay in their status)
  -> Toolkit definitions assembled with injected RS instances
  -> evaluate/filter availability for this generation
  -> compileAgentRegistry(effective Toolkits, Capabilities)
```

`runAgent()` 和 pet runtime 会为各自的异步 registry generation 调用
`filterAvailableToolkits()`；host 可以对同一个 Toolkit 实例缓存检查结果，
并通过显式 refresh 重新检查。无论 host 采用哪种刷新策略，编译器看到的都必须是
本次 generation 的完整有效 Toolkit 集合。

如果某个环境可以用另一种实现提供**相同语义**的 Toolkit，fallback 可以封装在
Toolkit factory 内。不能为了让 Capability 看起来可用而注册一个不满足同名
Toolkit 契约的空壳实现。

### 3.4 Host 内置 Toolkit

本机 Host 内置的 Toolkit 按作用对象划分（#907）。Capability 在 `uses` 中按需
组合；审核按工具或按调用在 Toolkit 内部决定，原则见
[风险控制原则](../../design/agent-runtime/review.md)。

| Toolkit | 工具 | 依赖与可用性 | 审核 |
|---|---|---|---|
| `files` | `read_file`、`view_file_chunk`、`stat_path`、`list_dir`、`validate_structured_file`、`write_file`、`apply_patch`、`move_path`、`copy_path`、`mkdir_path` | Host 进程内执行，不依赖 RS，始终可用 | 读免审核；写审核（`apply_patch` 改 workdir 内已有文件时自动通过） |
| `shell` | `inspect_shell`、`run_shell`、`start_process`、`wait_process`、`list_processes`、`terminate_process`、`get_current_time` | ShellRS | `inspect_shell` 免审核加底线黑名单；`run_shell` / `start_process` 审核 |
| `web` | `http_fetch`、`download_file` | Host 进程内执行，不依赖 RS，始终可用 | 审核（`http_fetch` 按 origin 与方法复用授权） |
| `git` | `git_add`、`git_commit`、`git_push` | ShellRS | 免审核：schema 排除隐式 `git add .`、强推和删除远端引用 |
| `github` | `gh_pr_create`、`gh_issue_create` | ShellRS | 免审核 |
| `project-inspection` | 上述各 Toolkit 声明的只读子集 | ShellRS | 全部免审核 |

`project-inspection` 不维护自己的工具清单：files、shell 在各自模块里声明只读
子集，它直接组合这些子集，新增的只读工具会自动加入。

git 和 GitHub 的查看经 `inspect_shell` 运行 `git` / `gh`；git、github Toolkit 只提供
参数结构排除了危险形式的写工具，其他 git/gh 写操作经 `run_shell` 并审核
（2026-10-27 起，原来的查看工具、`git_shell`、`gh_shell` 等已删除）。因此
`uses` 里只有 `git` 或 `github` 的 Capability 只能做这几个写操作，看不了状态、
diff、PR 或 issue；需要查看或其他 git/gh 操作时必须显式加上 `shell`。Registry
不会替 Capability 补上 `shell`，`uses` 仍是完整的权限边界。

#### 从 git / github 查看工具迁移

| 原来用到的工具 | 新 `uses` |
|---|---|
| `git_status`、`git_diff`、`git_log`、`git_branch`、`git_show` | 加上 `shell`（经 `inspect_shell`） |
| `git_shell` | 加上 `shell`（经 `inspect_shell` 或 `run_shell`） |
| `gh_pr_view`、`gh_pr_diff`、`gh_pr_comments`、`gh_issue_list`、`gh_issue_view`、`gh_issue_comments`、`gh_read_content` | 加上 `shell`（经 `inspect_shell`） |
| `gh_shell` | 加上 `shell`（经 `inspect_shell` 或 `run_shell`） |
| 只用 `git_add`、`git_commit`、`git_push`、`gh_pr_create`、`gh_issue_create` | 不变 |

#### 从 `bash` 迁移

`bash` Toolkit 已删除，没有别名。`uses` 中仍写 `bash` 的 Capability 在 registry
编译时会被标记为不可用，诊断为 `unknown Toolkit "bash"`。

| 旧 `uses` | 新 `uses` |
|---|---|
| `bash` | `files`、`shell`、`web`，按需取其子集 |
| `git`，并使用 `gh_*` 工具 | `git`、`github`，查看和其他操作另加 `shell` |
| `git`，只用本地 git | `git`，查看和其他操作另加 `shell` |
| `project-inspection` | 不变 |

operation kind 随 Toolkit 名改变，例如 `bash.run_shell` 变为 `shell.run_shell`。

## 4. Registry 编译

Host 先组装完整定义，再编译：

```ts
const registry = compileAgentRegistry({
  capabilities,
  toolkits: availableToolkits,
});
```

编译流程：

```text
capability.uses
  -> 按声明顺序解析 required Toolkits
  -> 合并 ToolDefinitions
  -> 检查重复依赖、未知 Toolkit 和同一执行器内的重复 tool name
  -> snapshot Capability 与 Toolkit bindings
  -> 生成一个 CompiledCapability
```

约束与失败语义：

- 重复 Capability 名或 Toolkit 名是 registry 级配置错误，编译直接失败。
- 单个 Capability 的依赖或 tool 冲突只会把该 Capability 放入
  `unavailableCapabilities`，不会拖垮其他 Capability。
- `unavailableCapabilities` 是 host 必须消费的诊断，不应静默丢弃。
- 两个 Toolkit 可以包含同名 tool，只要没有任何一个 Capability 同时 `uses`
  它们；冲突按实际执行器组合检查。

`CompiledCapability` 固化了本 generation 使用的 Capability、Toolkits、tools 和
`toolNames`。执行与诊断应读取该编译结果，不再重新解释原始定义。

## 5. 发现、规划与执行

运行时会把已经成功编译的 Capability 物化为一个 digest-addressed、只读的
Capability Document Workspace。文件定义的 Capability 保留原始
`CAPABILITY.md`；inline Capability 会生成等价文档，因此 registry 中不存在
Supervisor 看不见的隐形 Capability。

Supervisor 是一个框架内部的 tool-loop agent。runtime 从 effective workspace
初始化一个包含 Capability 名称、职责摘要、搜索 cues，以及 compiled `uses`
解析出的 Toolkit 名称与描述的紧凑路由清单；Toolkit scope 作为 registry 事实
确定性保留，不受模型压缩结果影响。该清单帮助 Supervisor 选择候选；披露候选时以
canonical Capability name 作为稳定的 `capability_search` literal term，但该清单
不替代完整文档。
Supervisor 使用 `capability_search` 按需披露匹配的完整 `CAPABILITY.md`，再统一完成：

1. 划分当前与后续执行任务；
2. 为当前任务选择一个 workspace 内的 Capability；
3. 返回尚未开始的 future plan tail。

它不会把完整 registry、搜索结果或私有工具 transcript 写进父 graph state。
`allowedCapabilityNames` 只负责限制 workspace 可见范围，不直接指定执行器。
运行时随后确定性校验 Supervisor 输出：选中的名称必须存在于该 immutable
workspace，direct task 不得被改写，future plan 不得重复当前任务。

校验成功后统一进入：

```text
lane = capability:<name>
executor = compiled Capability
```

subagent system prompt section 的稳定顺序是：

1. framework delegation contract；
2. actor context；
3. `uses` 所解析 Toolkit 的 instructions；
4. Capability Markdown instructions；
5. host runtime environment（存在时）。

当前任务本身通过调用前临时生成的 delegation briefing 传入，不写进稳定
system prompt 或 checkpoint lane。subagent 只获得编译到该 Capability 的 tools。

## 6. General 是普通 Capability

`general` 是 well-known name，不是第三个框架概念：

- 使用普通 `AgentCapability` 契约；
- 通过普通注册入口进入 registry；
- 静态声明自己的 `uses`；
- 被选择为 `capability.general`；
- 运行在 `capability:general` lane；
- 使用统一 Capability executor。

General 使用与其他 Capability 相同的文档与选择证据。Agent 未另行配置时，只要它存在于
effective workspace，路由清单会将它标为默认候选；其完整文档仍通过与其他 Capability
相同的 `capability_search` 路径披露。Agent 也可通过 `defaultCapabilityName` 将另一个已注册且
可用的 Capability 设为默认候选；这只改变路由清单中的候选偏好，不会强制路由或创建独立 executor。代码没有 general fallback executor、
独立 lane 或单独的 General terminal action。

host 的内建 General 位于：

```text
services/host/src/capabilities/general/
├── CAPABILITY.md
└── index.ts
```

`general` 是 Host 的保留名，用户 Capability 不能覆盖。host
把它作为 host baseline；内建文档缺失或无效时 registry 初始化失败。pet-agent
core 仍允许显式受限 workspace 不包含 General，且不会凭空构造一个实现。

## 7. 旧 Artifact Pipeline 退役

旧 `CapabilityArtifactStore`、Host 本地 adapter 和 `artifact_discovery` Toolkit
已移除。运行时不再注入 `artifact_list` / `artifact_read`，也不再通过 finalize
保存或返回产物引用。旧实现保留为[历史资料](../../history/artifacts/pipeline/index.md)。
显式发布与下载属于 [Session Artifacts 草稿](../../design/agent-runtime/session-artifacts.md)，
本次清理尚未实现该替代能力。

普通 `lifecycle.finalize` 与目录 `entry` 继续保留：context 提供
`models`、只读 `messages`、`capabilityId` 和 delegation scope；返回值可改写
`output`。返回值 `messages` 原来只被赋值而没有后续消费者，本次移除该输出类型
和死赋值；context 的只读 `messages` 不受影响。这是保留的独立扩展接口，不表示
已经在所查业务中使用。工具审核返回 `reject` / `cancel` 决定时不运行 finalize。
它不授予额外工具权限，需要执行的外部动作仍由 Capability 已声明的 Toolkit 工具承担。

当前契约已删除这些接口：

- 从 Capability 的 `uses` 删除 `artifact_discovery`，并调整依赖旧工具的 instructions。
  未更新的声明仍走现有缺失 Toolkit 的不可用诊断，不会被静默取消依赖。
- finalize context 不再提供 `artifactStore` / `recordCapabilityArtifact`，返回值
  不再支持 `artifactRefs` 或 `messages`；`SubagentResult` 不再携带产物数组。
- Host/Studio 装配不再接收或暴露 `capabilityArtifactStore`，
  `HostRuntimeConfig.capabilityArtifactRoot` 和旧 store getter 也已移除。
- `sessionCapabilityArtifacts` state channel、旧 Ref 类型和合并 reducer 及其公开导出
  已删除；它们没有生产读写用途，不再作为会话索引保留。

项目目前处于自测阶段。按仓库 [AGENTS.md](../../../AGENTS.md#compatibility-during-self-testing)，
只有用户明确要求时才处理历史 checkpoint 或第三方 Capability 兼容；接口曾公开、
字段曾持久化，不构成保留兼容实现的依据。执行记录只支持现行 schema，不再接受
已删除的 `artifacts` 字段，也不提供旧格式适配或专门的兼容测试。

清理不迁移或删除用户数据。checkpoint namespace 升至 `capability-v6`，隔离已删除
旧 `artifacts` 字段的执行记录；新 runtime 不读取 v5 checkpoint。旧 checkpoint 和
store 文件留在原处，FileSaver 继续现有 checkpoint/GC 行为。Studio 会话注册表的
独立边界见 [Workdir 配置](../runtime/workdir.md)。此规则不改变文件权限、审核或
其他安全边界。

Channel 的旧 `artifacts: [{ uri, label?, version? }]` 输入、消息类型和附件展示也已
移除，strict schema 拒绝该请求字段。既有数据库 JSON 不被重写或删除，旧附件值
不再通过 API 投影或 Console 显示；新写入 JSON 不带此字段。见
[Studio API](../api/studio.md#channel-messages-and-addressing)。

## 8. Host 组装顺序

一个完整 host 应按以下顺序工作：

1. 构造所有 Toolkit definitions。
2. 解析 Toolkit availability，得到本 generation 的有效 inventory。
3. 加入所有内建、用户和调用级 Capability definitions。
4. 调用 `compileAgentRegistry()`。
5. 报告 `unavailableCapabilities`。
6. 把同一个 `CompiledAgentRegistry` 交给 Supervisor 与 executor。

不要让 UI、HTTP handler 或另一个 registry getter 自己重新计算 Capability
可用性；可用性必须来自同一次编译结果。

Accepted target（#645）：Host config selection、Toolkit availability 和 Toolkit
Runtime diagnostics 是三个不同维度。inventory 来源、顺序和 provenance 必须
确定，重复名称显式失败；Host 只聚合通用 Runtime diagnostics，不解释 Toolkit
专属 `details`。

## 9. V2 不包含的概念

- `CapabilityRuntime`
- `CapabilityContext.availableToolkits`
- Capability inline `tools` / `toolsets`
- `AgentToolset` / `defineToolset`
- `createRuntime`
- `resultSchema`
- `generalUses`
- General 专属 executor、lane、registry slot 或授权开关
- 旧 `manifest.json/index.js` Capability runtime 插件格式

这些名称只应出现在明确标记为 historical 的材料或迁移说明中，不应作为当前
扩展入口。
