# Pet Agent Capability Artifact Design

> 状态：Draft v1
> 日期：2026-06-16
> 关联：`PET_AGENT_CAPABILITY_RUNTIME_DESIGN.md`、`CONTEXT_GOVERNANCE_REFACTOR.md`、`EXPLORE_KNOWLEDGE_INGEST_DESIGN.md`

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
  -> 标记标准 artifact marker
  -> pet-agent runtime 收集 marker
  -> host artifact store 落盘
  -> LangGraph state 保存 CapabilityArtifactRef
  -> orchestrator 默认只读 bounded preview
  -> 需要细节时通过 artifact tools 读取内容
```

关键边界：

- capability 负责定义自己产出什么 artifact、schema 是什么、preview 怎么写。
- pet-agent runtime 负责识别标准 marker、校验通用结构、把内容转成 artifact refs。
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
3. **capability 标记语义，runtime 通用收集**：subagent 输出标准 artifact marker；pet-agent runtime 只识别通用 marker，不读取 capability 私有字段。
4. **默认上下文有界**：prompt 中最多注入 artifact title / type / preview / URI，且按预算裁剪。
5. **完整内容按需召回**：需要读取 artifact 内容时，通过工具读取，不默认注入。
6. **resultSchema 继续存在**：`AgentCapability.resultSchema` 仍是 JSON result artifact 的 schema，不需要创造平行 contract。

## 6. 概念收缩

v1 只需要一个公开核心概念：`CapabilityArtifactRef`。

另外两个名字不应该升级为公共 contract：

- `Artifact candidate`：不保留为核心概念。它只是 capability / tool 在消息 metadata 上写的 **artifact marker**，或者 local-agent store 的内部写入参数。
- `CapabilityArtifactManifest`：不保留为 pet-agent contract。`manifest.json` 是 local-agent artifact store 的私有落盘格式。

因此对外心智模型收缩为：

```text
artifact marker（消息上的写入约定）
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

### 7.2 Artifact marker

artifact marker 是 capability / tool 写在 subagent message metadata 上的约定，不是一个需要暴露给消费者的领域对象。

marker 字段与 `CapabilityArtifactRef` 尽量同名，但多出写入来源：

- `content`：JSON / markdown 等小到中等文本内容。
- `sourceUri`：工具已经生成但尚未进入 artifact store 的图片、视频、PDF、文件包。
- `existingUri`：工具已经自行持久化到 artifact store 的产物。

`sourceUri` 也必须是逻辑 URI，例如 `tool-output://run/<runId>/hero.png`，不能是绝对文件路径。host 负责把 source URI 解析到受信临时目录。

## 8. 存储布局

v1 使用独立 artifact store，不耦合 `FileSaver` 的内部 CAS 目录。默认落盘在 agent `workdir` 下，方便和当前项目/会话目录一起查看、清理和迁移；host 仍可显式注入其他 root。

```text
<workdir>/.pinpawo/
  capability-artifacts/
    threads/
      <encodedThreadId>/
        <delegationId>/
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
  capabilityResult: Annotation<Record<string, unknown> | null>({ ... }),

  // new
  capabilityArtifacts: Annotation<CapabilityArtifactRef[]>({
    reducer: mergeCapabilityArtifactRefs,
    default: () => [],
  }),
});
```

`capabilityArtifacts` 与 `capabilityResult` 的区别：

| 字段 | 语义 | 生命周期 | 内容 |
|---|---|---|---|
| `capabilityResult` | 最近一次 JSON result 的兼容字段 | turn-scoped / invoke result | 小 JSON |
| `capabilityArtifacts` | 当前 thread 可引用的 capability 产物索引 | thread-scoped | refs only |

`buildTurnStateReset()` 不应重置 `capabilityArtifacts`。否则下一轮对话看不到前序 artifact refs。

`turnDelegations` 可以记录本次 delegation 产出的 artifact ids，用于 UI 和 trace，但不作为长期索引的唯一来源。

## 10. 执行流程

### 10.1 产出 artifact

capability 运行时，subagent 或 tool 通过标准 metadata 标记 artifact marker：

```ts
additional_kwargs: {
  pinpawo: {
    capabilityArtifacts: [
      {
        kind: 'report',
        mimeType: 'text/markdown',
        title: 'issue explore result',
        preview: '已确认重复探索的原因是...',
        content: '...full markdown...'
      }
    ]
  }
}
```

也可以标记工具已生成的文件：

```ts
additional_kwargs: {
  pinpawo: {
    capabilityArtifacts: [
      {
        kind: 'image',
        mimeType: 'image/png',
        title: 'generated hero image',
        preview: '1024x1024 hero image for campaign draft',
        sourceUri: 'tool-output://run/run_01/hero.png',
        metadata: { width: 1024, height: 1024 }
      }
    ]
  }
}
```

### 10.2 pet-agent runtime 收集

capability 节点结束时：

1. `tagNewLaneMessages(...)` 标记本次 delegation 的 lane messages。
2. generic collector 扫描本次 `laneOutputMessages` 中的标准 `pinpawo.capabilityArtifacts` marker。
3. collector 不解析自由文本，不理解 explore 私有字段。
4. 对 `kind: 'result'` 且 capability 声明了 `resultSchema` 的 marker，执行 schema 校验。
5. 校验通过后交给 host artifact store 持久化。
6. 返回 `CapabilityArtifactRef[]` 写入 `state.capabilityArtifacts`。
7. 若存在 JSON result artifact，可继续写入 `state.capabilityResult` 作为兼容字段。

### 10.3 prompt 使用

orchestrator prompt 默认只注入 artifact 的 bounded view：

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

- route prompt 只看最近或相关的 artifact refs。
- delegation outcome decision 可以看本次 delegation 新产出的 artifact refs。
- 不把 artifact 完整内容拼进 prompt。
- preview 超预算时裁剪，而不是读取文件内容压缩。

## 11. 读取工具

v1 提供通用 artifact 工具，给 capability subagent 按需召回。

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
- `capabilityResult` 可以作为兼容字段保留，值来自最新 JSON result artifact。
- 新消费方应优先读 `capabilityArtifacts` 和 artifact store。

也就是说，`resultSchema` 不被废弃；废弃的是“把 capability 的跨边界产出等同于一个小型 in-state JSON”的假设。

## 13. 为什么要移除 readResult(laneOutputMessages)

`readResult(messages)` 的问题不是“从 messages 里读东西”本身，而是它把 capability 私有结果提取逻辑挂到了 pet-agent runtime 调用点：

- dailyPost / capabilityCreator 从 `ToolMessage.artifact` 读。
- explore 从 `additional_kwargs.pinpawo.exploreSummary` 读。
- pet-agent runtime 需要知道每个 capability 的读取函数。
- 结果提取发生在完整 lane transcript 上，容易让人误以为 main agent 可以理解 subagent 场景。

新的方式是：

- capability / tool 自己在消息上打标准 artifact marker。
- pet-agent runtime 只收集标准 marker。
- capability 私有语义已经在 marker 生成前完成。
- main agent 只消费 `CapabilityArtifactRef`。

这仍然复用统一 lanes message 机制，但读取的是统一协议，不是 capability-specific parser。

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
- `sourceUri` 只能解析到受信 tool output 目录或显式允许的工作区产物。
- 读取工具必须限制最大读取大小。
- 对二进制 artifact，默认不返回 base64 内容给 LLM，只返回 metadata 或可打开 URI。
- manifest 不记录 token、secret、完整环境变量。

## 18. 实施顺序

### Phase 1：contract 与本地 store

- 新增公开 `CapabilityArtifactRef` 类型；artifact marker 类型可作为 runtime/store 内部写入类型实现。
- 新增 `capabilityArtifacts` state channel，持久跨 turn，不被 `buildTurnStateReset()` 清空。
- 新增 local-agent `CapabilityArtifactStore`，默认落盘到 `<workdir>/.pinpawo/capability-artifacts/threads/<threadId>/...`。
- 新增 generic artifact marker collector。
- 保留 `capabilityResult` 兼容路径。

### Phase 2：读取工具与 prompt bounded view

- 提供 `capability_artifact_list` / `capability_artifact_read`。
- route / delegation outcome prompt 注入 bounded artifact refs。
- 对 prompt 注入做预算测试，确保不会因为大量 refs 膨胀。

### Phase 3：迁移现有 capability

- `dailyPost` / `capabilityCreator`：把现有 `ToolMessage.artifact` 包装为 JSON result artifact。
- `explore`：产出 JSON result artifact + markdown report artifact。
- 废弃 capability-specific `readResult(laneOutputMessages)`，保留一段兼容适配。

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
- 图片 artifact 复制到 artifact store，state 中不出现绝对路径。
- 多个 artifact refs 跨 turn 保留，`buildTurnStateReset()` 不清空。
- route prompt 对 artifact refs 有预算裁剪。
- `read` 工具 obey `maxBytes`。
- 删除 thread/session 时 artifact 目录被清理。
- 兼容字段 `capabilityResult` 仍能满足旧 host structured result 调用。

## 20. 未决问题

1. artifact marker 是否直接放在 `additional_kwargs.pinpawo.capabilityArtifacts`，还是提供 helper API 统一生成。
2. `sourceUri` 允许范围是仅 tool temp dir，还是允许 workspace 内显式产物。
3. `capabilityArtifacts` state 是否设全局 ref 数量上限，还是只靠 prompt budget 和 artifact store GC。
4. Studio wiki 与 capability artifact 是否需要互相引用，还是保持 wiki 是 curated knowledge、artifact 是原始产物。
5. app-chat 远端同步时，artifact store 是本地优先还是需要上传到后端对象存储。
