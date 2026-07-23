# Pet Agent Capability / Toolkit Contract V2

> 状态：Accepted design target
> 决策日期：2026-07-24
> 实现状态：Workstream 1 已完成；Workstream 2–4 仍待实现

## 1. 决策摘要

Pet Agent 的扩展框架只保留两个面向作者的核心概念：

1. **Capability**：Skill 风格的任务与行为定义，负责路由语义、Toolkit
   依赖、执行 instructions 和结果契约。
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
- Capability instructions 是一份完整 Markdown 文档，不再是字符串数组。
- Capability 的标准作者入口是 `CAPABILITY.md`，其正文只在该 Capability
  被选中后注入 subagent system prompt。
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
  拥有路由描述、uses、CAPABILITY.md instructions、结果契约和可选 hooks。

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
  availability?: CapabilityAvailabilityConfig;
  resultSchema?: CapabilityResultSchema;
  hooks?: CapabilityHooks;
};

type InstructionDocument = {
  content: string;
  sourcePath: string;
  digest: string;
};
```

规则：

- `name` 是 Capability registry 内的稳定唯一标识。
- `description` 供 Capability search / routing 使用。
- `uses` 是静态强依赖；不得由运行时消息、actor 或模型动态改变。
- Capability 不包含 `tools`、`toolsets`、inline Toolkit 或 tool policy。
- `instructions.content` 是完整 Markdown 行为协议。
- `hooks` 只处理高级生命周期需求，不得添加、移除或替换 Toolkit/tool。
- `resultSchema` 描述 Capability 的结果 artifact，不属于 Toolkit。

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
    └── index.js             # 可选，仅用于高级 hooks/schema
```

大多数 Capability 应只需要 `CAPABILITY.md`。

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
- `entry`：可选高级代码入口。

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
9. 只向 routing 暴露 name、description 和 availability；
10. 仅在 Capability 被选择后向 subagent 注入正文。

初始实现可以启动时读取并缓存全文。未来若引入延迟加载，必须保证同一
registry generation 内 digest 和内容不发生漂移。

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

运行阶段只能执行 `CompiledCapability`，不得再次改变 Toolkit 集合。

## 9. 高级代码入口

Capability 默认是纯 Markdown。只有以下场景允许可选代码入口：

- capability-specific result schema；
- afterRun artifact persistence；
- deterministic ingest；
- before/after lifecycle hook；
- 非 Toolkit 依赖的业务 availability。

代码入口只导出受限 hooks/schema：

```ts
export function createCapabilityExtension(): CapabilityExtension {
  return {
    resultSchema,
    hooks: {
      afterRun,
    },
  };
}
```

代码入口不得：

- 返回或修改 `uses`；
- 创建 tools；
- 注入 toolsets；
- 替换 `CAPABILITY.md` instructions；
- 递归调用其他 Capability。

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
| capability `index.js` 必需 | 默认不需要；高级 hooks 可选 |
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
```

### 10.2 Capability Creator

```text
createCapabilityCreatorToolset()
→ createCapabilityCreatorToolkit()

capability_creator Capability
→ uses: [bash, capability_creator]
→ instructions: capabilities/capability-creator/CAPABILITY.md
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
createArtifactDiscoveryToolset(root)
→ createArtifactDiscoveryToolkit(root)
```

需要 artifact discovery 的最终 Capability 场景显式包含：

```ts
uses: ['artifact_discovery']
```

不存在 artifact store 的环境注册另一份不包含该依赖的 Capability 场景；
运行时不得静默增加或移除工具权限。

### 10.5 Explore

当前 Explore 根据 available Toolkit 动态过滤依赖。V2 必须拆成确定场景，
或由 host 在构建期创建拥有确定 `uses` 的最终 Capability，例如：

```text
explore_local   uses [bash, git]
explore_web     uses [browser, web_search]
explore_github  uses [git, github]
```

同名 Capability 不得因环境不同而静默获得不同工具集合。

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

- registry 启动时解析依赖；
- capability route 只看到依赖可满足的 Capability。
- 将四个生产 Toolset 迁移成 Toolkit；
- 将现有 Toolkit 的 tools、operations、tool review maps 合并为
  `ToolDefinition[]`；
- 将动态 Toolkit resource 改为宿主工厂创建完整 Toolkit 实例；
- 将 review/runtime 基础设施从 Toolkit 定义上下文中移出；
- run setup 支持注册 run-scoped Toolkit；
- 删除 capability node 的 toolset 合并路径；
- general executor 改成显式 `generalUses`。

### Workstream 3：`CAPABILITY.md` 与 Prompt

- 实现 frontmatter parser、路径校验、digest 和缓存；
- 支持无 JavaScript 的纯 Markdown Capability；
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

- [ ] Capability 类型没有 tool/toolset 字段。
- [ ] Toolkit 是 tool、operation metadata 和 review policy 的唯一 owner。
- [ ] Toolkit 的每个工具由一个 `ToolDefinition` 完整描述。
- [ ] `AgentToolkit.tools` 必填、非空且 tool name 唯一。
- [ ] 公共 Toolkit 契约中不存在 `ToolkitResource`、`ToolkitContext` 或
  `exposure`。
- [ ] Toolkit instructions 是可选静态字符串。
- [ ] Toolkit availability 不复用 Capability availability 或暴露缓存策略。
- [ ] `AgentCapability.uses` 是必填静态强依赖。
- [ ] `uses` 不支持 optional。
- [ ] Capability instructions 是一个 Markdown document，而不是数组。

### Registry

- [ ] 缺少任一 Toolkit 时，Capability 在路由前被标记 unavailable。
- [ ] 注册 Toolkit 不会自动扩大 general executor 工具面。
- [ ] run-scoped Toolkit 可以被当前 run 的 Capability 解析。
- [ ] 同一 executor 内同名 tool 在运行前 fail-fast。

### Prompt

- [ ] 未选中的 Capability 正文不会进入模型上下文。
- [ ] 选中的 `CAPABILITY.md` 正文只注入一次。
- [ ] system prompt section 顺序确定且可观测。
- [ ] 动态 runtime facts 与静态 Capability instructions 分离。

### 扩展体验

- [ ] 一个无代码 `CAPABILITY.md` 可以安装、验证、列出和执行。
- [ ] Capability Creator 默认生成 V2 目录。
- [ ] Toolkit 继续通过 TypeScript/JavaScript 代码插件定义。
- [ ] Loader 对路径逃逸、空正文、重复名称和未知 Toolkit 给出明确错误。

### 迁移

- [ ] Daily Post、Capability Creator、Studio Plan、Artifact Discovery 不再使用
  Toolset。
- [ ] Explore 不再运行时过滤 `uses`。
- [ ] 所有现有单元测试、typecheck 和 build 通过。
- [ ] 新增依赖解析、工具冲突、Markdown loader 和 prompt 注入测试。

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
CAPABILITY.md 是 Capability instructions 的唯一静态来源。
Toolkit registry 是 inventory，不是授权列表。
orchestrator 是唯一 Capability 编排者。
```
