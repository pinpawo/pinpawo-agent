# Session Artifacts

状态：draft，2026-10-29。第一阶段：显式发布、交付物链路、按需下载。替代 [Capability Artifact Pipeline](../../history/artifacts/pipeline/index.md)。

## 需求

一个 Agent session 在工作中产生的文件（报告、方案、导出的数据），需要能交给人或别的 Pet。参照 Claude projects 里一个任务 session 的做法：

- 文件由产生它的 session 显式发布，发布后有一个稳定的引用。
- session 的交付里一定带着这些引用，不依赖模型是否在正文里写了链接。
- 存储可以替换：本地目录是默认，也要能换成腾讯云 COS 这类对象存储。
- Chat、TUI、Studio 都是 Host，不经过 Studio 也必须能用；pet-agent 在服务器上复用时同样适用。

旧的 Capability Artifact Pipeline 不满足这个需求：它只有 Capability `lifecycle.finalize` 一个写入口，仓库内没有 Capability 使用该写入口；引用只在 graph state 里，模型和人都看不到。本设计不以它为前提。仓库内的调用情况不能证明外部 Capability 或已有 store 没有数据，删除前需要核实兼容影响。

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

- 目标是让被 Supervisor 打回、之后重做的那次执行的文件留在 store，但不跟着回复走。现有 `readReplyResultReferences` 只按回复所属 run 和 `returned` 筛选；`returned` 表示执行已返回，不代表 Supervisor 已接受。如何可靠识别应随回复交付的执行，需在实现链路前明确，不能直接复用这一筛选并假定它排除了打回的结果。
- 合并本 run 中选定执行的交付物，同一 uri 去重，保持发布顺序；执行的选取规则待明确。
- Channel 现有的 `artifacts: [{ uri, label?, version? }]` 拟改为 `deliverables: [{ uri, title? }]`，语义是"这条消息交付的引用"。人发的消息也可以带。Console 现有的渲染改用新字段名。Channel 已持久化人发消息的 `artifacts`，实施字段变更前须明确旧消息和 `label` / `version` 的处理，避免历史附件丢失或不可见。
- 尽量沿用现有事件和存储路径；执行选取规则与历史数据处理确定后，再确认是否需要额外投影或迁移。

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

计划移除以下旧实现；删除前须核实外部 Capability、已有 store、checkpoint 和执行记录的兼容影响。仓库内没有写入口的调用，并不能证明所有部署中都没有旧数据：

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

## 实现状态

状态仍为 draft。本节记录本分支的实现与验证边界；上文保留原设计的目标、待明确项
和原始实施顺序，不以实现说明替代设计依据。

本轮第一步 [#1047](https://github.com/pinpawo/pinpawo-agent/pull/1047) 只移除无调用的
helper，保留可复用能力。本分支基于该清理，接通目标后再统一退役旧 pipeline，
不把已有路径、哈希或原子文件能力全部推倒重建。

- `ToolMessage.artifact.deliverables` 是所有 Toolkit 共用的声明约定。工具校验，
  Capability 在结果产生时按委派 checkpoint 状态累积并按 URI 去重；压缩私有消息
  不会丢失已声明引用。已打回或取消执行的声明保留为执行证据。
- 执行记录使用 `deliverables`。现有 `review_current(completed: true)` 成功结果
  保存 `acceptedExecution`（delegation ID 与引用快照），公开回复只取本 run 的
  成功验收回执并去重，不把 `returned` 当验收。Root 压缩保留 Supervisor work，
  最终回复 metadata 固化引用，再沿 Host、session、Channel、Console / TUI 传递。
  这复用审核记录，没有新增验收状态机或反查账本。
- 独立 `@pinpawo-toolkit/artifacts` 提供 `publish_artifact` / `list_artifacts` /
  `download_artifact`。Host 注入 streaming store 与 source reader；普通文件目标
  使用 Files 的绝对/相对路径语义。默认或显式选定的本 session 受管临时路径免审核，其他
  选定路径按 Files 写入语义精确审核。下载验证 size / SHA-256 后替换目标。
- 本地 adapter 复用 Host 路径约束、SHA-256 和原子文件能力，每次发布用新 UUID
  保存快照，上限 100,000,000 bytes。物理路径及稳定 key 的 session 段使用
  base64url 编码，不限制 runtime 的 opaque ID。list 仅当前 workspace/session，
  fetch 可从共享 workspaces base 解析收到的跨 workspace 引用。
- COS adapter 使用官方 SDK `cos-nodejs-sdk-v5` 3.0.0 流式写入和临时签名 URL。
  adapter 选择与凭据来自全局配置或 `PINPAWO_ARTIFACTS_*` 环境变量，不进 workdir；
  详见 [Artifacts 配置](../../reference/artifacts/index.md#host-configuration)。
- 已有认证 HTTP 增加 `GET /agent-session/artifacts?uri=...`：local 返回流，COS
  返回 302，Studio HTTP 使用同一路径。Console 认证 fetch 后下载 Blob，支持正文
  `artifact://` 链接及结构化引用。COS 跨源重定向需要 bucket 允许签名 GET 的实际
  CORS origin；浏览器 fixture 观察到 `Origin: null`，仅配置 Console 固定 origin
  不足以保证该链路。无 cookie 的签名 GET 可使用 `Access-Control-Allow-Origin: *`；
  这不绕过 Host 认证。不能假定现有 bucket 无需配置即可使用。
- TUI 已能显示标题与稳定引用，并在 snapshot 重绘后保留。可用地址接线正在验证：
  WebSocket 使用真实连接端口显示需认证的 HTTP GET 地址；默认 stdio 不开新端口，
  通过只读 `artifact.address.get/result` 控制消息解析现有本地快照路径或临时 COS
  URL。这些地址不写入 Agent 历史、Channel 或 checkpoint，也不自动下载文件。
  接口见 [Agent Session](../../reference/runtime/session-projection.md#artifact-display-addresses)。
- Channel 人和 Pet 消息统一为 `deliverables`。迁移 0003 按 100 行分页，把旧
  label/version 转成显示标题并保留原 JSON；不做双字段读取。新写入恢复 100 条、
  URI 4096 字符、title 500 字符限制；历史长标题可读。
- 接通新目标后，旧 store/discovery/finalize 写入口、session 索引与旧类型退役，
  `finalize` 普通 output/messages 改写能力保留；旧磁盘文件不删除。执行记录字段
  变更使用项目持久化路径标签 `capability-v6`，不是 LangGraph checkpoint 格式版本。
  新默认路径与 TUI registry 不读取或自动迁移 v5 会话，本次不部署或切换运行态。

不增加反查、统一删除、retention/GC 或管理平台。可选的 session 产物 system section
未实现，不是引用传递的前置条件。

验证边界：第一轮全量构建与类型检查已通过，新增地址 RPC 后仍需复验。本地文件交接
E2E 使用脚本模型，实际执行两次文件发布、打回首版和验收终版，再经 Host 事件与
snapshot、SQLite Channel 到另一 workspace/session 的 Pet 实际 list/download
并校验二进制；删除源文件后认证 HTTP 仍读到已发布快照。它验证真实工具、存储和
传输链路，不是外部模型验收。

真实 SDK 对隔离 HTTP fixture 的流传输及离线签名已验证；Chromium fixture 已覆盖
local binary、正文链接、COS 跨源 302 以及 Bearer 不泄漏。它们不是实际 COS bucket
权限、外网和 CORS 配置的验收。真实模型评估在调用前因缺少默认 profile 配置文件
`/home/agent/.pinpawo/config.json` 报 `ENOENT` 而未能启动，不是网络失败。真实 COS
联调、TUI 地址接线及本分支最终 head 的整体检查仍需以最终结果更新，不能由模拟测试
推定已完成。
