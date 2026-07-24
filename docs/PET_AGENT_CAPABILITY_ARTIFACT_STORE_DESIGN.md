# Capability Artifact Store 设计（文档版）

> V2 注记：Capability 代码现在只通过窄化的
> `CapabilityFinalizeContext` 接收 store；下文 `CapabilityContext` /
> `afterRun` 是迁移前 API。

本文档是 `Pet Agent` 体系里“产物持久化”层的单文件说明。  
目标：把可复用的持久内容和执行时日志明确分离，避免把 `lane` 级临时消息当成可长期依赖的存储。

## 1. 结论先行

`capability artifact store` 负责的是**durable 产物引用 + 可读内容**，不是 LLM 的运行现场。  
在当前代码中：

- `CapabilityArtifactRef` 字段名是 `id`，不是 `artifactId`。
- `PetAgentRuntime.invoke()` 只返回 `{ reply: string }`。
- `capability artifact refs` 目前主要以内存状态（`state.sessionCapabilityArtifacts`）+ store ref 的方式在同/跨调用中使用；`ToolMessage.artifact` 仅作临时结构字段，非持久契约。
- `finalPetRunId` 是 Studio 结果身份；`finalDispatchId` 仅作为兼容字段存在于少量旧持久化记录，不是新规范。

## 2. 典型问题: 为什么 `lane` 不能当仓库

- `lane` 消息包含执行现场上下文、工具中间结果和 token 级噪音，生命周期通常与一次 run/turn 对齐；
- `lane` 级上下文改写/压缩处理会主动裁剪，无法作为长期检索入口；
- 任务完成后需要保留“跨 run 的可复用产物”时，必须靠 `CapabilityArtifactStore`。

因此“可继续访问的产物”始终走 store；`lane` 只负责过程。

## 3. 数据模型（按当前代码）

```ts
type CapabilityArtifactKind =
  | 'result'
  | 'report'
  | 'image'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'file'
  | 'bundle';

type CapabilityArtifactRef = {
  id: string;               // 由写入端确定的稳定标识
  threadId: string;
  capabilityId: string;
  delegationId: string;
  runId: string;            // 也作为主追踪维度
  kind: CapabilityArtifactKind;
  mimeType: string;
  uri: string;              // capability-artifact://thread/...
  title?: string;
  preview?: string;         // 对等于“head/摘要字段”的短文本
  sizeBytes: number;
  sha256?: string;
  externalUri?: string;
  createdAt: string;
  schema?: {
    name: string;
    version: number;
  };
  metadata?: Record<string, unknown>;
};

type CapabilityArtifactWriteInput = {
  threadId: string;
  capabilityId: string;
  delegationId: string;
  runId: string;
  artifact: {
    kind: CapabilityArtifactKind;
    mimeType: string;
    title?: string;
    preview?: string;      // short head-like digest
    schema?: { name: string; version: number };
    metadata?: Record<string, unknown>;
    content?: unknown;     // 与 externalUri 二选一
    externalUri?: string;  // 与 content 二选一
  };
};

type CapabilityArtifactStore = {
  writeArtifact(input: CapabilityArtifactWriteInput): Promise<CapabilityArtifactRef>;
  readArtifact(input: { uri: string; maxBytes?: number; threadId?: string })
    : Promise<{ ref: CapabilityArtifactRef; content: string | null }>;
  listArtifacts(input: { threadId: string; capabilityId?: string; kind?: string; limit?: number })
    : Promise<CapabilityArtifactRef[]>;
  deleteThreadArtifacts(threadId: string): Promise<void>;
  getDownloadUri(uri: string): Promise<string>;
  writeArtifacts?(inputs: CapabilityArtifactWriteInput[]): Promise<CapabilityArtifactRef[]>;
};
```

## 4. 架构价值（为什么要单独拿出一层）

- **可复用性**：lane 可被裁剪/重写；store ref 不会随着 context compression 丢失关键资产。
- **跨任务传递**：`state.sessionCapabilityArtifacts` 让后续 capability/pet 在同一 thread 下复用历史产物。
- **恢复与幂等**：store 重放基于稳定 ref，支持重试、恢复和离线读取，不依赖当前上下文全部原文。
- **安全与权限边界分离**：store 提供统一读取入口和命名空间约束，避免临时工具消息直接承载可共享内容。

## 5. 分层边界

| 层 | 负责 | 边界 | 生命周期 |
|---|---|---|---|
| `lane messages` | 执行现场 | 主流程上下文、工具回执、announce | `run` 级，允许裁剪 |
| `CapabilityArtifactStore` | 可长期读取产物 | 按 ref 读取内容 | `thread/delegation/run` 级 |
| `Studio wiki` | 人类可读协作知识 | 组织 `index/topics/sources` | 会话级 |
| `checkpoint` | 运行恢复 | 运行图状态/中间决策 | run/thread 级 |

## 6. 典型写入链路（代码路径）

1. capability 运行时拿到 `CapabilityContext.artifactStore`（注入自 orchestrator 配置）。  
2. 产物成型后调用 `store.writeArtifact(...)` 写入；返回 `CapabilityArtifactRef`。  
3. 同时把 ref 回传给子图层：
   - 通过 `CapabilityArtifactSink.recordCapabilityArtifact(ref)`（通常在 `afterRun` 执行）。  
4. 该 ref 进入 `SubagentResult.artifacts`，再进入 `state.sessionCapabilityArtifacts`。  
5. 后续 capability/pet 可在 prompt context 中看到短引用（`buildCapabilityArtifactContext`），需要细节再按 ref 到 store 读本体。

### 示例（概念）

```ts
const ref = await artifactStore.writeArtifact({
  threadId,
  capabilityId: 'explore',
  delegationId,
  runId,
  artifact: {
    kind: 'report',
    mimeType: 'text/markdown',
    title: 'Explore knowledge summary',
    preview: '关键结论 + 风险点',
    content: '# Summary ...',
  },
});
await sink.recordCapabilityArtifact?.(ref);
```

## 7. 本地实现（FileCapabilityArtifactStore）

- 根路径：`{workdir}/.pinpawo/capability-artifacts`。
- 目录结构：`threads/<encoded-thread-id>/<encoded-delegation-id>/`，内含 `manifest.json` 与内容文件；路径 segment 使用 `encodeURIComponent`，没有额外的 `delegation/` 目录层。
- URI 形态：`capability-artifact://thread/{threadId}/delegation/{delegationId}/artifact/{id}`（仅用于检索和鉴权映射，不要求客户端直接拼文件路径）。

当前行为：
- `id`/`uri` 可幂等重放；
- `content` 与 `externalUri` 二选一；
- `getDownloadUri` 对外返回可访问地址（本地 `file://` 或外链原值）；
- `deleteThreadArtifacts` 清理一个 `threadId` 下全部 artifact。

## 8. 与 `ToolMessage.artifact` 的边界

`ToolMessage.artifact` 不是 store 边界：它只适合把结构化片段挂到单次工具调用事件中。  
任何“后续 run/跨任务可读”的内容必须落到 `CapabilityArtifactStore`。

## 9. 与 `head`/`summary` 的关系（给你刚才的疑问）

- ref 没有 `head` 字段；有 `preview`。  
- 你可以把 `preview` 视作 `head`（简短摘要）；
- 如果外部协议要求强制 `head`，请在 adapter 层映射 `preview -> head`，但这不是 store 的原生字段。

## 10. 典型查询约定

为了避免全量扫描，应尽量按以下维度筛选：

- `threadId`（必需）
- `delegationId`（同一 capability 调用）
- `runId`（同一会话 run）
- `capabilityId`（能力维度）
- `kind`（result/report/image 等）

## 11. 兼容与迁移

- `finalDispatchId` 在本仓库中仅保留为兼容读取字段（due-run/fallback 兼容层），不再作为规范主名词。
- 如果看到文档里出现 `artifactId`、`finalDispatchId`、`invoke(...).artifacts`，均为过时表述；请以本页和实际类型定义为准。
