# Capability 与 Toolkit 契约 API

> 本文描述当前 V2 API。设计依据见
> [Capability / Toolkit Contract V2](./PET_AGENT_CAPABILITY_TOOLKIT_V2_DESIGN.md)。

## 1. Capability

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

代码定义的 Capability 使用 `defineCapability()` 和
`defineInstructionDocument()`。目录型 Capability 使用 `CAPABILITY.md`，
不需要 JavaScript。

规则：

1. `uses` 是静态强依赖，也是 Capability 的完整工具权限边界。
2. Capability 不拥有 tools、inline Toolkit、review policy 或 availability check。
3. instructions 是一个不可变 Markdown document，不按消息动态生成。
4. 缺少任一 required Toolkit 时，compiler 在路由前记录 diagnostics，并
   从可执行 registry 中排除该 Capability。

## 2. finalize-only 生命周期

```ts
type CapabilityFinalizeHook = (
  result: Readonly<SubagentResult>,
  context: CapabilityFinalizeContext,
) => CapabilityFinalizeResult | void
  | Promise<CapabilityFinalizeResult | void>;

type CapabilityFinalizeResult = {
  messages?: BaseMessage[];
  announceMessageId?: string | null;
  artifactRefs?: CapabilityArtifactRef[];
};
```

`finalize` 只能整理已有执行结果、生成 ingest、写 Capability artifact、
规范化消息和选择 announce。它不能接触或修改 tools、Toolkit、`uses`、
review policy、authorization、system instructions 或 `SubagentRunInput`，
也不能调度另一个 Capability。

模型调用的动作和外部业务副作用必须实现为 Toolkit tools。

## 3. Toolkit

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

Toolkit 是 tool implementation、operation metadata、review policy 和
availability 的唯一 owner。使用 `defineToolkit()` 做运行时校验；Toolkit
必须至少包含一个 tool，且同一 Toolkit 内 tool name 唯一。

## 4. Prompt 装配

subagent runtime 使用带 `id`、`owner`、`content` 的 prompt sections，按固定
顺序编译成一个 system prompt：

1. framework governing prompt；
2. delegation context；
3. `uses` 顺序对应的 Toolkit instructions；
4. 选中 Capability 的 Markdown document；
5. 动态 runtime facts。

运行时通过 `subagent_prompt_sections` 事件暴露 section id、owner 和内容
digest，不暴露正文。

## 5. 相关导出

- Capability：`packages/pet-agent/src/types/capability.ts`
- Toolkit：`packages/pet-agent/src/types/toolkit.ts`
- Prompt sections / Subagent：`packages/pet-agent/src/types/subagent.ts`
- Artifacts：`packages/pet-agent/src/types/artifact.ts`
