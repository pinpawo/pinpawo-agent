# Session Artifacts

状态：draft，2026-11-05。第一阶段：显式发布、交付物链路、按需下载。

设计来源：[#1008](https://github.com/pinpawo/pinpawo-agent/pull/1008)、[#1050](https://github.com/pinpawo/pinpawo-agent/pull/1050)。

## 需求

Agent session 在工作中产生的报告、方案、截图和导出数据，需要能交给人或别的 Pet：

- session 显式发布文件，获得稳定引用。
- 文件交付由发布成功回执形成引用清单，随最终回复送达请求方。
- 默认使用本地存储，也支持腾讯云 COS 等对象存储。
- Chat、TUI、Studio 和独立部署的 pet-agent 使用同一套发布与下载能力。

## 第一阶段范围

1. `publish_artifact` 保存文件快照，返回稳定引用。
2. Capability 子代理模型选择需要交付的文件并发布，核心汇总发布成功回执，写入委派执行记录。
3. Agent 按需将引用下载到本地，再用现有文件工具读取。
4. 本次 run 的交付物随最终回复，通过结构化字段到达 Channel 和客户端。
5. 人通过 HTTP 打开引用。

归属查询、删除和保留策略见[后续：artifacts 管理](#后续artifacts-管理)。

## 边界：运行时隔离与文件共享

- **运行时隔离**：每个 session 独立持有自己的上下文和运行态，包括消息、checkpoint 和执行记录。
- **文件显式共享**：发布方通过交付或 Channel 消息传递 artifact 引用，接收方凭引用下载文件。

`list_artifacts` 的查询范围是当前 session。`download_artifact` 支持读取其他 session 显式共享的引用。

## 概念

- **Artifact**：session 通过 `publish_artifact` 发布的文件快照。发布时复制文件到存储；源文件后续变化或清理后，快照仍可读取。再次发布得到新的 artifact。
- **稳定引用**：`artifact://<key>`，可以长期写入消息、交付和文档。`<key>` 直接定位存储对象，例如 `<workspaceId>/<threadId>/<artifactId>/<name>`。
- **临时下载地址**：存储按需生成的下载地址，例如有过期时间的 COS 签名 URL，用于一次下载。
- **发布回执**：`publish_artifact` 成功保存快照后返回的 `ArtifactRef`，是文件交付的凭据。
- **交付物（Deliverable）**：一次 run 交给请求方的引用 `{ uri, title? }`。文件交付从发布成功回执取得 `uri` 和可选 `title`，写入执行记录并随最终回复传递。

`resultReferences` 提供执行证据文本，供详情展示；`deliverables` 提供可打开的引用。各层原样传递结构化引用，回复正文由模型正常生成。

## 分层

| 层 | 负责 |
|---|---|
| agent-contracts | 对外 `Deliverable` 类型、`ArtifactRef` 与 `artifact://` 解析 |
| pet-agent 核心 | 汇总 Toolkit 显式提供的公共结果，沿 Capability 返回路径写入执行记录 |
| artifacts Toolkit（`toolkits/artifacts`） | 存储与文件读取 port、三个工具、发布引用的执行状态、文件选择与发布指引 |
| Host | 注入 store adapter 和 source reader；投影本 run 的交付物；提供 HTTP 文件访问 |
| agent-session 协议 | `message.completed.deliverables` 与 snapshot 对应字段 |
| Channel Plugin | 将 Pet 回复事件中的 `deliverables` 原样存入消息 |
| 客户端（TUI / Console） | 展示消息的 `deliverables` 与正文中的 `artifact://` 链接 |

## 交付物约定（agent-contracts + pet-agent）

```ts
type Deliverable = { uri: string; title?: string };
```

文件从生成到交付的职责如下：

1. 浏览器、Office 等工具在生成文件时保存文件，在正常工具结果中提供本地路径。
2. Capability 子代理模型根据用户目标、业务需求和工具输出，选择需要交付的文件，调用 `publish_artifact(path, title?)`。
3. `publish_artifact` 校验文件并保存快照，成功后返回 `ArtifactRef`，同时将 `uri` 和可选 `title` 写入 artifacts 的 `publishedRefs` state。
4. artifacts Toolkit 通过原生 reducer 累计发布引用，按 `uri` 去重，并由自己的 `getResult(state)` 返回 `{ deliverables }`。核心汇总本次所选 Toolkit 的公共结果，沿 Capability 返回出口写入执行记录。
5. 执行记录保存委派状态、文字交付和已汇总的引用：`{ status, delivery: { text }, deliverables }`。
6. Supervisor 根据用户目标和实际结果验收，Entry 与 Supervisor 按既有回复流程生成最终回复。

artifacts Toolkit 按 [Toolkit 执行状态](../toolkits/execution-state.md) 声明 `publishedRefs`，默认值为空数组，并定义自己的结果提取函数。文件快照由 store 保存，引用在本次子代理 state 中累计，消息按 Agent 既有上下文策略压缩。发布结果与委派状态分别记录；拒绝或取消委派后，已保存的快照仍可读取。

### 文件选择与发布指引

Capability 在 `uses` 中声明 `artifacts`，获得发布、列表、下载工具。artifacts Toolkit 的 `instructions` 随现有装配进入子代理提示词，引导模型：看到工具返回的文件路径，或自己生成文件时，结合任务判断文件是否需要交给请求方，需要时调用 `publish_artifact`。

例如 `browser_screenshot` 把截图写到 `<workdir>/.pinpawo/browser/screenshots/`，并在工具结果中返回路径。使用 `browser` 和 `artifacts` 的 Capability 可以在同一次执行中完成截图与发布。用于操作过程的截图保留在本地；需要交付给请求方的截图由模型选择并发布。

文件选择由模型完成，核心处理发布成功回执。已有 URL 的结构化交付方式见[待定问题](#待定问题)。

## 交付物链路

交付物沿现有执行记录、回复事件和消息存储路径传递：

```text
publish_artifact 成功回执 ArtifactRef
  -> artifacts Toolkit state.publishedRefs
  -> artifacts.getResult(state) 返回 { deliverables }
  -> pet-agent 汇总本次所选 Toolkit 的公共结果
  -> delegate_capability 执行记录 deliverables
  -> message.completed.deliverables
  -> snapshot / Channel 消息 deliverables
  -> Console / TUI 渲染
```

- Capability 执行函数整理子代理文字结果和发布引用，`delegate_capability` 将同一次执行结果写入父层 ToolMessage。
- 最终回复按已有验收结论选择当前 run 中已验收任务的最新执行，合并其交付物，按 `uri` 去重并保持发布顺序。打回执行的记录和文件快照继续保存。
- Entry 与 Supervisor 将选定引用写入最终回复的结构化元数据，Host 据此生成 `message.completed.deliverables` 和 snapshot。
- Channel 消息使用 `deliverables: [{ uri, title? }]` 表达这条消息交付的引用；人发的消息也可以携带该字段。
- Console / TUI 展示结构化交付物，并支持正文中的 `artifact://` 链接。

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

存储操作由 `ArtifactStore` 承担，访问控制由 Host 承担。

| 工具 | 作用 | 审核 |
|---|---|---|
| `publish_artifact(path, title?)` | 经 source reader 读取本地文件，保存快照，返回 `ArtifactRef` 成功回执及 Markdown 链接 | 免审 |
| `list_artifacts()` | 列出当前 session 发布的 artifacts | 免审 |
| `download_artifact(uri, path?)` | 将引用下载到本地，默认保存到 session 临时目录，返回本地路径 | 免审 |

- Agent 自行决定下载和读取文件的时机，下载后使用 files 工具读取。
- 发布时的 `threadId` 由工具 execution scope 提供。
- Capability 的 `uses` 决定 artifacts 工具与 instructions 的装配。
- 单文件上限 100 MB，超限时 `publish_artifact` 返回错误。session 总量由存储容量决定。

## Host

Host 配置选择存储 adapter：

- `local`（默认）：`~/.pinpawo/workspaces/<workspaceId>/artifacts/<threadId>/<artifactId>/<name>`，`fetch` 返回文件流。
- `cos`：使用 bucket 和 prefix，对象键与 `<key>` 一致，`fetch` 返回签名 URL。密钥放在全局配置 `~/.pinpawo/config.json` 或环境变量。

`ArtifactSourceReader` 按 files Toolkit 的规则解析路径：相对路径基于 workdir，绝对路径原样使用；读取对象为普通文件。

Agent Session HTTP 提供 `GET /agent-session/artifacts?uri=…`：`local` 返回文件流，`cos` 通过 302 跳转到签名 URL。Studio HTTP Plugin 提供对应代理。

Console 通过 react-markdown 的 `urlTransform` 识别 `artifact://`，与现有 `participant:` 链接共用入口。TUI 显示标题和可打开的本地路径或 HTTP 地址。

可选的 session 产物上下文通过 `renderArtifactsSection(store, threadId)` 生成，列出当前 session 最多 20 条产物。Host 在 root invocation 时通过 `systemPromptSections` 注入；有产物时生成该段落。

## 待定问题

- **已有 URL 的结构化交付**：确定来源工具返回的 URL 如何进入 `deliverables`。URL 的访问权限和有效期沿用来源工具的约定。

## 后续：artifacts 管理

独立的 artifacts 管理能力承接：

- 从引用查询归属 Pet、session 和存储对象，提供管理入口。
- 删除、保留策略、失败清理与孤儿文件处理。
- 评估 Toolkit 按 scope 提供动态上下文的通用需求。
