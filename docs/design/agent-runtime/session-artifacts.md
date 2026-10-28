# Session Artifacts

状态：draft，2026-10-28，待定问题已定。替代 [Capability Artifact Pipeline](../../reference/artifacts/index.md)。

## 需求

一个 Agent session 在工作中产生的文件（报告、方案、导出的数据），需要能交给人或别的 Pet 看。参照 Claude projects 里一个任务 session 的做法：

- 文件由产生它的 session 自己保管，不交给 Studio 或 Channel。
- session 自己的上下文里有这些文件的信息，至少有地址，压缩历史后也不能丢。
- 存储可以替换：本地目录是默认，也要能换成腾讯云 COS 这类对象存储。
- Chat、TUI、Studio 都是 Host，不经过 Studio 也必须能用；pet-agent 在服务器上复用时同样适用。

旧的 Capability Artifact Pipeline 不满足这个需求：它只有 Capability `lifecycle.finalize` 一个写入口，没有任何 Capability 实现过，store 从未写入；作用域是 Capability / delegation，引用只在 graph state 里，模型和人都看不到。它"port 在 pet-agent、实现在 Host"的分层可以沿用，其余不以它为前提。

## 概念

**Artifact 是 session 显式发布的一个文件快照，是 session 交付物的一部分。**

- 显式：Pet 写到 workdir 或临时目录的文件都不算 artifact，只有调用 `publish_artifact` 发布的才算。发布等于"这是我交付的东西"。
- 快照：发布时复制一份进 session 的 store。源文件之后被改、被删或在 `/tmp` 里被清掉，都不影响已发布的版本。再发布一次得到新的 artifact。
- 归属：一个 artifact 属于一个 session（`threadId`），session 删除时一起删除。
- 交付：artifact 和 delivery 文本是同一层的东西。执行方发布的 artifact 进入它的交付结果，Supervisor 验收时能看到。

## 分层

| 层 | 负责 | 不负责 |
|---|---|---|
| agent-contracts | `ArtifactRef` 类型与 `artifact://` 解析，供客户端共用 | 存取 |
| pet-agent | `ArtifactStore` port；`artifacts` Toolkit（工具定义、描述、执行逻辑）；`session_artifacts` 上下文段落；把 artifact 带进 delegate 结果 | 文件系统、具体存储、HTTP |
| Host | `ArtifactStore` adapter（local / COS）；`ArtifactSourceReader` port 的实现（读本地文件）；HTTP 读取路由；随 session 删除 | 段落格式、工具语义 |
| 客户端（TUI / Console） | 把正文里的 `artifact://` 链接渲染成文件卡片、打开或下载 | 存储 |
| Studio / Channel | 只存消息正文 | 保管文件 |

pet-agent 定义 session 语义，Host 只提供机器相关的实现。换一个宿主（包括服务器部署）只需要换 adapter 和 source reader，工具和上下文的格式不变。

## 类型与 port（pet-agent）

```ts
// @pinpawo/agent-contracts
type ArtifactRef = {
  id: string;          // store 内唯一，例如 art_<uuid>
  uri: string;         // artifact://<id>
  name: string;        // 文件名
  title?: string;
  mimeType: string;
  size: number;
  sha256: string;
  createdAt: string;
};

// @pinpawo/pet-agent
type StoredArtifact = ArtifactRef & {
  threadId: string;
  runId: string;
  delegationId?: string; // 在 Capability 执行中发布时才有
  sourcePath?: string;   // 发布时的源路径，仅供 session 自己回看
};

type ArtifactStore = {
  put(input: {
    threadId: string; runId: string; delegationId?: string;
    name: string; title?: string; mimeType: string; sourcePath?: string;
    body: ReadableStream<Uint8Array>;
  }): Promise<StoredArtifact>;
  list(threadId: string, filter?: { runId?: string; delegationId?: string }): Promise<StoredArtifact[]>;
  open(id: string): Promise<
    | { artifact: StoredArtifact; body: ReadableStream<Uint8Array> }
    | { artifact: StoredArtifact; redirectUrl: string }
  >;
  deleteSession(threadId: string): Promise<void>;
};

type ArtifactSourceReader = (input: { path: string; workdir: string | null }) => Promise<{
  name: string; mimeType: string; resolvedPath: string; body: ReadableStream<Uint8Array>;
}>;
```

- Store 只管数据，不做权限判断。权限由调用方（工具、HTTP 路由）决定。
- `ArtifactStore` 和 `ArtifactSourceReader` 由 Host 在创建 Pet runtime 时注入。没有注入时，`artifacts` Toolkit 和上下文段落都不出现。

## Toolkit：`artifacts`（pet-agent）

| 工具 | 作用 | 审核 |
|---|---|---|
| `publish_artifact(path, title?)` | 经 `ArtifactSourceReader` 读文件（workdir、`/tmp` 或 session 临时目录），写入当前 session 的 store，返回 ref 和一行可直接粘进回复的 Markdown 链接 | 不需要：只写自己 session 的 store |
| `read_artifact(uri, maxBytes?)` | 读当前 session 的 artifact 文本内容；二进制只返回 ref；其他 session 的 uri 一律拒绝 | 不需要 |
| `list_artifacts()` | 列出当前 session 的全部 artifacts，用于超出上下文段落上限时 | 不需要 |

- 发布时的 `threadId / runId / delegationId` 来自工具的 execution scope，模型不传。
- 同一 session 的 Entry、Supervisor、Capability 执行方共享一个 store，按 `threadId` 区分，和 lane 无关。
- 不默认开放：Capability 必须在 `uses` 里声明 `artifacts` 才能用，内置 Capability 也一样，按需声明。
- `/tmp` 可以作为草稿区，因为发布时已经复制。如果要让写临时文件不触发审核，可以再给每个 session 分一个临时目录并在其中自动放行，这件事单独做。

## 上下文（pet-agent）

每次 root invocation，pet-agent 从 `store.list(threadId)` 生成一个 common system section，和 Host 提供的 PET.md 等段落一起由 prompt 组合器渲染，所有角色都能看到：

```xml
<session_artifacts role="fact" source="runtime" authority="none" total="3">
  <artifact uri="artifact://art_…" name="plan.md" title="方案" size="5321" created_at="…" source_path="notes/plan.md"/>
  …
</session_artifacts>
```

- store 是唯一来源。段落不进 graph state，也不进 checkpoint，所以压缩历史不会把它丢掉，重启 Host 也能恢复。
- 最多列出最近 20 个；超出时写明总数，并提示用 `list_artifacts` 查看。
- 同一次运行里刚发布的 artifact，信息在 `publish_artifact` 的工具结果里；下一次 root invocation 时进入段落。
- 没有 artifact 时不生成这个段落。

## 交付（pet-agent）

Capability 执行结束后，runner 用 `store.list(threadId, { delegationId })` 取出这次委派发布的 artifacts，放进 `delegate_capability` 结果：

```ts
result: { status, delivery: { text }, artifacts: ArtifactRef[] }
```

- Supervisor 验收时同时看到交付文本和交付文件；Entry 回复用户时可以直接引用这些 uri。
- 数据来自 store，不另外维护一份 state，也不需要 Capability 写代码（不再经过 `lifecycle.finalize`）。

## Host：存储与读取

Adapter 在 Host 配置里选：

- `local`（默认）：`~/.pinpawo/workspaces/<workspaceId>/artifacts/<threadId>/<artifactId>/<name>`，索引放在同一目录。和 checkpoint 一样属于这个 workdir 的 Host 会话状态。
- `cos`：bucket + prefix，对象键 `<prefix>/<workspaceId>/<threadId>/<artifactId>/<name>`；`open` 返回签名 URL。密钥放在全局配置 `~/.pinpawo/config.json` 或环境变量，不进 workdir。

以后的 S3 等同理，只是再加一个 adapter。

`ArtifactSourceReader` 的 Host 实现按 files Toolkit 的规则解析路径（相对路径基于 workdir，绝对路径原样），只读普通文件。单文件上限 100 MB，超过时 `publish_artifact` 报错，不截断。不设每个 session 的总量上限。

## 对外：引用与读取

Pet 在回复正文里直接写工具返回的链接，例如 `[方案](artifact://art_…)`。消息里只存这一段文本，和底层存储无关。

Host 的 Agent Session HTTP 增加一个路由：

```text
GET /agent-session/artifacts/:artifactId
```

- `local`：直接返回文件流，带 `Content-Type` 和文件名。
- `cos`：返回 302，跳到签名 URL。
- 权限：调用方必须能观察这个 artifact 所属的 session，规则与现有的 Pet session 观察路由相同。Studio 的 HTTP Plugin 用同样的规则代理，客户端不需要知道文件在哪个 adapter。

客户端渲染：

- Console：用 react-markdown 的 `urlTransform` 识别 `artifact://`（与现在的 `participant:` 链接同一处），渲染成文件卡片，Markdown 直接预览，其他类型下载。
- TUI：显示标题；`local` adapter 下给出本地路径，其余给出 HTTP 地址。

不允许跨 session 读取：`read_artifact` 和 `list_artifacts` 只作用于当前 session。另一个 Pet 在 Channel 消息里看到 `artifact://` 链接时读不到内容；需要交接文件内容时，由发布方在消息正文里写明，或把文件放进双方都能访问的工作目录。人通过 HTTP 路由打开不受这条限制，按 session 观察权限判断。

## 删除

删除 session 时 Host 调 `store.deleteSession(threadId)`，和删除 checkpoint 放在同一处。现在旧 store 的 `deleteThreadArtifacts` 没有调用方，这一点要一起补上。

## 和 Studio Wiki 的区别

[Studio 项目知识目录](../studio/wiki-storage-draft.md) 是多个 Channel 共享、需要备份的长期知识，不随会话删除。Artifact 是某个 session 的交付物，跟着 session 走。需要长期保留的内容，应该由 Pet 明确写进 Wiki，而不是让 artifact 承担这个角色。

## 移除的旧实现

不需要旧数据兼容，因为从未写入过：

- pet-agent：`types/artifact.ts` 中的 `CapabilityArtifact*`、`orchestrator/capabilityArtifacts.ts`、`orchestrator/artifacts/discovery.ts`、`sessionCapabilityArtifacts`、`SubagentResult.artifacts`、finalize context 中的 `artifactStore` / `recordCapabilityArtifact` / `artifactRefs`。
- Host：`FileCapabilityArtifactStore`、`artifact_discovery` Toolkit、`capabilityArtifactRoot`、各处旧 store 注入；TUI 对 `artifact_discovery_context` 信封的解析。
- Channel：消息的 `artifacts` 字段与 Console 的渲染。
- 文档：`docs/reference/artifacts/` 移入 history。

`delegate_capability` 结果里的 `artifacts` 字段保留，数据源换成新 store。`lifecycle.finalize` 删除写入接口后仍可改写 output / messages，是否保留另行决定。

## 实现顺序

1. 删除旧 pipeline 和 Channel `artifacts` 字段（一个 PR）。改 prompt 后重跑受影响的 Supervisor eval。
2. pet-agent：类型、port、`artifacts` Toolkit、上下文段落、delegate 结果；Host：`local` adapter、source reader、随 session 删除。
3. Agent Session HTTP 读取路由、Studio HTTP 代理、Console / TUI 渲染。
4. `cos` adapter。

## 已定（2026-10-28）

- 不允许跨 session 读取。
- `artifacts` Toolkit 必须在 Capability 的 `uses` 里声明。
- 单文件上限 100 MB，不设 session 总量上限。
