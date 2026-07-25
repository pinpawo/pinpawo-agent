# Pet Agent Capability / Toolkit Contract V2

> 状态：Accepted design target
> 决策日期：2026-07-24
> 实现状态：Workstream 1–2 已完成；Workstream 3–4 仍待实现

## 1. 决策摘要

Pet Agent 的扩展框架只保留两个面向作者的核心概念：

1. **Capability**：Skill 风格的任务与行为定义，负责路由语义、Toolkit
   依赖和执行 instructions；可以带一个窄化的确定性收尾 hook，但不拥有
   tool 或任意 runtime middleware。
2. **Toolkit**：由代码实现的工具能力集合，负责 tools、tool schema、
   operation metadata、review policy 和 availability。

V2 固定以下规则：

- Capability 自己不定义、创建或注入 tool。
- Capability 的所有 tool 必须来自 `uses` 声明的 Toolkit。
- `uses` 是 Capability 的静态强依赖，同时也是工具权限边界。
- `uses` 不支持 `optional`；缺失或不可用的 Toolkit 会使 Capability
  不可用。
- `uses` 从 `CapabilityRuntime` 提升到 `AgentCapability`。
- 删除 `AgentToolset`、`defineToolset()` 和 `CapabilityRuntime.toolsets`。
- Capability instructions 是一份完整 Markdown 文档，不再是字符串数组；
  文档可以来自 `CAPABILITY.md`，也可以由代码在 registry 构建期静态定义。
- `CAPABILITY.md` 是目录型 Capability 的标准作者入口，其正文只在该
  Capability 被选中后注入 subagent system prompt。
- Capability 可以通过可选 `entry` 提供 `lifecycle.finalize`，用于必须
  确定执行的结果整理、ingest 和 artifact 收尾。
- 删除宽泛的 `createRuntime`、动态 instructions、`beforeRun` middleware、
  Capability availability check 和当前无消费者的 executable result schema。
- `lifecycle.finalize` 不能访问或修改 tools、`uses`、Toolkit、review policy
  或 system instructions。
- 需要被模型主动调用的代码和所有外部副作用仍一律由 Toolkit tool 实现；
  Capability availability 只由其 `uses` 中 Toolkit 的可用性派生。
- Toolkit 保持代码定义，不引入 Toolkit Markdown 文件协议。
- Toolkit 由静态、完整的 `ToolDefinition` 组成；tool implementation、
  operation metadata 和 review policy 在同一定义中绑定。
- 删除公共 Toolkit 契约中的 `ToolkitResource`、`ToolkitContext` 和
  `exposure`。
- 注册到 Toolkit registry 不等于获得使用权；Capability 只有通过
  `uses` 才能看到相应 Toolkit。
- general executor 也必须显式声明 Toolkit 依赖，不再默认获得全部已注册
  Toolkit。

该决策替代 `AgentToolset` 作为 capability-private tool 容器的目标设计，
并通过一次破坏式 cutover 直接替换现有契约。

V2 不提供兼容层：

- 不保留 legacy Capability loader；
- 不保留 `CapabilityRuntime.uses` / `toolsets` deprecated 双轨；
- 不提供 `AgentToolset` adapter；
- 不同时接受 `manifest.json + index.js` 和 `CAPABILITY.md` 两套作者协议；
- 不保留旧 scaffold；
- 不在运行时自动转换旧 Capability。

Issue #447 是该架构变更的唯一设计源。实现工作可以从 #447 拆成关联的
子 Issue，也可以在同一重构分支内按工作流拆分，但子 Issue 不重新定义
契约；合入主分支时必须是完整、可运行、文档和测试同步切换的单次
cutover。

## 2. 为什么需要 V2

当前实现已经建立了 Capability、Toolkit、orchestrator 和 subagent 的
基本分层，但公共契约仍有以下问题：

### 2.1 Capability 可以通过两条路径获得工具

当前 Capability 可以同时使用：

- `CapabilityRuntime.uses` 引用 Toolkit；
- `CapabilityRuntime.toolsets` 注入 capability-private tools。

这使工具所有权、审批策略和组合冲突需要维护两套路径。尤其是当前
toolset policy 虽然出现在类型中，却没有进入 Toolkit review middleware
的装配路径。

### 2.2 `uses` 发现得太晚

当前 `uses` 由 `createRuntime()` 返回。系统只有在 Capability 已经被路由
并开始创建 subagent 后，才知道其 Toolkit 依赖。缺少 Toolkit 时会在执行
阶段失败，而不是在 registry 构建阶段将 Capability 标记为不可用。

### 2.3 Capability instructions 缺少文档边界

当前 instructions 是 `string[]`，最终仅以 `\n\n` 拼接进 system prompt。
数组元素没有独立语义，却鼓励把完整行为协议拆成零散句子，导致：

- 长流程难以阅读和评审；
- Markdown 层级难以维护；
- 版本差异噪声大；
- 外部 Capability 仍然需要用 JavaScript 拼装 prompt；
- 静态行为协议与动态运行事实混在一起。

### 2.4 Toolkit 注册和工具授权被混淆

当前 general lane 默认获得所有符合 exposure 的 Toolkit。对于扩展框架，
registry 应仅表示“当前运行环境有哪些 Toolkit”，而 `uses` 才表示“当前
executor 被授权使用哪些 Toolkit”。

## 3. 领域模型

```text
tool
  一个最小可调用动作，只能由 Toolkit 拥有。

toolkit
  代码定义的工具能力集合。
  拥有 ToolDefinition、工具族 instructions 和 availability。

tool definition
  一个工具在 Toolkit 中的完整静态定义。
  同时绑定可执行实现、operation metadata 和 review policy。

capability
  Skill 风格的执行协议。
  拥有路由描述、uses、Markdown instructions，以及可选的窄化 finalize hook。

toolkit registry
  当前运行环境可解析的 Toolkit inventory。
  注册不授予任何 executor 工具权限。

orchestrator
  选择 Capability，解析其 uses，创建唯一的 capability subagent。
```

核心依赖方向：

```text
Capability --uses--> Toolkit --owns--> Tool
```

禁止以下方向：

```text
Capability --owns--> Tool
Capability --calls--> Capability
Toolkit --routes--> Capability
```

## 4. 目标契约

### 4.1 Toolkit

Toolkit 必须由代码定义：

```ts
type ToolDefinition = {
  tool: NamedStructuredTool;
  operation?: ToolOperationMetadata;
  review?: ToolReviewPolicy;
};

type AgentToolkit = {
  name: string;
  description: string;
  tools: readonly ToolDefinition[];
  instructions?: string;
  availability?: ToolkitAvailabilityCheck;
  reviewGuidance?: ToolkitReviewGuidance;
};
```

规则：

- `name` 是 Toolkit registry 内的稳定唯一标识。
- `tools` 必填且非空；Toolkit 内 tool name 必须唯一。
- `ToolDefinition` 是一个 tool implementation、operation metadata 和
  review policy 的完整静态定义。
- Toolkit 是 `ToolDefinition` 的唯一 owner。
- `ToolDefinition` 使用框架级命名，不增加 `Toolkit` 前缀；它本身描述
  单个工具，Toolkit 只负责组织一组定义。
- `reviewGuidance` 只提供工具族级的全局 review classifier 提示；单个
  tool 的确定性 review policy 必须定义在对应 `ToolDefinition.review`。
- Toolkit 可以在代码中提供短的工具族使用说明，但不引入
  `TOOLKIT.md` 或外部 instructions 文件协议。
- Toolkit `instructions` 是一个可选静态字符串，不是数组或运行时
  factory；tool-specific 说明优先写在 tool schema/description 中。
- Toolkit availability 只描述其自身依赖，例如 binary、credential、
  browser backend 或服务连接状态。
- Toolkit 不包含 Capability 的业务目标、路由描述或 result schema。

V2 不在公共 Toolkit 契约中提供 `ToolkitResource` 或 `ToolkitContext`。
需要宿主依赖的 Toolkit 使用普通代码工厂创建：

```ts
function createStudioPlanToolkit(
  options: StudioPlanToolkitOptions,
): AgentToolkit {
  return defineToolkit({
    name: 'studio_plan',
    description: 'Plan and enqueue Studio tasks.',
    tools: [
      {
        tool: createListPetsTool(options),
        operation: listPetsOperation,
      },
      {
        tool: createEnqueueTasksTool(options),
        operation: enqueueTasksOperation,
        review: enqueueTasksReviewPolicy,
      },
    ],
  });
}
```

工厂是宿主的实例构造方式，不是 Toolkit runtime resource 协议。工厂可以
捕获 actor、model、repository、session client 或 run-scoped service，
但其返回的 `AgentToolkit` 在进入当前 registry generation 后必须完整且
不可变。Toolkit tools 和 instructions 不得再通过一个通用 executor
context 延迟生成。

Review 所需的运行时输入通过窄化的 `ToolReviewContext` 在 review 阶段
传给 `ToolReviewPolicy`。models、actor、messages、thread/capability/run
标识、artifact recorder、authorization recorder 和 runtime event emitter
属于 orchestrator/review middleware，不属于 Toolkit 定义。

Toolkit availability 使用独立契约，不复用
`CapabilityAvailabilityConfig`：

```ts
type ToolkitAvailability =
  | { available: true }
  | { available: false; reason: string };

type ToolkitAvailabilityCheck = () =>
  | ToolkitAvailability
  | Promise<ToolkitAvailability>;
```

availability 的调用和缓存生命周期由 registry generation 负责，不在
Toolkit 上暴露 `cache: 'startup' | 'none'`。

### 4.2 Capability

```ts
type AgentCapability = {
  name: string;
  description: string;
  uses: readonly string[];
  instructions: InstructionDocument;
  lifecycle?: {
    finalize?: CapabilityFinalizeHook;
  };
};

type InstructionDocument = {
  content: string;
  source:
    | { kind: 'file'; path: string }
    | { kind: 'inline'; id: string };
  digest: string;
};

type CapabilityFinalizeHook = (
  result: Readonly<SubagentResult>,
  context: CapabilityFinalizeContext,
) => Promise<CapabilityFinalizeResult>;
```

规则：

- `name` 是 Capability registry 内的稳定唯一标识。
- `description` 供 Capability search / routing 使用。
- `uses` 是静态强依赖；不得由运行时消息、actor 或模型动态改变。
- Capability 不包含 `tools`、`toolsets`、inline Toolkit 或 tool policy。
- `instructions.content` 是完整 Markdown 行为协议。
- Capability 不包含宽泛的 `createRuntime`、动态 instructions、
  `beforeRun` middleware、availability check 或 executable result schema。
- 可选代码入口只能导出 `lifecycle.finalize`，其输入和返回值均由框架
  窄化；不能接触 `SubagentRunInput` 或工具装配。
- 输出要求写在 Markdown 正文中；结构化外部写入和业务副作用必须由
  Toolkit tool 实现。`finalize` 只允许整理已有执行结果、生成 ingest、
  写 Capability artifact 和修正 announce。
- Capability availability 完全由静态 `uses` 是否都能在当前 registry
  generation 中解析且 available 派生。

### 4.3 `uses` 的确定语义

```ts
uses: ['bash', 'git', 'browser']
```

同时表达：

1. Capability 执行依赖 `bash`、`git`、`browser` 三个 Toolkit；
2. Capability subagent 只能获得这三个 Toolkit 的工具；
3. 任意 Toolkit 缺失或 unavailable，Capability 均 unavailable；
4. Toolkit 按 `uses` 顺序确定性装配；
5. 同名 tool 冲突必须在执行前报错，不允许 first-win 或 last-win。

V2 不提供：

```ts
{ name: 'browser', optional: true }
```

如果不同运行环境需要不同工具组合，应创建明确的 Capability 场景定义或
通过构建期 preset 生成不同的最终 Capability。最终注册的 Capability
必须拥有确定的 `uses`。

### 4.4 CapabilityRuntime

V2 不再通过 CapabilityRuntime 声明工具依赖或 instructions。若保留
runtime 对象，仅允许承载本次执行才产生的非权限信息：

```ts
type CapabilityRuntime = {
  runtimeContext?: string;
  middleware?: CapabilityMiddleware;
};
```

其中：

- `runtimeContext` 只包含 actor、workdir、time anchor 等本次运行事实；
- `middleware` 不得改变 tools、Toolkit 依赖或 system contract；
- 稳定行为说明必须进入 `CAPABILITY.md`，不能在每次执行时重新生成。

## 5. `CAPABILITY.md` 作者协议

### 5.1 标准目录

```text
capabilities/
└── web-research/
    ├── CAPABILITY.md
    ├── references/          # 可选，V2 初期不自动注入
    └── index.js             # 可选，只能导出 lifecycle.finalize
```

大多数外部 Capability 应只需要 `CAPABILITY.md`。内置或宿主注册的
Capability 也可以用代码定义，但 instructions 必须在 registry generation
内形成不可变的 `InstructionDocument`，不能按消息动态生成。

### 5.2 Frontmatter

```md
---
name: web_research
description: 调查网页资料、核验来源并输出带引用的研究结论。
uses:
  - browser
  - web_search
version: 1
icon: magnifyingglass
color: blue
defaultEnabled: true
---
```

字段：

- `name`：稳定 ID；
- `description`：路由描述；
- `uses`：强依赖 Toolkit 名称列表；
- `version`：Capability authoring contract 版本；
- `icon`、`color`、`defaultEnabled`：可选 host/UI metadata；
- `entry`：可选代码入口，只能导出窄化的 `lifecycle.finalize`。

`builtIn` 不应由 Capability 作者声明；它由安装来源决定。

### 5.3 Markdown 正文

正文是一个完整的 Skill 风格执行协议，建议包含：

```md
# Capability 名称

## 目标
## 适用场景
## 工作流程
## 工具使用要求
## 约束与边界
## 输出要求
## 失败与信息不足时的处理
```

这些标题是 authoring guidance，不要求运行时把正文解析成行为 AST。

### 5.4 加载规则

Capability loader 在启动或显式 rescan 时：

1. 解析 UTF-8 frontmatter 和 Markdown 正文；
2. 校验 `name`、`description`、`uses` 和正文非空；
3. 拒绝重复 Capability 名称；
4. 解析并校验全部 Toolkit 依赖；
5. 校验 `entry` 和 reference 路径不能逃出 Capability root；
6. 对正文设置大小上限；
7. 计算内容 digest；
8. 将不可用原因保存在 registry descriptor 中；
9. 只向 routing 暴露 name、description 和派生 availability；
10. 仅在 Capability 被选择后向 subagent 注入正文。

初始实现可以启动时读取并缓存全文。未来若引入延迟加载，必须保证同一
registry generation 内 digest 和内容不发生漂移。

代码注册的 Capability 不经过目录 loader，但必须经过相同的 definition、
依赖和 digest 校验。它不是 legacy `manifest.json + index.js` 协议的兼容层。

## 6. System prompt 装配

Capability instructions 不再以句子数组传递。运行时使用结构化 section
编译成一个最终 system prompt：

```ts
type SystemPromptSection = {
  id: string;
  source: 'framework' | 'runtime' | 'toolkit' | 'capability';
  owner?: string;
  content: string;
};
```

固定顺序：

1. framework governing prompt；
2. delegation / executor runtime context；
3. `uses` 顺序对应的 Toolkit code-defined instructions；
4. 选中 Capability 的 `CAPABILITY.md` 正文；
5. 本次运行的动态、可信 runtime facts。

最终交给模型的是单个 system prompt 字符串。Section 结构只用于：

- 确定性排序；
- provenance；
- 日志和调试；
- digest；
- 重复和空 section 校验。

Toolkit policy、authorization 和 tool schema 必须由代码确定性执行，不能
依赖 prompt 顺序实现安全优先级。

## 7. Registry 与生命周期

Toolkit 可以来自不同生命周期，但统一进入当前执行环境的
Toolkit registry：

- application/global：例如 `bash`、`git`、`browser`；
- session：例如某个连接会话绑定的 Toolkit；
- run：例如 Studio planner Toolkit、当前 thread 的 artifact discovery。

生命周期是 registry 实现细节，不改变 Capability 的 `uses` 契约。

例如 Studio 在启动一次 planner run 前注册：

```text
studio_plan Toolkit
  tools: list_pets, enqueue_tasks

studio_plan Capability
  uses: [studio_plan]
```

Capability 不关心 Toolkit 来自全局安装还是当前 run。只要 registry
可以解析且 available，契约就成立。

general executor 也必须有显式 Toolkit 列表，例如：

```ts
generalUses: ['bash', 'git']
```

不得把“注册到 registry”作为 general executor 的隐式授权。

## 8. 编译与验证阶段

orchestrator 不应在 capability node 内临时发现依赖问题。Host 在 registry
构建或 run setup 阶段编译 executor：

```text
load Toolkit definitions
→ validate Toolkit definitions and availability
→ validate non-empty tools and unique tool names
→ bind each tool implementation, operation, and review policy from ToolDefinition
→ load CAPABILITY.md definitions
→ resolve capability.uses
→ derive Capability availability
→ validate unique tool names for each effective executor
→ produce CompiledCapability
```

```ts
type CompiledCapability = {
  capability: AgentCapability;
  toolkits: readonly AgentToolkit[];
  toolNames: readonly string[];
  systemInstructionDocument: InstructionDocument;
};
```

Host 完成 run-scoped Toolkit 装配后只编译一次 registry，并把同一个
`CompiledAgentRegistry` 放入 run setup。stream、invoke、getState、routing
和 executor 都消费该对象，不得各自重新编译或再次改变 Toolkit 集合。

`compileAgentRegistry()` 保持纯函数。`unavailableCapabilities` 是结构化
diagnostics；由 host 按稳定 diagnostics 指纹去重告警，而不是由 core
compiler 决定日志策略。

对外的 Capability 状态投影也必须来自同一编译结果：

```ts
type CapabilityRoutability =
  | { status: 'available' }
  | { status: 'unavailable'; issues: ExecutorCompilationIssue[] }
  | {
      status: 'requires_scope';
      required: ('threadId' | 'capabilityArtifactStore')[];
    };
```

缺少 run scope 时不能用第二套 Toolkit name 比较算法猜测可用性。
scope 完整后，`unknown_toolkit`、`duplicate_tool` 等状态直接投影
registry diagnostics。

## 9. 窄化 Capability 代码入口

Capability 不要求是纯 Markdown，但代码入口只有一个明确用途：在
subagent 完成后执行 Capability 专属、必须确定发生的收尾逻辑。

```ts
export const lifecycle: CapabilityLifecycle = {
  finalize: async (result, context) => {
    // 整理结果、生成 ingest、写 artifact、修正 announce
    return {
      messages: result.messages,
      announceMessageId: result.announceMessageId,
    };
  },
};
```

`finalize` 可以：

- 读取本次 Capability 的只读执行结果和只读历史；
- 使用框架明确提供的 observe model；
- 写入当前 Capability scope 下的 artifact；
- 追加或整理结果消息；
- 返回明确的 `announceMessageId`。

`finalize` 不可以：

- 创建、增加、删除或替换 tool；
- 修改 `uses` 或 Toolkit 集合；
- 访问或修改 review policy、authorization 或 `SubagentRunInput`；
- 动态替换 Capability 或 Toolkit instructions；
- 执行本应由 Toolkit tool 表达的文件、网络、数据库或应用副作用；
- 调度另一个 Capability。

V2 初期不提供 `beforeRun`。如果未来确有需要，必须为具体、窄化的数据
变换定义新 hook，不能恢复通用 middleware。

## 10. 现有实现迁移

| 当前概念/调用点 | V2 目标 |
|---|---|
| `CapabilityRuntime.uses` | `AgentCapability.uses` |
| `CapabilityRuntime.toolsets` | 删除 |
| `AgentToolset` | 删除 |
| `defineToolset()` | 删除 |
| `ToolkitResource` / `ToolkitContext` | 从公共 Toolkit 契约删除 |
| Toolkit `exposure` | 删除；授权只由 `uses` / `generalUses` 决定 |
| `tools` + `operations` + `policy.toolReview` 并行结构 | 合并为 `ToolDefinition[]` |
| Toolkit `string[]` / dynamic instructions | 可选静态 `string` |
| Toolkit 复用 Capability availability | 独立 `ToolkitAvailabilityCheck` |
| `string[] instructions` | 单一 Markdown `InstructionDocument` |
| capability plugin `manifest.json` | `CAPABILITY.md` frontmatter |
| capability `index.js` / `entry` | 可选；只能导出 `lifecycle.finalize` |
| general lane 装配全部 Toolkit | `generalUses` 显式依赖 |
| capability node 临时解析 Toolkit | registry compile 阶段解析 |

具体迁移：

### 10.1 Daily Post

```text
createDailyPostToolset(options)
→ createDailyPostToolkit(options)

daily_post Capability
→ uses: [daily_post]
→ instructions: capabilities/daily-post/CAPABILITY.md
→ structured save/validation remains in daily_post Toolkit tools
```

### 10.2 Capability Creator

```text
createCapabilityCreatorToolset()
→ createCapabilityCreatorToolkit()

capability_creator Capability
→ uses: [bash, capability_creator]
→ instructions: capabilities/capability-creator/CAPABILITY.md
→ scaffold/validation code remains in capability_creator Toolkit tools
```

Capability Creator 生成的模板必须改为 `CAPABILITY.md`。

### 10.3 Studio Plan

```text
createPlanToolset(options)
→ createPlanToolkit(options)

studio_plan Capability
→ uses: [studio_plan]
```

Studio 在 planner run setup 阶段注册 run-scoped Toolkit。

### 10.4 Artifact Discovery

```text
createArtifactDiscoveryToolkit({ store, threadId })
```

需要 artifact discovery 的最终 Capability 场景显式包含：

```ts
uses: ['artifact_discovery']
```

host 在 artifact store 和 thread scope 可用时注册 run-scoped Toolkit。当前
thread 是否已经写入 artifact、File store 的物理 thread 目录是否已经创建，
都只是数据状态，不是 Toolkit availability。空 thread 的 `artifact_list`
返回空结果，不能导致依赖它的 Capability 被排除。

`artifact_discovery` 通过 `CapabilityArtifactStore.listArtifacts()` /
`readArtifact()` 工作，不把 File store 的目录布局升级为 Toolkit 契约。
不存在 artifact store 或 thread scope 的环境不注册该 Toolkit；依赖它的
Capability 由 registry 标记 unavailable。运行时不得静默增加或移除
Capability 的 Toolkit 权限，也不引入 optional dependency。

当 host 只是在展示 Capability inventory、尚未提供完整 run scope 时，
应投影为 `requires_scope`。这只是说明当前还不能完成 registry generation，
不把 `artifact_discovery` 降级为 optional，也不把 Capability 谎报为
available。

### 10.5 Explore

当前 Explore 根据 available Toolkit 动态过滤依赖。V2 必须拆成确定场景，
或由 host 在构建期创建拥有确定 `uses` 的最终 Capability，例如：

```text
explore_local   uses [bash, git, artifact_discovery]
explore_web     uses [browser, web_search]
explore_github  uses [git, github]
```

同名 Capability 不得因环境不同而静默获得不同工具集合。

当前 Explore 的 `afterRun` ingest 和 artifact 收尾迁移为窄化的
`lifecycle.finalize`。当前无运行时消费者的 executable `resultSchema`
删除；实际结构化外部写入继续由 Toolkit tool 负责。

## 11. 破坏式重构工作流

以下编号只表示实现依赖顺序，不表示可以在主分支长期保留新旧双轨。

### Workstream 1：目标类型与确定性校验

- [x] 直接把 `uses` 定义到 `AgentCapability`；
- [x] 直接删除 `AgentToolset`、`defineToolset()`、runtime `uses/toolsets`；
- [x] 直接删除 `ToolkitResource`、`ToolkitContext` 和 Toolkit `exposure`；
- [x] 引入框架级 `ToolDefinition` 和 `ToolReviewPolicy`；
- [x] 工具名冲突改为 fail-fast；
- [x] review policy、operation metadata 和 tool implementation 必须绑定到同一
  `ToolDefinition`。

### Workstream 2：Toolkit-only tools 与 Registry

- [x] registry 启动时解析依赖；
- [x] capability route 只看到依赖可满足的 Capability；
- [x] 将四个生产 Toolset 迁移成 Toolkit；
- [x] 将现有 Toolkit 的 tools、operations、tool review maps 合并为
  `ToolDefinition[]`；
- [x] 将动态 Toolkit resource 改为宿主工厂创建完整 Toolkit 实例；
- [x] 将 review/runtime 基础设施从 Toolkit 定义上下文中移出；
- [x] run setup 支持注册 run-scoped Toolkit；
- [x] 删除 capability node 的 toolset 合并路径；
- [x] general executor 改成显式 `generalUses`。

### Workstream 3：`CAPABILITY.md` 与 Prompt

- 实现 frontmatter parser、路径校验、digest 和缓存；
- 支持无 JavaScript 的纯 Markdown Capability；
- 支持代码注册的静态 `InstructionDocument` 和可选
  `lifecycle.finalize`；
- 删除 `createRuntime`、动态 instructions 和通用 `beforeRun/afterRun`
  middleware；
- 将内置 Capability instructions 迁移为 Markdown；
- Capability Creator 生成 V2 模板；
- 删除 legacy manifest/index loader 和 scaffold。

### Workstream 4：一次性 Cutover

- 更新所有 built-in、Studio、local-agent、示例和测试调用点；
- 删除 operation provider 的 `toolset` 枚举；
- 更新 API 文档、plugin protocol、README 和架构图；
- 运行完整 typecheck、unit tests、build 和 package smoke tests；
- 只在所有目标契约同时可用时合入主分支。

## 12. 验收标准

### 契约

- [x] Capability 类型没有 tool/toolset 字段。
- [x] Toolkit 是 tool、operation metadata 和 review policy 的唯一 owner。
- [x] Toolkit 的每个工具由一个 `ToolDefinition` 完整描述。
- [x] `AgentToolkit.tools` 必填、非空且 tool name 唯一。
- [x] 公共 Toolkit 契约中不存在 `ToolkitResource`、`ToolkitContext` 或
  `exposure`。
- [x] Toolkit instructions 是可选静态字符串。
- [x] Toolkit availability 不复用 Capability availability 或暴露缓存策略。
- [x] `AgentCapability.uses` 是必填静态强依赖。
- [x] `uses` 不支持 optional。
- [x] Capability instructions 是一个 Markdown document，而不是数组。
- [x] Capability 可选代码入口只能导出窄化的 `lifecycle.finalize`。
- [x] `finalize` 不能访问或修改 tools、Toolkit、review policy、
  authorization、system instructions 或 `SubagentRunInput`。

### Registry

- [x] 缺少任一 Toolkit 时，Capability 在路由前被标记 unavailable。
- [x] 注册 Toolkit 不会自动扩大 general executor 工具面。
- [x] run-scoped Toolkit 可以被当前 run 的 Capability 解析。
- [x] 同一 executor 内同名 tool 在运行前 fail-fast。
- [x] 一个 run setup 只编译一次 registry，routing、执行和状态读取复用。
- [x] `unavailableCapabilities` 由 host 去重报告，不在 core compiler 打日志。
- [x] host 可用性投影复用 registry diagnostics；缺 scope 时明确返回
  `requires_scope`。

### Prompt

- [x] 未选中的 Capability 正文不会进入模型上下文。
- [x] 选中的 `CAPABILITY.md` 正文只注入一次。
- [x] system prompt section 顺序确定且可观测。
- [x] 动态 runtime facts 与静态 Capability instructions 分离。

### 扩展体验

- [x] 一个无代码 `CAPABILITY.md` 可以安装、验证、列出和执行。
- [x] Capability Creator 默认生成 V2 目录。
- [x] Toolkit 继续通过 TypeScript/JavaScript 代码插件定义。
- [x] Loader / registry 对路径逃逸、空正文、重复名称和未知 Toolkit
  给出明确错误或 unavailable descriptor。

### 迁移

- [x] Daily Post、Capability Creator、Studio Plan、Artifact Discovery 不再使用
  Toolset。
- [x] Explore 不再运行时过滤 `uses`。
- [x] 所有现有单元测试、typecheck 和 build 通过。
- [x] 新增依赖解析、工具冲突、Markdown loader 和 prompt 注入测试。

## 13. 非目标

V2 不解决：

- Capability 直接调用 Capability；
- Capability 继承另一个 Capability 的执行语义；
- 模型动态选择未声明 Toolkit；
- optional Toolkit 或自动降级；
- 把 Toolkit 变成 Markdown/Skill；
- 自动解析 Markdown 正文为 workflow AST；
- 在 registry generation 内热修改 Capability instructions；
- 通过 prompt 代替 review policy 或权限控制。

## 14. 最终不变量

实现和后续设计必须保持：

```text
Capability 决定“如何完成一类任务”。
Toolkit 决定“有哪些可调用动作”。
Capability 只能通过静态 uses 获得 Toolkit。
所有 uses 都是强依赖和权限边界。
所有 tool 都有且只有一个 Toolkit owner。
Capability instructions 始终是不可变 InstructionDocument：
目录型来源使用 CAPABILITY.md，代码注册来源在 registry 构建期静态定义。
Toolkit registry 是 inventory，不是授权列表。
orchestrator 是唯一 Capability 编排者。
```
