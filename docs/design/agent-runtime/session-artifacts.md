# Session Artifacts

状态：draft，2026-10-29。第一阶段：显式发布、交付物链路、按需下载。替代 [Capability Artifact Pipeline](../../reference/artifacts/index.md)。

## 需求

一个 Agent session 在工作中产生的文件（报告、方案、导出的数据），需要能交给人或别的 Pet。参照 Claude projects 里一个任务 session 的做法：

- 文件由产生它的 session 显式发布，发布后有一个稳定的引用。
- session 的交付里一定带着这些引用，不依赖模型是否在正文里写了链接。
- 存储可以替换：本地目录是默认，也要能换成腾讯云 COS 这类对象存储。
- Chat、TUI、Studio 都是 Host，不经过 Studio 也必须能用；pet-agent 在服务器上复用时同样适用。

旧的 Capability Artifact Pipeline 不满足这个需求：它只有 Capability `lifecycle.finalize` 一个写入口，没有任何 Capability 实现过，store 从未写入；引用只在 graph state 里，模型和人都看不到。本设计不以它为前提。

## 第一阶段范围

做：

1. 显式发布：`publish_artifact` 把文件写进存储，返回稳定引用。
2. 交付物引用：工具结果声明交付物，核心把它收进委派的执行记录。
3. 按需下载：Agent 自己决定何时把引用下载到本地，再用现有文件工具读取。
4. 交付物跟着这次 run 的最终回复走，作为公开消息的结构化字段到达 Channel 和 Console。
5. 人通过 HTTP 打开引用。

不做（见[后续](#后续artifacts-管理)）：从引用反查归属、统一删除、保留策略、孤儿文件清理。

## 边界：运行时隔离与文件共享

这两件事分开：

- **运行时隔离**：Agent 运行期间不能访问其他 session 的上下文和运行态（消息、checkpoint、执行记录）。跨 Pet 交接不通过共享运行上下文实现。
- **文件可以显式共享**：artifact 引用是一个可以交出去的东西。发布方把引用写进交付或 Channel 消息，拿到引用的人或 Pet 就可以下载这个文件。没拿到引用的，看不到也列不出别的 session 发布了什么。

所以 `list_artifacts` 只列当前 session 发布的；`download_artifact` 接受任何引用。

## 概念

- **Artifact**：session 显式发布的一个文件快照。Pet 写到 workdir 或临时目录的文件都不算，只有调用 `publish_artifact` 发布的才算。发布时复制一份进存储，源文件之后被改、被删或在 `/tmp` 里被清掉，都不影响已发布的版本。再发布一次得到新的 artifact。
- **稳定引用**：`artifact://<key>`，长期有效，可以写进消息、交付和文档。`<key>` 本身就能定位存储对象（例如 `<workspaceId>/<threadId>/<artifactId>/<name>`），第一阶段不需要反查索引。
- **临时下载地址**：由存储按需生成，例如 COS 的签名 URL，有过期时间，只用于这一次下载，不写进消息或上下文。
- **交付物（Deliverable）**：一次 run 交给请求方的引用 `{ uri, title? }`。由工具声明，由执行记录收集，跟着这次 run 的最终回复走。artifact 是交付物的一种来源，其他工具也可以用同一约定声明交付物，比如创建 PR 后交付 PR 链接。
  - 和 `resultReferences` 分开：`resultReferences` 是执行证据的文本，供详情展示；Deliverable 是可以打开的引用。
  - 各层只原样传递，不从正文推断，也不改写正文。

## 分层

| 层 | 负责 |
|---|---|
| agent-contracts | `Deliverable` 类型与工具结果里 `deliverables` 的 schema；`ArtifactRef`、`artifact://` 解析 |
| pet-agent 核心 | 在工具结果产生时收集 `deliverables`，写进 `delegate_capability` 的执行记录。不认识 artifact store。 |
| artifacts Toolkit（独立包，如 `toolkits/artifacts`） | `ArtifactStore` 与 `ArtifactSourceReader` 两个 port；`publish_artifact` / `list_artifacts` / `download_artifact` 三个工具 |
| Host | 注入 store adapter（local / COS）与 source reader；把本 run 的交付物挂到 `message.completed`；HTTP 打开引用；可选的 session 产物段落 |
| agent-session 协议 | `message.completed.deliverables` 与 snapshot 里对应字段 |
| Channel Plugin | 把 Pet 回复事件里的 `deliverables` 原样存进消息 |
| 客户端（TUI / Console） | 渲染消息的 `deliverables` 与正文里的 `artifact://` 链接 |

## 交付物约定（agent-contracts + pet-agent）

工具在 `ToolMessage.artifact` 里用固定字段声明交付物：

```ts
type ToolDeliverables = { deliverables: Array<{ uri: string; title?: string }> };
```

硬约束：

1. 只有工具声明的才算交付物。模型是否调用 `publish_artifact` 不能保证；能保证的是调用了就一定记下。没发布的情况靠 toolkit instructions 引导，由 Supervisor 验收把关（要求交付文件但没有交付物，判为未完成）。
2. schema 在工具侧校验，格式不对在工具返回前报错，不静默忽略。
3. 核心在工具结果产生时收集，不在委派结束后扫消息，因为 Capability 的私有上下文会自己压缩。同一委派的多轮尝试累加，同一 uri 去重。
4. 和委派结果状态无关：被拒绝或取消的委派，已声明的交付物照样记录。
5. 只在 Capability 执行中产生；Entry 和 Supervisor 只调控制类工具。

执行记录变为 `{ status, delivery: { text }, deliverables }`。Supervisor 验收和 Entry 回复时看到的是这份数据，和正文是否写了链接无关。

## 交付物链路

沿用现有的 `resultReferences` 路径：Host 的 `readReplyResultReferences`（`services/host/src/conversation/transcriptProjection.ts`）从回复所属 run 的执行记录取出 delivery，挂到 `message.completed`，再进 snapshot 和 Console。交付物在这条路上多带一个字段：

```text
工具结果 ToolMessage.artifact.deliverables
  -> delegate_capability 执行记录 deliverables          （pet-agent，工具结果产生时收集）
  -> message.completed.deliverables                       （Host readReplyDeliverables）
  -> Channel 消息 deliverables                            （Channel recordPetMessage 原样存）
  -> Console / TUI 渲染
```

- `readReplyDeliverables` 和 `readReplyResultReferences` 用同一个判定：回复所属的 run，执行状态为 `returned`。被 Supervisor 打回、之后重做的那次执行，已发布的文件留在 store 里，但不跟着回复走。
- 合并本 run 所有 returned 执行的交付物，同一 uri 去重，保持发布顺序。
- Channel 现有的 `artifacts: [{ uri, label?, version? }]` 改名为 `deliverables: [{ uri, title? }]`，语义是"这条消息交付的引用"。人发的消息也可以带。Console 现有的渲染改用新字段名。
- 不新增事件、存储表或投影逻辑，每一跳只多一个字段。

## artifacts Toolkit

```ts
type ArtifactRef = {
  uri: string;        // artifact://<key>
  name: string;
  title?: string;
  mimeType: string;
  size: number;
  sha256: string;
  createdAt: string;
};

type ArtifactStore = {
  put(input: {
    threadId: string; name: string; title?: string; mimeType: string;
    body: ReadableStream<Uint8Array>;
  }): Promise<ArtifactRef>;
  list(threadId: string): Promise<ArtifactRef[]>;
  /** 稳定引用 → 一次性下载：本地返回流，对象存储返回临时地址。 */
  fetch(uri: string): Promise<
    | { ref: ArtifactRef; body: ReadableStream<Uint8Array> }
    | { ref: ArtifactRef; url: string; expiresAt: string }
  >;
};

type ArtifactSourceReader = (input: { path: string; workdir: string | null }) => Promise<{
  name: string; mimeType: string; body: ReadableStream<Uint8Array>;
}>;
```

Store 只管数据，不做权限判断。

| 工具 | 作用 | 审核 |
|---|---|---|
| `publish_artifact(path, title?)` | 经 source reader 读文件（workdir、`/tmp` 或 session 临时目录），写入存储，返回 ref、一行可粘进回复的 Markdown 链接，并在工具结果里声明交付物 | 不需要 |
| `list_artifacts()` | 列出当前 session 发布的 artifacts | 不需要 |
| `download_artifact(uri, path?)` | 把引用下载到本地（默认 session 临时目录），返回本地路径；之后用 files 工具读取 | 写 workdir 时按 files 的写入审核；写临时目录不需要 |

- Agent 自己决定何时下载、何时读已有的本地文件；存储层不自动下载，也不直接返回正文。
- 发布时的 `threadId` 来自工具的 execution scope，模型不传。
- 必须在 Capability 的 `uses` 里声明 `artifacts` 才能用，内置 Capability 也一样。
- 单文件上限 100 MB，超过时 `publish_artifact` 报错，不截断；不设 session 总量上限。

## Host

Adapter 在 Host 配置里选：

- `local`（默认）：`~/.pinpawo/workspaces/<workspaceId>/artifacts/<threadId>/<artifactId>/<name>`，`fetch` 返回文件流。
- `cos`：bucket + prefix，对象键与 `<key>` 一致；`fetch` 返回签名 URL。密钥放在全局配置 `~/.pinpawo/config.json` 或环境变量，不进 workdir。

`ArtifactSourceReader` 按 files Toolkit 的规则解析路径（相对路径基于 workdir，绝对路径原样），只读普通文件。

人打开引用：Agent Session HTTP 增加 `GET /agent-session/artifacts?uri=…`，`local` 返回文件流，`cos` 302 跳到签名 URL。Studio HTTP Plugin 同样代理。Console 用 react-markdown 的 `urlTransform` 识别 `artifact://`，与现在的 `participant:` 链接同一处；TUI 显示标题和本地路径或 HTTP 地址。

可选：Host 在每次 root invocation 用 toolkit 导出的 `renderArtifactsSection(store, threadId)` 生成一个 common system section（最多 20 条，没有产物时不生成），补"历史压缩后 Entry 不知道有哪些产物"这一个场景。走现有的 `systemPromptSections`，不进 state 或 checkpoint。

## 后续：artifacts 管理

以下有价值，但不是第一阶段的前置条件，由独立的 artifacts 管理能力承接：

- 从引用反查归属（Pet、session、存储对象）和管理入口。
- 删除入口、保留策略、失败清理、孤儿文件处理。第一阶段不承诺随 session 删除自动清理。
- 是否需要一个通用机制，让 toolkit 按 scope 提供动态上下文。

## 移除的旧实现

不需要旧数据兼容，因为从未写入过：

- pet-agent：`types/artifact.ts`、`orchestrator/capabilityArtifacts.ts`、`orchestrator/artifacts/discovery.ts`、`sessionCapabilityArtifacts`、`SubagentResult.artifacts`、finalize context 中的 `artifactStore` / `recordCapabilityArtifact` / `artifactRefs`；`delegate_capability` 结果里的 `artifacts` 改为 `deliverables`。
- Host：`FileCapabilityArtifactStore`、`artifact_discovery` Toolkit、`capabilityArtifactRoot`、各处旧 store 注入；TUI 对 `artifact_discovery_context` 信封的解析。
- 文档：`docs/reference/artifacts/` 移入 history。

Channel 消息的 `artifacts` 字段改名为 `deliverables`（见[交付物链路](#交付物链路)）。`lifecycle.finalize` 删除写入接口后仍可改写 output / messages，是否保留另行决定。

## 实现顺序

1. 删除旧 pipeline（一个 PR）。改 prompt 后重跑受影响的 Supervisor eval。
2. 交付物约定：agent-contracts 的 `Deliverable` 与 schema、核心收集、执行记录与 prompt。
3. 交付物链路：`message.completed.deliverables`、Channel 字段改名、Console / TUI 渲染。
4. artifacts Toolkit 与 Host `local` adapter、source reader。
5. HTTP 打开引用。
6. `cos` adapter。
