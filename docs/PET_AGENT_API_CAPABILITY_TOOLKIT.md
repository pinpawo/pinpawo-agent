# Capability 与 Toolkit 契约 API

> 状态：Capability / Toolkit V2
> 更新：2026-07-27

## 1. Capability

Capability 是 orchestrator 唯一可以委派的业务执行单元：

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
```

- `uses` 是 required Toolkit 依赖，也是完整工具权限边界。
- `instructions` 是一个不可变 Markdown 文档，不是字符串数组。
- `lifecycle.finalize` 只负责确定性整理已有执行结果；模型调用和外部操作必须来自 Toolkit。
- 缺少任一 required Toolkit 时，该 Capability 在本次 registry generation 中不可用。

代码定义示例：

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

目录定义示例：

```text
inspect/
├── CAPABILITY.md
└── index.js        # 可选；只能导出 lifecycle.finalize
```

```md
---
name: inspect
description: 检查代码库并整理证据。
uses:
  - bash
  - git
version: 1
---

# Inspect

只读取并总结与当前任务相关的内容。
```

## 2. Toolkit

Toolkit 是一组编码实现的工具和工具级运行策略，不是委派目标：

```ts
type AgentToolkit = {
  readonly name: string;
  readonly description: string;
  readonly tools: readonly ToolDefinition[];
  readonly instructions?: string;
  readonly availability?: ToolkitAvailabilityCheck;
  readonly reviewGuidance?: ToolkitReviewGuidance;
};

type ToolDefinition = {
  readonly tool: NamedStructuredTool;
  readonly operation?: ToolOperationMetadata;
  readonly review?: ToolReviewPolicy;
};
```

示例：

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

`availability` 每次组装 registry generation 时重新检查，不做跨 generation 缓存。Toolkit 被过滤后，依赖它的 Capability 会通过 registry diagnostics 报告不可用。

## 3. 编译与执行

Host 先组装完整定义，再编译 registry：

```ts
const registry = compileAgentRegistry({
  capabilities,
  toolkits,
});
```

编译过程：

```text
capability.uses
  -> resolve required Toolkits
  -> reject unknown/duplicate Toolkit dependencies and duplicate tool names
  -> snapshot Capability + Toolkit bindings
  -> expose one CompiledCapability
```

执行过程统一为：

```text
capability:<name> lane
  -> framework delegation + actor context
  -> declared Toolkit instructions
  -> Capability Markdown instructions
  -> tools from declared Toolkits only
```

General 也使用这条路径。它只是 planner 的默认候选，不拥有独立 executor、lane、tools 或依赖契约。

## 4. Artifact

`CapabilityArtifactStore` 是 host 提供的持久化 port：

- Capability 可以在 `lifecycle.finalize` 中写入结果 artifact。
- `artifact_discovery` Toolkit 按当前 thread 提供只读 `artifact_list` / `artifact_read`。
- 空 thread 返回空结果，不代表 Toolkit 不可用。
- 需要读取历史 artifact 的 Capability 必须在自己的 `uses` 中静态声明 `artifact_discovery`。

## 5. 不存在的兼容概念

V2 不包含：

- `CapabilityRuntime`
- `CapabilityContext.availableToolkits`
- inline `tools` / `toolsets`
- `defineToolset`
- `createRuntime`
- `generalUses`
- General 专属 executor 或授权开关

旧 manifest/runtime 插件格式没有兼容层；目录 Capability 使用 `CAPABILITY.md`。
