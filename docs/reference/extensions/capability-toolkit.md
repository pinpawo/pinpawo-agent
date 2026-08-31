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
设计理由与组合边界见
[Toolkit Composition Design](../../design/agent-runtime/toolkit-composition.md)，
目录插件格式见
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
- **Toolkit**：编码实现的工具、工具说明和工具级策略集合。

Capability 不继承或调用另一个 Capability。多个场景需要复用工具能力时，
通过 `uses` 组合 Toolkit；多个 Capability 的先后关系由 orchestrator 编排。

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
  调整 announce 或持久化 artifact。

`uses` 可以是空数组，此时 Capability 是 instructions-only，但仍然通过同一
subagent 执行路径运行。V2 没有 optional Toolkit 依赖：声明在 `uses` 中就表示
缺少它时该 Capability 不可用。

### 2.2 代码定义

```ts
const inspect = defineCapability({
  name: 'inspect',
  description: '检查代码库并整理证据。',
  uses: ['bash', 'git'],
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
  - bash
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
  readonly runtime?: ToolkitRuntimeDefinition;
};

type ToolDefinition = {
  readonly tool: NamedStructuredTool;
  readonly operation?: ToolOperationMetadata;
  readonly review?: ToolReviewPolicy;
};
```

字段语义：

- `name` / `description`：Toolkit 的稳定身份和能力范围。
- `tools`：至少一个可执行的 LangChain Structured Tool。
- `instructions`：工具族的使用规则，会进入使用该 Toolkit 的 subagent
  system prompt。
- `availability`：host 组装本次 registry generation 前执行的可用性检查。
- `reviewGuidance`：Toolkit 提供给全局 review 判断的允许/询问边界。
- `runtime`：可选、由 Toolkit 自己实现的 root / execution binding 生命周期。
- `ToolDefinition.operation`：工具调用的展示和摘要 metadata。
- `ToolDefinition.review`：单个工具的确定性 review policy。

Toolkit 必须由代码定义；它不是 Markdown skill，也不是 orchestrator 的委派目标。

```ts
const bash = defineToolkit({
  name: 'bash',
  description: '本地文件、搜索和受控 shell 工具。',
  tools: [{
    tool: runShellTool,
    operation: { title: '执行命令' },
    review: shellReviewPolicy,
  }],
  instructions: '优先使用语义具体的文件工具；shell 只作为兜底。',
});
```

LangChain Tool 可能包含可变运行时内部状态。registry 会冻结
`ToolDefinition` 绑定和 metadata，但保留原始 Tool 实例身份；host 必须约定在
一个 registry generation 内不修改已注册 Tool 的 `name`。

### 3.2 可选 Runtime 生命周期

需要持久连接、共享进程、登录态或执行作用域绑定的 Toolkit 可以声明
`runtime`；它不是另一套 Capability，也不改变 `uses`、tool permission、review
或 instructions 的静态含义：

```ts
type ToolkitRuntimeDefinition<TRoot, TBinding = TRoot> = {
  start(context: { signal?: AbortSignal }): Promise<TRoot> | TRoot;
  resolve?(root: TRoot, context: {
    execution: {
      threadId: string | null;
      runId: string;
      delegationId: string;
      workdir: string | null;
      signal?: AbortSignal;
    };
  }): Promise<TBinding> | TBinding;
  bindTools?(binding: TBinding, context: ToolkitRuntimeResolveContext):
    Promise<readonly NamedStructuredTool[]> | readonly NamedStructuredTool[];
  release?(binding: TBinding, context: ToolkitRuntimeReleaseContext): Promise<void> | void;
  diagnose?(root: TRoot): Promise<JsonValue> | JsonValue;
  stop?(root: TRoot, context: { signal?: AbortSignal }): Promise<void> | void;
};
```

Host 使用 `ToolkitRuntimeManager` 在启动期按 Toolkit 顺序启动 root；每个
Capability subagent 开始时为其声明的 Toolkit resolve 不透明 binding，并在
subagent 结束（成功、失败或取消）后逆序 release。host 关闭时先清理仍活动的
binding，再逆序 stop root。并发 subagent 可以同时 resolve，但同一个 root 只会
启动一次。

未声明 `bindTools` 时，resolved binding 以 Toolkit name 为 key，作为 opaque Runtime
port 放入 `ToolRuntime.context.toolkitRuntimes`。静态 Tool 可以在每次调用时把当前
invocation identity 传给自己的 Runtime；Agent 和通用 manager 不解释 port 的具体
接口。`bindTools` 是互斥的消费方式，只用于确实需要替换执行 implementation 的
Toolkit，例如注入 process registry；这类 binding 不再额外暴露到 Tool runtime
context。框架会验证工具数量和名称与静态 inventory 相同，并继续使用静态 Tool 的
schema、description、response format，以及静态 `operation`、`review`、权限与
instructions。runtime binding 不会进入 registry、supervisor workspace、prompt 或
checkpoint。

通用 invocation identity 不经过 `bindTools`；Agent 把 `threadId`、`runId` 和
`delegationId` 放入 `ToolRuntime.context.executionScope`。Host 将同一份 workdir
snapshot 提供给 Agent prompt、Tool runtime context 与 review/authorization context。
Tool input 中的相对
路径、绝对路径或 cwd 由模型决定并原样执行；越出 workdir 的风险由 review /
authorization 判断，而不是由 execution binding 改写参数。

`ToolkitRuntimeManager` 是 host-owned：长期 local-agent 在进程启动/关闭时调用
它；独立 `createResidentPetRuntime()` 使用的 manager 由 Host lifecycle 统一 `shutdown()`
释放。若由 host 注入共享 manager，则由该 host 统一 stop，不能由单个 pet
runtime 终止。

`ToolkitRuntimeManager.diagnose()` 为所有声明 Runtime 的 Toolkit 返回同一份 lifecycle、
active binding 数和最近错误。可选 `diagnose(root)` 只补充 JSON-safe、Toolkit-owned
`details`；Host 不解释该结构，也不为 Browser 或其他 Toolkit 建第二份状态源。

### 3.3 可用性

`compileAgentRegistry()` 只负责编译传入的有效 Toolkit inventory，不执行
`availability`。调用入口或 host 必须先解析可用性：

```text
Toolkit definitions
  -> start optional root runtimes
  -> evaluate/filter availability for this generation
  -> compileAgentRegistry(effective Toolkits, Capabilities)
```

`runAgent()` 和 pet runtime 会为各自的异步 registry generation 调用
`filterAvailableToolkits()`；local-agent 可以对同一个 Toolkit 实例缓存检查结果，
并通过显式 refresh 重新检查。无论 host 采用哪种刷新策略，编译器看到的都必须是
本次 generation 的完整有效 Toolkit 集合。

如果某个环境可以用另一种实现提供**相同语义**的 Toolkit，fallback 可以封装在
Toolkit factory 内。不能为了让 Capability 看起来可用而注册一个不满足同名
Toolkit 契约的空壳实现。

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

Supervisor 是一个框架内部的 tool-loop agent。若 effective workspace 包含
`general`，runtime 会先读取经过 workspace digest 校验的完整文档，并只在
Supervisor 私有输入中将它作为默认 Capability 提供。Supervisor 随后使用
`capability_search` 按需发现更具体的 `CAPABILITY.md`，再统一完成：

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
effective workspace，其经过校验的文档就会作为默认候选进入 Supervisor 私有上下文。Agent 也可
通过 `defaultCapabilityName` 将另一个已注册且可用的 Capability 设为默认候选；这只改变 Supervisor
预加载与候选偏好，不会强制路由或创建独立 executor。代码没有 general fallback executor、
独立 lane 或单独的 General terminal action。

local-agent 的内建 General 位于：

```text
services/local-agent/src/capabilities/general/
├── CAPABILITY.md
└── index.ts
```

`general` 是 local-agent host 的保留名，用户 Capability 不能覆盖。local-agent
把它作为 host baseline；内建文档缺失或无效时 registry 初始化失败。pet-agent
core 仍允许显式受限 workspace 不包含 General，且不会凭空构造一个实现。

## 7. Artifact

`CapabilityArtifactStore` 是 host 提供的持久化 port：

- `lifecycle.finalize` 可以通过 context 中的 store 写入执行结果，并返回或记录
  `CapabilityArtifactRef`。
- orchestrator state 只保存 refs，不保存大 payload。
- `artifact_discovery` Toolkit 按当前 thread 提供只读
  `artifact_list` / `artifact_read`。
- 空 thread 返回空列表，不代表 Toolkit 不可用。
- 需要读取历史 artifact 的 Capability 必须在自己的 `uses` 中静态声明
  `artifact_discovery`。

本地 chat host 为需要历史产物的 Capability 提供稳定的 `threadId` 和
`CapabilityArtifactStore`，以免通过缺失 scope 静默移除 Explore 等声明
`artifact_discovery` 的 Capability。General 不依赖这项运行期 scope。

## 8. Host 组装顺序

一个完整 host 应按以下顺序工作：

1. 构造所有 Toolkit definitions。
2. 解析 Toolkit availability，得到本 generation 的有效 inventory。
3. 加入所有内建、用户和调用级 Capability definitions。
4. 添加需要 host scope 的 Toolkit，例如 thread-scoped
   `artifact_discovery`。
5. 调用 `compileAgentRegistry()`。
6. 报告 `unavailableCapabilities`。
7. 把同一个 `CompiledAgentRegistry` 交给 supervisor 与 executor。

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
