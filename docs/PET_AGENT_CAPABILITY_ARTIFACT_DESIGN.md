# Pet Agent Capability Artifact Design

> 状态：Draft v1
> 日期：2026-06-16
> 关联：`PET_AGENT_CAPABILITY_RUNTIME_DESIGN.md`、`CONTEXT_GOVERNANCE_REFACTOR.md`、`EXPLORE_KNOWLEDGE_INGEST_DESIGN.md`
> 后续对齐：当前实现以
> `PET_AGENT_CAPABILITY_ARTIFACT_REDESIGN.md` 为准。本文保留为设计背景；
> 其中“模型调用 artifact toolkit 写入”和“orchestrator 读取 artifact 全文”
> 的早期方案已被 deterministic capability write + bounded ref preview 取代。
> 2026-07-19：entryDecision 不再接收 artifact inventory；selected subagent 只在需要时
> 通过当前 thread 的 scoped `artifact_list_dir` / `artifact_view_file_chunk` 自主发现。下文 Phase/State 示例是历史草案，
> 不作为当前接口定义。

## 1. 背景

现有 capability result 设计只覆盖了一类场景：一次 capability 执行后，host 读取一个小型结构化 JSON 结果。

这对 `dailyPost`、`capabilityCreator` 这类任务足够，但对 `explore`、媒体生成、文件产出类 capability 不够：

- `explore` 的结果可能是长报告、证据索引和后续待办，而不是一个小 JSON。
- 图片、视频、PDF、压缩包等产物不能塞进 message 或 LangGraph state。
- 如果把完整结果一次性注入全局上下文，会造成 context 和 checkpoint 膨胀。
- 如果只保留 announce，下次 explore 可能不知道前一次已经探索过什么，导致重复探索。

因此需要把能力产出抽象为 **capability artifact**：

- result 是 artifact 的一种，通常是 `application/json`。
- 长报告、图片、视频、PDF、文件夹包也都是 artifact。
- LangGraph state 只保存短引用和 preview。
- artifact 内容落到会话线程目录下，后续通过工具按需读取。

## 2. 核心结论

`capabilityResult` 不应该继续作为跨边界产出的核心抽象。新的核心抽象是 `capability_artifact`。

```text
capability subagent
  -> 调用 capability_artifact_write
  -> host artifact store 立即落盘并返回 ref
  -> subagent result 携带 artifacts[]
  -> LangGraph state 保存 CapabilityArtifactRef
  -> orchestrator 默认只读 bounded preview
  -> 需要细节时通过 artifact tools 读取内容
```

关键边界：

- capability 负责定义自己产出什么 artifact、schema 是什么、preview 怎么写。
- pet-agent runtime 负责把 subagent loop 内产生的 artifact refs 合并进 state。
- host 负责具体存储实现、文件路径、原子写、hash、GC。
- orchestrator 不理解 explore / image / video 的业务字段，只消费通用 artifact ref。

## 3. 设计目标

1. 统一承载结构化 result、长文本报告、图片、视频、PDF、文件包等 capability 产物。
2. 避免大结果直接进入 LangGraph state 或 LLM context。
3. 让后续 turn 能知道前序 capability 已产出什么，减少重复探索。
4. 保留 capability 对自己语义的定义权，main agent 不解析 capability 私有业务格式。
5. 与现有 session / thread / checkpoint 生命周期对齐。
6. 为后续检索、索引、UI 渲染留下扩展点，但 v1 不引入 heavy memory / knowledge graph 依赖。

## 4. 非目标

- v1 不做向量索引或 knowledge graph。
- v1 不让 pet-agent runtime 用 LLM 总结 artifact 内容。
- v1 不从自由文本里 `JSON.parse` 得到 result。
- v1 不让 main agent 理解 explore 的业务 schema。
- v1 不把 artifact 内容写进 checkpoint object。

## 5. 不变量

1. **state 存引用，不存内容**：LangGraph state 只保存 `CapabilityArtifactRef[]`，不保存大 JSON、长 markdown 或二进制内容。
2. **URI 过境，路径不过境**：state 中不保存绝对文件路径，只保存 `capability-artifact://...` 逻辑 URI。
3. **capability 主动沉淀产物**：subagent 通过 `capability_artifact_write` 写入 artifact；pet-agent runtime 只接收 refs，不解析 message metadata。
4. **默认上下文有界**：prompt 中最多注入 artifact title / type / preview / URI，且按预算裁剪。
5. **完整内容按需召回**：需要读取 artifact 内容时，通过工具读取，不默认注入。
6. **resultSchema 继续存在**：`AgentCapability.resultSchema` 仍是 JSON result artifact 的 schema，不需要创造平行 contract。

## 6. 概念收缩

v1 只需要一个公开核心概念：`CapabilityArtifactRef`。

另外两个名字不应该升级为公共 contract：

- `Artifact candidate`：不保留为核心概念。它只是 capability / tool 调用写入工具前的临时输入。
- `CapabilityArtifactManifest`：不保留为 pet-agent contract。`manifest.json` 是 local-agent artifact store 的私有落盘格式。

因此对外心智模型收缩为：

```text
capability_artifact_write（subagent loop 内的一等动作）
  -> host artifact store 保存内容
  -> CapabilityArtifactRef（进入 LangGraph state / prompt / UI）
```

## 7. 公开模型

### 7.1 Artifact ref

`CapabilityArtifactRef` 是写入 LangGraph state 的短引用。

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
  id: string;
  threadId: string;
  capabilityId: string;
  delegationId: string;
  turnId: string;
  kind: CapabilityArtifactKind;
  mimeType: string;
  uri: string;
  title?: string;
  preview?: string;
  sizeBytes: number;
  sha256?: string;
  createdAt: string;
  schema?: {
    name: string;
    version: number;
  };
  metadata?: Record<string, unknown>;
};
```

约束：

- `uri` 是 artifact 的稳定逻辑地址，不是本地路径。
- `preview` 必须短，面向 route / outcome decision，不是完整摘要。
- `metadata` 只放低风险、小体积字段，例如 tags、dimensions、duration、sourceCount。
- `schema` 用于 JSON result 或结构化 artifact 的版本识别。

### 7.2 Artifact write payload

write payload 是 capability / tool 调用 `capability_artifact_write` 时提交给 store 的输入，不是 message metadata contract。

payload 字段与 `CapabilityArtifactRef` 尽量同名，但多出写入来源：

- `content`：JSON / markdown / `Uint8Array` 等 inline 内容。图片生成模型的 `b64_json` 或下载后的图片 bytes 都走这里。
- `externalUri`：远程 URL 引用，例如后端带外生成的 CDN / 对象存储地址；store 不下载、不复制字节。

不再支持 `sourceUri` / 本地绝对路径导入。这样 artifact 写入不会成为任意文件读取入口。

## 8. 存储布局

v1 使用独立 artifact store，不耦合 `FileSaver` 的内部 CAS 目录。默认落盘在 agent `workdir` 下，方便和当前项目/会话目录一起查看、清理和迁移；host 仍可显式注入其他 root。

```text
<workdir>/.pinpawo/
  capability-artifacts/
    threads/
      <encodedThreadId>/
        <encodedDelegationId>/
          manifest.json
          result.json
          report.md
          images/
            hero.png
            hero.thumb.webp
          videos/
            demo.mp4
          files/
            output.pdf
```

选择独立目录的原因：

- artifact 生命周期与 session/thread 对齐，但不是 checkpoint 的内部状态。
- 图片、视频、PDF 不适合混入 checkpoint object。
- 后续可以单独做大小限制、GC、上传、UI 打开，不影响 LangGraph checkpointer。

URI 示例：

```text
capability-artifact://thread/petbot%3Atui%3Apet%3Aabc%3A1234/delegation/dg_01/artifact/result
capability-artifact://thread/petbot%3Atui%3Apet%3Aabc%3A1234/delegation/dg_01/artifact/report
capability-artifact://thread/petbot%3Atui%3Apet%3Aabc%3A1234/delegation/dg_02/artifact/image_hero
```

本地实现负责把 URI 解析到实际文件。state、prompt、message metadata 中都不出现绝对路径。

## 9. LangGraph State

新增一个持久 state channel：

```ts
const OrchestratorState = Annotation.Root({
  // existing
  messages: Annotation<BaseMessage[]>({ ... }),

  sessionCapabilityArtifacts: Annotation<CapabilityArtifactRef[]>({
    reducer: mergeCapabilityArtifactRefs,
    default: () => [],
  }),
});
```

`sessionCapabilityArtifacts` 是当前 thread 可引用的 capability 产物索引，内容只存 refs。结构化 result 也是 `kind: 'result'` 的 artifact，不再有单独的 `capabilityResult` state channel。

`buildRunStateReset()` 不应重置 `sessionCapabilityArtifacts`。否则下一轮对话看不到前序 artifact refs。

`turnDelegations` 可以记录本次 delegation 产出的 artifact ids，用于 UI 和 trace，但不作为长期索引的唯一来源。

## 10. 执行流程

### 10.1 产出 artifact

capability 运行时，subagent 通过 `capability_artifact_write` 写入 artifact：

```ts
await capability_artifact_write({
  kind: 'report',
  mimeType: 'text/markdown',
  title: 'issue explore result',
  preview: '已确认重复探索的原因是...',
  content: '...full markdown...',
  schema: { name: 'ExploreReport', version: 1 },
});
```

也可以记录后端带外生成的远程媒体：

```ts
await capability_artifact_write({
  kind: 'image',
  mimeType: 'image/png',
  title: 'generated hero image',
  preview: '1024x1024 hero image for campaign draft',
  externalUri: 'https://cdn.example.com/hero.png',
  metadata: { width: 1024, height: 1024 },
});
```

### 10.2 pet-agent runtime 收集

capability 节点结束时：

1. `capability_artifact_write` 在 subagent loop 内直接调用 host artifact store。
2. 写入成功后返回 `CapabilityArtifactRef`，并通过 subagent artifact sink 记录到 `SubagentResult.artifacts`。
3. `capabilityNode` 不扫描 message metadata，只把 `result.artifacts` merge 进 `state.sessionCapabilityArtifacts`。
4. 对 `kind: 'result'` 且 capability 声明了 `resultSchema` 的写入，在 `capability_artifact_write` 执行前校验 schema。

### 10.3 prompt 使用

entryDecision 不注入 artifact inventory。当前 active delegation 的 outcomeDecision 可以读取
该任务的 bounded refs；selected subagent 可通过 scoped file discovery 自主按需读取历史 artifact：

```text
最近 capability artifacts:
- [report] issue explore result
  capability: explore
  uri: capability-artifact://...
  preview: 已确认重复探索的原因是...
- [image] generated hero image
  capability: image.generate
  uri: capability-artifact://...
  preview: 1024x1024 hero image for campaign draft
```

预算规则：

- entryDecision 不看 artifact refs；outcomeDecision 只看当前 active delegation 的 refs。
- delegation outcome decision 可以看本次 delegation 新产出的 artifact refs。
- 不把 artifact 完整内容拼进 prompt。
- preview 超预算时裁剪，而不是读取文件内容压缩。

## 11. 历史方案：读取工具（已废弃）

这一节保留为早期方案背景。当前实现以
`PET_AGENT_CAPABILITY_ARTIFACT_REDESIGN.md` 为准：没有通用
`capability_artifact` toolkit；artifact 写入由 capability 代码确定性完成，
orchestrator 默认只消费 bounded ref preview。

早期 v1 曾计划提供通用 artifact 工具，给 capability subagent 按需召回。

artifact 读写能力是普通 toolkit，而不是 orchestrator 的内建能力。推荐通过 capability runtime 的 `uses: ['capability_artifact']` 装配到需要它的 subagent 上：

- `explore` 需要读取既有探索报告，挂 `capability_artifact`。
- 图片、视频、PDF 生成 capability 需要保存产物，挂 `capability_artifact`。
- orchestrator 默认不挂 artifact toolkit，只消费 `CapabilityArtifactRef` 的 bounded preview。

只有当某个上层 agent 明确需要亲自读取 artifact 全文时，才给那一层挂 read-only artifact toolkit。默认职责划分是：orchestrator 负责路由和委派，subagent 负责读取/加工/保存 artifact。

```ts
capability_artifact_list({
  capabilityId?: string;
  kind?: CapabilityArtifactKind;
  query?: string;
  limit?: number;
})

capability_artifact_read({
  uri: string;
  maxBytes?: number;
  jsonPath?: string;
})

capability_artifact_open({
  uri: string;
})
```

约束：

- `list` 默认只返回 refs 和 preview。
- `read` 默认限制 bytes，避免把大文件读进上下文。
- `jsonPath` 只作用于 JSON artifact 的结构化内容，不做文本转 JSON。
- `open` 是 local-agent / UI 能力，不属于 core pet-agent 必需能力。

后续如果需要索引，可新增：

```ts
capability_artifact_search({
  query: string;
  kind?: CapabilityArtifactKind;
  limit?: number;
})
```

搜索可以先用 manifest title / preview / tags 的轻量文本索引，不需要一开始上向量库或 KG。

## 12. 与 resultSchema 的关系

`AgentCapability.resultSchema` 原本就是能力结构化结果的 contract，应该继续沿用。

调整后的解释：

- `resultSchema` 定义 `kind: 'result'`、`mimeType: 'application/json'` 的 artifact payload。
- schema 校验成功后，payload 持久化为 JSON artifact。
- host 需要结构化结果时，从 `state.sessionCapabilityArtifacts` 按
  `capabilityId` / `delegationId` / `turnId` / `schema` / `metadata`
  选择匹配的 `kind: 'result'` ref，再通过 artifact store 读取并用调用方
  schema parse；不存在跨所有 capability 的全局 latest result。

也就是说，`resultSchema` 不被废弃；废弃的是“把 capability 的跨边界产出等同于一个小型 in-state JSON”的假设。

## 13. 为什么要移除 readResult(laneOutputMessages)

`readResult(messages)` 的问题不是“从 messages 里读东西”本身，而是它把 capability 私有结果提取逻辑挂到了 pet-agent runtime 调用点：

- dailyPost / capabilityCreator 不再从消息里抓 `ToolMessage.artifact`。
  它们在能力 `afterRun` 中直接持久化 `result` artifact，main agent 只消费 `CapabilityArtifactRef`。
- explore 用 `AIMessage` 的 `Explore summary:` marker 为当前 run 提供可读摘要；持久化仍由
  capability 侧在 `afterRun` 写 `report` artifact。
- pet-agent runtime 需要知道每个 capability 的读取函数。
- 结果提取发生在完整 lane transcript 上，容易让人误以为 main agent 可以理解 subagent 场景。

新的方式是：

- capability / subagent 自己调用 `capability_artifact_write`。
- pet-agent runtime 只接收 `SubagentResult.artifacts`。
- capability 私有语义已经在写入工具调用前完成。
- main agent 只消费 `CapabilityArtifactRef`。

lanes message 机制继续负责对话隔离；artifact 不再借 message metadata 过境。

## 14. Explore 的落点

`explore` 可以产出两个 artifact：

```text
kind: result
mimeType: application/json
schema: ExploreResult v1
content:
  status
  summaryPreview
  nextSteps

kind: report
mimeType: text/markdown
title: issue explore result
preview: 已确认的关键事实和下一步
content:
  ## 目标
  ## 已查看文件
  ## 关键知识点 / 概念
  ## 已确认事实
  ## 未确认 / 风险
  ## 下一步
```

route / outcome decision 默认看到 `preview`，知道“这个 issue 已经探索过”。如果后续需要细节，再通过 `capability_artifact_read(uri)` 读取报告。

这样可以避免：

- 每次都重复 explore。
- 把整份 explore report 塞进全局 context。
- pet-agent runtime 解析 explore 私有 summary 字段。

## 15. 媒体与文件类 capability

图片 / 视频 / PDF 产出直接成为 artifact：

```text
image.generate
  -> image/png artifact
  -> thumbnail webp artifact
  -> prompt / seed / dimensions in metadata

video.create
  -> video/mp4 artifact
  -> cover image artifact
  -> duration / resolution in metadata

report.export
  -> application/pdf artifact
  -> text/markdown source artifact
```

UI 根据 `kind` 和 `mimeType` 渲染，不需要把内容变成 chat message。

## 16. 生命周期与 GC

artifact 生命周期跟 thread/session 对齐。

建议规则：

- TUI session 删除时，删除该 session 对应 `threadId` 的 artifact 目录。
- `new_session` 只切换 active thread，不删除旧 session artifact。
- checkpoint thread 删除时，同步删除 artifact thread。
- artifact store 提供 per-thread size cap，超过时优先清理无 state ref 的旧 artifact。
- manifest 写入使用 tmp + rename，文件复制完成并校验 hash 后再更新 manifest。

v1 不需要复杂 GC。只要确保 session 删除时不会留下无限增长目录即可。

## 17. 安全约束

- state 中禁止保存绝对路径。
- artifact URI 解析必须校验 threadId / delegationId / artifactId，防止路径穿越。
- 不支持 `sourceUri` / 本地路径导入；inline bytes 用 `content: Uint8Array`，远程对象用 `externalUri`。
- 读取工具必须限制最大读取大小。
- 对二进制 artifact，默认不返回 base64 内容给 LLM，只返回 metadata 或可打开 URI。
- manifest 不记录 token、secret、完整环境变量。

## 18. 实施顺序

### Phase 1：contract 与本地 store

- 新增公开 `CapabilityArtifactRef` / `CapabilityArtifactWritePayload` 类型。
- 新增 `sessionCapabilityArtifacts` state channel，持久跨 run，不被 `buildRunStateReset()` 清空。
- 新增 local-agent `CapabilityArtifactStore`，默认落盘到 `<workdir>/.pinpawo/capability-artifacts/threads/<encoded-thread-id>/<encoded-delegation-id>/...`。
- `SubagentResult` 增加 `artifacts: CapabilityArtifactRef[]`。
- `capability_artifact_write` 写入 store 后回填 ref 到 subagent artifact sink。

### Phase 2：读取工具与 prompt bounded view

- 提供 `capability_artifact_list` / `capability_artifact_read`。
- entryDecision 不注入 artifact inventory；delegation outcome 只注入当前任务的 bounded refs。
- 对 prompt 注入做预算测试，确保不会因为大量 refs 膨胀。

### Phase 3：迁移现有 capability

- `dailyPost` / `capabilityCreator`：通过 `capability_artifact_write` 保存 JSON result artifact。
- `explore`：通过 `capability_artifact_write` 保存 JSON result artifact + markdown report artifact。
- 废弃 capability-specific `readResult(laneOutputMessages)` 和 message marker collector。

### Phase 4：UI 与媒体产物

- TUI / app-chat 展示 artifact chips。
- 图片 / 视频 / PDF 使用 `mimeType` 渲染或打开。
- session 删除时清理 artifact thread。

### Phase 5：轻量索引

- 基于 manifest 的 title / preview / tags 做文本索引。
- 只有当真实需求出现时，再评估向量索引或 knowledge graph。

## 19. 测试点

- JSON result artifact 通过 `resultSchema` 后写入 store，并在 state 中只保存 ref。
- 大 markdown report 不进入 state，只能通过 read tool 读取。
- 图片 artifact 可以 inline bytes 落盘，或以 `externalUri` 保存远程引用；state 中不出现绝对路径。
- 多个 artifact refs 跨 turn 保留，`buildTurnStateReset()` 不清空。
- outcomeDecision 对当前 delegation artifact refs 有预算裁剪，entryDecision 无 artifact inventory。
- `read` 工具 obey `maxBytes`。
- 删除 thread/session 时 artifact 目录被清理。
- host structured result 调用按 capability/delegation/turn/schema/metadata
  selector 选择匹配的 `kind: 'result'` artifact ref，读取内容并按调用方
  schema parse。

## 20. 未决问题

1. `sessionCapabilityArtifacts` state 是否设全局 ref 数量上限，还是只靠 prompt budget 和 artifact store GC。
2. Studio wiki 与 capability artifact 是否需要互相引用，还是保持 wiki 是 curated knowledge、artifact 是原始产物。
3. app-chat 远端同步时，artifact store 是本地优先还是需要上传到后端对象存储。
