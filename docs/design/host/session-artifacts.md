# Session Artifacts

状态：draft，2026-10-23。替代 [Capability Artifact Pipeline](../../reference/artifacts/index.md)。

## 需求

一个 Agent session 在工作中产生的文件（报告、方案、导出的数据），需要能交给人或别的 Pet 看。参照 Claude projects 里一个任务 session 的做法：

- 文件由产生它的 session 自己保管，不交给 Studio 或 Channel。
- session 自己的上下文里有这些文件的信息，至少有地址，压缩历史后也不能丢。
- 存储可以替换：本地目录是默认，也要能换成腾讯云 COS 这类对象存储。
- Chat、TUI、Studio 都是 Host，不经过 Studio 也必须能用。

旧的 Capability Artifact Pipeline 不满足这个需求：它只有 Capability `lifecycle.finalize` 一个写入口，没有任何 Capability 实现过，store 从未写入；作用域是 Capability / delegation，引用藏在 graph state 里，模型和人都看不到。本设计不以它为前提。

## 概念

**Artifact 是 session 显式发布的一个文件快照。**

- 显式：Pet 写到 workdir 或临时目录的文件都不算 artifact，只有调用 `publish_artifact` 发布的才算。发布等于"这是我交付的东西"。
- 快照：发布时复制一份进 session 的 store。源文件之后被改、被删或在 `/tmp` 里被清掉，都不影响已发布的版本。再发布一次得到新的 artifact。
- 归属：一个 artifact 属于一个 Host session（`threadId`）。session 删除时，它的 artifacts 一起删除。

```ts
type ArtifactRef = {
  id: string;          // Host 内唯一，例如 art_<uuid>
  uri: string;         // artifact://<id>
  name: string;        // 文件名，来自源文件或参数
  title?: string;
  mimeType: string;
  size: number;
  sha256: string;
  sourcePath?: string; // 发布时的源路径，仅供 session 自己回看
  createdAt: string;
};
```

`ArtifactRef` 和 `artifact://` 的解析放在 `@pinpawo/agent-contracts`，Host 和客户端共用。

## 分层

| 层 | 负责 | 不负责 |
|---|---|---|
| pet-agent | 无 artifact 概念 | 存储、工具、上下文段落 |
| agent-contracts | `ArtifactRef` 类型与 `artifact://` 解析 | 存取 |
| Host | `ArtifactStore` port 与 adapter、`artifacts` Toolkit、上下文段落、HTTP 读取路由、随 session 删除 | 渲染 |
| 客户端（TUI / Console） | 把正文里的 `artifact://` 链接渲染成文件卡片、打开或下载 | 存储 |
| Studio / Channel | 只存消息正文 | 保管文件 |

发布要读本地文件，所以工具和 store 都在 Host（见 CLAUDE.md 的边界）。pet-agent 只看到一个普通 Toolkit 和一个普通的 common system section，不需要专门的状态字段或节点。

## Host store

```ts
type ArtifactStore = {
  put(input: { threadId: string; sourcePath: string; name?: string; title?: string }): Promise<ArtifactRef>;
  list(threadId: string): Promise<ArtifactRef[]>;
  open(id: string): Promise<{ ref: ArtifactRef; threadId: string; body: ReadableStream } | { ref: ArtifactRef; threadId: string; redirectUrl: string }>;
  deleteSession(threadId: string): Promise<void>;
};
```

Store 只管数据，不做权限判断。权限由调用方（工具、HTTP 路由）决定。

Adapter 在 Host 配置里选：

- `local`（默认）：`~/.pinpawo/workspaces/<workspaceId>/artifacts/<threadId>/<artifactId>/<name>`，索引放在同一目录。跟 checkpoint 一样属于这个 workdir 的 Host 会话状态。
- `cos`：bucket + prefix，对象键 `<prefix>/<workspaceId>/<threadId>/<artifactId>/<name>`；`open` 返回签名 URL。密钥放在全局配置 `~/.pinpawo/config.json` 或环境变量，不进 workdir。

以后的 S3 等同理，只是再加一个 adapter。

## Toolkit：`artifacts`

| 工具 | 作用 | 审核 |
|---|---|---|
| `publish_artifact(path, title?)` | 读 Pet 可读的任意路径（workdir、`/tmp` 或 session 临时目录），复制进当前 session 的 store，返回 ref 和一行可直接粘进回复的 Markdown 链接 | 不需要：只写自己 session 的 store |
| `read_artifact(uri, maxBytes?)` | 读文本内容；二进制只返回 ref | 不需要 |
| `list_artifacts()` | 列出当前 session 的全部 artifacts，用于超出上下文段落上限时 | 不需要 |

建议内置 Capability 默认在 `uses` 里声明 `artifacts`，用户 Capability 自己声明（见待定）。同一 session 的 Entry、Supervisor、Capability 执行方共享一个 store，按 `threadId` 区分，和 lane 无关。

`/tmp` 可以作为草稿区，因为发布时已经复制。如果要让写临时文件不触发审核，可以再给每个 session 分一个临时目录并在其中自动放行，这件事和本设计无关，单独做。

## 上下文

Host 每次 root invocation 都从 `store.list(threadId)` 生成一个 common system section（和 PET.md 一样走 `systemPromptSections`），所有角色都能看到：

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

另一个 Pet 在 Channel 消息里看到 `artifact://` 链接时，可以用 `read_artifact` 读取同一 Host 内的 artifact。跨 Host 读取不在这一版里。

## 删除

删除 session 时 Host 调 `store.deleteSession(threadId)`，和删除 checkpoint 放在同一处。现在旧 store 的 `deleteThreadArtifacts` 没有调用方，这一点要一起补上。

## 移除的旧实现

不需要旧数据兼容，因为从未写入过：

- pet-agent：`types/artifact.ts`、`orchestrator/capabilityArtifacts.ts`、`orchestrator/artifacts/discovery.ts`、`sessionCapabilityArtifacts`、`SubagentResult.artifacts`、finalize context 中的 `artifactStore` / `recordCapabilityArtifact` / `artifactRefs`、`delegate_capability` 结果里的 `artifacts`，以及 Entry / Supervisor prompt 里对 artifacts 的说明。
- Host：`FileCapabilityArtifactStore`、`artifact_discovery` Toolkit、`capabilityArtifactRoot`、各处 store 注入；TUI 对 `artifact_discovery_context` 信封的解析。
- Channel：消息的 `artifacts` 字段与 Console 的渲染。
- 文档：`docs/reference/artifacts/` 移入 history。

`lifecycle.finalize` 删除写入接口后仍可改写 output / messages，是否保留另行决定。

## 实现顺序

1. 删除旧 pipeline 和 Channel `artifacts` 字段（一个 PR）。改 prompt 后重跑受影响的 Supervisor eval。
2. agent-contracts 的 `ArtifactRef`、Host `local` store、`artifacts` Toolkit、上下文段落、随 session 删除。
3. Agent Session HTTP 读取路由、Studio HTTP 代理、Console / TUI 渲染。
4. `cos` adapter。

## 待定

- 跨 session 读取的范围：同一 Host 内任意 session 都可读，还是只限同一 Channel 的 session。
- `artifacts` Toolkit 是作为 Host 默认 Toolkit 对所有 Capability 开放，还是必须显式声明 `uses`。
- 本地 adapter 是否需要单个文件大小上限和每个 session 的总量上限。
