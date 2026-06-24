# Pet Agent Capability Artifact Store Design

本文档补齐 Studio / Pet / Capability 架构里的 **capability artifact store** 设计。

它回答一个具体问题:capability / subagent 运行完成后产生的结构化产物放在哪里,以及为什么 completed lane messages 可以被删除而不丢产物。

相关文档:

- `docs/PET_AGENT_STUDIO_ARCHITECTURE_OVERVIEW.md` —— 三层架构心智模型。
- `docs/PET_AGENT_STUDIO_ORCHESTRATOR_DESIGN.md` —— Studio 编排、dispatch、wiki_curator。
- `docs/PET_AGENT_STUDIO_INTERFACES.md` —— Studio ↔ Pet 调用边界。
- `docs/CONTEXT_GOVERNANCE_REFACTOR.md` —— lane message 折叠 / 删除。

## TL;DR

**Capability artifacts 是 durable store 里的产物,不是 lane message,也不是 `ToolMessage.artifact`。**

```text
Capability / Subagent
  -> 产生结构化产物
  -> sink 到 CapabilityArtifactStore
  -> 返回 ArtifactRef[]

PetAgentRuntime.invoke()
  -> reply 文本引用 ArtifactRef
  -> result.artifacts 携带 ArtifactRef[]

StudioDispatchState
  -> resultText
  -> artifacts: ArtifactRef[]

Studio / UI / 下一棒 pet
  -> 通过 ArtifactRef 读取 store
  -> wiki_curator 可把 artifact 摘要/引用整理进 wiki

completed lane messages
  -> 可以删除,因为运行现场不是产物存储
```

这条路径与 LangChain 的 `ToolMessage.artifact` 不是一回事。`ToolMessage.artifact` 只是工具调用结果里的临时结构化回执,可作为 capability 内部读取 result 的桥;真正需要长期保留、跨 dispatch 读取、UI 展示或后续 pet 消费的产物,必须 sink 到 artifact store。

## Store 的职责

CapabilityArtifactStore 负责存放 capability 运行产生的 durable artifacts:

- 文本/Markdown/JSON 结构化结果,例如 explore report、script outline、final deliverable。
- 文件资产,例如图片、音频、视频、PDF、压缩包。
- 外部对象引用,例如服务端 postId、素材库 assetId、远程 URL。
- 复合 manifest,例如一个 report 引用多个文件和数据表。

Store 不负责:

- 保存 subagent 全量消息流水。
- 保存 tool lifecycle event。
- 做 Studio wiki 的主题整理。
- 替代 checkpoint / LangGraph state。
- 替代业务数据库的最终业务对象。业务对象可以由 artifact 引用,但 artifact store 不应伪装成业务主表。

## 与其他存储层的边界

| 层 | 存什么 | 生命周期 | 谁写 | 谁读 |
|---|---|---|---|---|
| lane messages | subagent 运行现场、tool calls、临时 notes | 短生命周期;completed 后可折叠 | pet-agent runtime | 当前 delegation 续跑、debug trace |
| capability artifact store | capability 产物与引用 | durable;按 conversation/dispatch/artifact 生命周期保留 | capability runtime / pet runtime sink | UI、Studio、后续 pet、curator |
| Studio Whiteboard wiki | 协作知识摘要、主题笔记、source 摘录 | per-conversation 持久 | wiki_curator | pet 通过 wiki_read |
| checkpoint store | graph 恢复状态、HITL pending state | thread/checkpoint 生命周期 | LangGraph | runtime resume |
| app/backend store | 业务对象,如 post、积分、interaction | 产品生命周期 | 业务 API | app/backend |

关键边界:

- **artifact store 保存产物本体或引用**。
- **wiki 保存对产物的可检索解释**。
- **lane messages 保存运行过程**。

因此,completed lane 清理时只清运行过程,不清 artifact store。

## 核心类型

建议的最小 contract:

```ts
type CapabilityArtifactKind =
  | 'markdown'
  | 'json'
  | 'file'
  | 'image'
  | 'audio'
  | 'video'
  | 'external_ref'
  | 'manifest';

type CapabilityArtifactRef = {
  artifactId: string;
  kind: CapabilityArtifactKind;
  title: string;
  summary?: string;
  mimeType?: string;
  uri?: string;              // file:// 不建议跨边界暴露;本地实现可用相对 store URI
  createdAt: string;
  studioId?: string;
  conversationId?: string;
  turnId?: string;
  dispatchId?: string;
  petId?: string;
  capabilityName?: string;
  metadata?: Record<string, string | number | boolean | null>;
};

type CapabilityArtifactInput = {
  kind: CapabilityArtifactKind;
  title: string;
  summary?: string;
  content?: string | Uint8Array | Record<string, unknown>;
  mimeType?: string;
  sourceUri?: string;
  metadata?: Record<string, string | number | boolean | null>;
};

type CapabilityArtifactStore = {
  create(input: CapabilityArtifactInput, scope: CapabilityArtifactScope): Promise<CapabilityArtifactRef>;
  read(ref: Pick<CapabilityArtifactRef, 'artifactId'>): Promise<CapabilityArtifactRecord>;
  list(scope: Partial<CapabilityArtifactScope>): Promise<CapabilityArtifactRef[]>;
};

type CapabilityArtifactScope = {
  studioId?: string;
  conversationId?: string;
  turnId?: string;
  dispatchId?: string;
  petId?: string;
  capabilityName?: string;
};
```

`CapabilityArtifactRef` 是跨边界传递的稳定对象;artifact content 本体按需读取,不塞进 prompt、dispatch state 或 event stream。

## 写入时机

artifact sink 发生在 capability boundary,而不是 Studio wiki_curator。

推荐顺序:

```text
subagent run
  -> capability middleware.afterRun / readResult
  -> sink artifact store
  -> produce CapabilityArtifactRef[]
  -> tag completed announce
  -> readResult returns summary + refs
  -> laneMessagesForStateUpdate removes verbose lane messages
```

对 `explore` 尤其重要:

- `explore` 的 raw tool output 可以很大,不应该长期保存在 lane messages。
- `explore` final ingest 已经在 `afterRun` 生成 summary。
- 在 completed announce 前,把 summary/evidence manifest sink 成 artifact。
- completed lane 删除后,只保留 announce + result refs;artifact store 仍可读。

## Pet / Studio 边界

`PetAgentRuntime.invoke()` 的返回值应从纯文本扩展为文本 + artifact refs:

```ts
type PetInvokeResult = {
  reply: string;
  artifacts?: CapabilityArtifactRef[];
};
```

Studio dispatch state 也应保存 refs:

```ts
type StudioDispatchState = {
  id: string;
  taskIndex: number;
  petId: string;
  status: 'running' | 'finished' | 'cancelled';
  resultText?: string;
  artifacts?: CapabilityArtifactRef[];
  errorMessage?: string;
};
```

UI 最终渲染:

```text
turn_finished(finalDispatchId)
  -> 读取 final dispatch resultText
  -> 渲染 resultText
  -> 根据 dispatch.artifacts 渲染附件/卡片/预览
```

后续 pet 需要上游产物时,Studio 不把 artifact 本体塞进 brief。brief 只说明任务和上游产物存在;pet 可通过 wiki 看到 artifact 摘要/引用,必要时通过 artifact read tool 按 ref 读取内容。

## 与 Wiki Curator 的关系

wiki_curator 不拥有 artifact store,也不负责创建 capability artifact。它在 pet 返回后读取 `resultText + ArtifactRef[]`,把适合协作的内容整理进 wiki:

- 在 `topics/*.md` 中解释 artifact 是什么、由哪棒产生、什么时候该用。
- 在 `sources/{dispatchId}-{petId}.md` 中记录 resultText 摘要和 artifact refs。
- 对大型 artifact 只写 ref 和摘要,不复制本体。

这样 wiki 是“可检索知识层”,artifact store 是“产物持久层”。

## Store 实现建议

MVP 可以用 filesystem-backed store:

```text
{AGENT_HOME}/studio/{studioId}/conv/{conversationId}/artifacts/
  ├─ index.jsonl
  └─ {artifactId}/
      ├─ artifact.json      # metadata + ref
      └─ content            # markdown/json/file bytes
```

本地实现要求:

- `artifactId` 由 store 生成,不要由 LLM 生成。
- 写入必须是原子操作:先写 tmp,再 rename。
- `index.jsonl` 只作为 lookup/cache;单个 artifact 目录是权威记录。
- 不在 artifact ref 中暴露绝对本机路径给 app/API;用 store-local uri 或 artifactId。

服务端实现可以映射到对象存储 + 数据库:

- blob/object storage 存 content。
- 数据库表存 metadata、scope、权限、索引。
- `artifactId` 是权限检查和读取的唯一入口。

## 权限与安全

- artifact 继承 scope 权限:conversation / studio / owner user。
- 后续 pet 读取 artifact 需要通过 runtime 提供的 read 工具或 host API,不能直接读任意文件路径。
- artifact store 不执行 artifact 内容里的指令;内容与邮件/网页/附件一样都是 untrusted data。
- 删除 artifact 必须是显式维护动作;completed lane cleanup 不能级联删除 artifact。
- 对外部 URL / file path artifact,store 应保存来源和创建者,UI 渲染时做安全提示。

## 当前代码的迁移含义

现有 `readLatestToolArtifact()` / `content_and_artifact` 模式可以继续作为 capability 内部的 result extraction helper,但不要把它当作 durable artifact store。

迁移方向:

1. 在 runtime context 中注入 `artifactStore` 或 `artifactSink`。
2. capability `afterRun` / `readResult` 里把最终产物 sink 成 `CapabilityArtifactRef[]`。
3. `capabilityResult` 扩展为携带 refs。
4. `PetAgentRuntime.invoke()` 将 refs 合并进 `{ reply, artifacts }`。
5. `StudioDispatchState` 与 `dispatch_finished` event 携带 refs。
6. wiki_curator 使用 refs 写 wiki 摘要。

这样 lane messages 的清理、explore context ingest、Studio finalization 三者不会互相踩边界。

## Open Questions

- artifact store 是 pet-agent core 提供接口、local-agent 提供实现,还是完全由 host 注入?
- artifact read 是否作为 Studio 模式默认 toolkit 暴露给 pet?
- artifact refs 是否需要版本号,支持同一 artifact 后续修订?
- 大型二进制 artifact 是否需要异步上传状态(`pending` / `ready` / `failed`)?
- app/backend 业务对象与 artifact store 的引用关系由谁维护?
