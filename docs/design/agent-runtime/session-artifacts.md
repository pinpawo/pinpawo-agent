# Session Artifacts

状态：draft，2026-10-29。第一阶段：显式发布、交付物链路、按需下载。替代 [Capability Artifact Pipeline](../../history/artifacts/pipeline/index.md)。

设计来源：[#1008 原稿](https://github.com/pinpawo/pinpawo-agent/pull/1008)；前轮修订：[#1050](https://github.com/pinpawo/pinpawo-agent/pull/1050)。

本轮文档对齐待 review（2026-11-05）：以简单为先，文件交付只认 `publish_artifact` 的成功回执。生成工具只保存文件、返回路径，由 Capability 子代理模型结合任务决定是否发布。保留既有执行记录、Capability 返回出口和存储接口；不增加特殊压缩保留或补偿，下载工具免审。收集结果由 state 还是 messages 承载、已有 URL 如何进入结构化交付仍待确定。本次只改设计，代码差异见[实施状态](#后续实现状态2026-11-05待-review)。

## 需求

一个 Agent session 在工作中产生的文件（报告、方案、导出的数据），需要能交给人或别的 Pet。参照 Claude projects 里一个任务 session 的做法：

- 文件由产生它的 session 显式发布，发布后有一个稳定的引用。
- session 的文件交付由发布成功回执形成引用清单，不依赖模型是否在正文里写了链接；不为消息压缩增加额外保留或恢复机制。
- 存储可以替换：本地目录是默认，也要能换成腾讯云 COS 这类对象存储。
- Chat、TUI、Studio 都是 Host，不经过 Studio 也必须能用；pet-agent 在服务器上复用时同样适用。

旧的 Capability Artifact Pipeline 已在 #1047 退役。它曾只有 Capability `lifecycle.finalize` 一个写入口，仓库内没有 Capability 使用该入口；引用只在 graph state 里，模型和人都看不到。本设计以显式发布替代它，当前清理边界见[清理阶段实施状态](#清理阶段实施状态)。

## 第一阶段范围

做：

1. 显式发布：`publish_artifact` 把文件写进存储，返回稳定引用。
2. 交付物引用：模型选择要交付的文件并发布，核心汇总发布成功回执，写进委派的执行记录。
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
- **发布回执**：`publish_artifact` 成功保存快照后返回的 `ArtifactRef`，是本轮文件交付的凭据。生成文件、返回本地路径或在正文中写链接，本身不形成发布回执。
- **交付物（Deliverable）**：一次 run 交给请求方的引用 `{ uri, title? }`。本轮文件交付从发布成功回执取得 `uri` 和可选 `title`，写入执行记录，跟着最终回复走。其他工具无需实现通用交付声明协议；已有 URL 的处理见[本轮对齐](#本轮对齐引用来源与统一返回)。
  - 和 `resultReferences` 分开：`resultReferences` 是执行证据的文本，供详情展示；Deliverable 是可以打开的引用。
  - 各层只原样传递，不从正文推断，也不改写正文。

## 分层

| 层 | 负责 |
|---|---|
| agent-contracts | 对外 `Deliverable` 类型、`ArtifactRef` 与 `artifact://` 解析；不要求通用工具声明 schema |
| pet-agent 核心 | 汇总 `publish_artifact` 成功回执形成的引用，沿现有 Capability 返回路径写进执行记录 |
| artifacts Toolkit（独立包，如 `toolkits/artifacts`） | 两个存储/读取 port、三个工具，以及按任务选择文件再发布的 instructions |
| Host | 注入 store adapter（local / COS）与 source reader；把本 run 的交付物挂到 `message.completed`；HTTP 打开引用；可选的 session 产物段落 |
| agent-session 协议 | `message.completed.deliverables` 与 snapshot 里对应字段 |
| Channel Plugin | 把 Pet 回复事件里的 `deliverables` 原样存进消息 |
| 客户端（TUI / Console） | 渲染消息的 `deliverables` 与正文里的 `artifact://` 链接 |

## 交付物约定（agent-contracts + pet-agent）

文件交付只认 `publish_artifact` 成功回执。该工具返回下文的 `ArtifactRef`；核心读取其 `uri` 和可选 `title`，形成对外引用：

```ts
type Deliverable = { uri: string; title?: string };
```

职责与约束：

1. 浏览器、Office 等工具在生成文件时，负责保存文件、在正常结果中提供路径。它们无需声明 `deliverables`，也无需了解 artifact store。
2. Capability 子代理模型根据用户目标、业务需求和工具输出，选择需要交付的文件，调用 `publish_artifact(path, title?)`。不自动发布所有截图、日志、缓存或中间文件。
3. `publish_artifact` 校验文件并保存快照，成功后返回结构化回执；调用失败不产生有效交付凭据。回执是该发布工具自己的返回契约，不是其他工具必须实现的通用协议。
4. 核心只汇总本次执行的发布成功回执，不从其他工具正文推断交付物，不要求模型在最终正文里重复列出所有引用。汇总结果沿原 Capability 返回出口进入执行记录。
5. 已汇总的发布结果与委派状态分开：被拒绝或取消的委派仍可记录已汇总引用，已发布快照不因此删除；哪些执行随最终回复交付，沿用已有验收结论。
6. Entry 和 Supervisor 继续使用控制类工具。Supervisor 按用户目标和实际结果验收，不新增“数组为空就必须拒绝”的协议门槛，也不承担发布或附件格式整理。

在 Capability 的 `uses` 包含 `artifacts` 时，通过既有 Toolkit instructions 注入发布指引，具体见[本轮对齐](#本轮对齐引用来源与统一返回)。未声明使用的 Capability 不获得这些工具或指引。

汇总结果由现存 messages 读取，还是在 Capability 执行 state 中累计，后续只按总流程更简单的方式选择；本轮不把有无 state 作为硬约束，不另造跨执行的交付物清单或管理机制。

执行记录变为 `{ status, delivery: { text }, deliverables }`。Supervisor 验收和 Entry 回复时看到的是这份数据，和正文是否写了链接无关。

## 交付物链路

沿用现有的 `resultReferences` 路径：Host 的 `readReplyResultReferences`（`services/host/src/conversation/transcriptProjection.ts`）从回复所属 run 的执行记录取出 delivery，挂到 `message.completed`，再进 snapshot 和 Console。交付物在这条路上多带一个字段：

```text
publish_artifact 成功回执 ArtifactRef
  -> 本次 Capability 的文件交付引用                    （读取 uri、title，按 uri 去重）
  -> delegate_capability 执行记录 deliverables          （沿 Capability 现有返回出口）
  -> message.completed.deliverables                       （Host readReplyDeliverables）
  -> Channel 消息 deliverables                            （Channel recordPetMessage 原样存）
  -> Console / TUI 渲染
```

- 被 Supervisor 打回、之后重做的执行，其文件快照留在 store，但不跟着最终回复走。沿已有验收结论选取执行；`returned` 只表示执行返回，不等于验收通过，不直接复制 `readReplyResultReferences` 的筛选作为交付依据。
- 合并本 run 中已验收执行的交付物，同一 uri 去重，保持发布顺序；既有验收事实的使用方式见[实施状态](#后续实现状态2026-11-05待-review)。
- Channel 的旧 `artifacts` 输入、消息类型和展示已在清理阶段删除。后续新增 `deliverables: [{ uri, title? }]`，语义是"这条消息交付的引用"，人发的消息也可以带；Console / TUI 为新字段增加渲染。旧消息 JSON 不迁移或重写。
- 沿用现有事件和存储路径，补齐对应的结构化投影。

### 本轮对齐：引用来源与统一返回

本轮先收敛文件发布路径；已有 URL 的结构化交付仍待决定：

| 来源 | 交付前的处理 |
|---|---|
| 其他工具生成本地文件 | 工具保存文件并返回路径；模型按任务相关性决定是否调用 `publish_artifact`。只有发布成功回执进入文件交付汇总。 |
| 其他工具已经返回 URL | 如何纳入结构化交付待决定；不要求下载后重新发布，不要求其他工具使用同一个 store 或新增通用声明 schema。 |

例如 `browser_screenshot` 已把截图写到 `<workdir>/.pinpawo/browser/screenshots/`，并在工具结果中返回路径。模型看到截图和路径后，若该截图需要交给请求方，再调用 `publish_artifact`；仅用于操作过程的截图可以保留在本地。浏览器工具不必增加交付物声明。

发布指引放在 artifacts Toolkit 的 `instructions` 中：当工具输出文件路径，或子代理自己生成文件时，结合任务判断是否需要交付，需要时调用发布工具并使用成功回执。Capability 在 `uses` 声明 `artifacts` 后，现有装配已会把这些指引加入子代理的通用提示，不增加新的注入机制。内置 browser Capability 当前只使用 `browser`；要让同一次浏览器执行能够发布截图，需要同时声明 `artifacts`。

文件选择由模型完成，框架只处理发布回执。这里不增加文件监控或目录扫描，也不自动发布每个生成文件。已有 URL 的访问权限和有效期沿用来源工具的约定，转交引用不会自动续期或赋予访问权限；临时下载地址仍不能直接当作长期引用。

统一返回沿用现有代码位置，不增加 Agent 角色或框架概念：

- [createSubagent](../../../packages/pet-agent/src/subagent/createSubagent.ts) 返回子代理结果；[Capability 执行函数 `createCapabilityExecutor`](../../../packages/pet-agent/src/agent/orchestrator/capabilityExecution/runner.ts) 负责调用子代理、整理文字结果与发布引用。本身不判断文件与任务的相关性，相关性由模型在调用发布工具前判断。
- [delegate_capability](../../../packages/pet-agent/src/agent/orchestrator/runSupervisor/delegateCapabilityTool.ts) 将执行结果写成父层 ToolMessage，文件引用随同一次结果返回，不增加另一条交付通道。
- 工具实时流里已有 ToolMessage；[Host normalizer](../../../services/host/src/events/agentStreamNormalizer.ts) 通常取出 `content`，前端收到的是 `operation.raw.output`。过程展示可以复用这些事件，但不替代执行记录、最终回复和 Channel 的交付链路；当前 snapshot 不会重建原始工具历史。

消息压缩沿用现有策略，不因发布回执而额外保留调用或结果组，也不扫描摘要或历史来恢复回执。本轮不承诺回执跨消息压缩完整保留；若最终从现存 messages 汇总，被压缩移除的回执不另行补齐。已发布的文件快照保留在 store 中，不受消息压缩影响。

已有 URL 如何进入最终的结构化交付仍待确认。`publish_artifact(path, title?)` 继续只接本地路径，本轮不扩展为 URL 登记工具，不要求来源工具补通用声明协议，也不从正文自动抽取链接。这个待定问题不阻碍上述文件发布路径。

本次保留 `{ status, delivery: { text }, deliverables }` 和最终公开传递契约。发布回执形成结构化引用，模型正文用于正常回复。被打回执行不随回复公开仍是既定目标；使用现有验收结论选择执行，不把 `returned` 当作验收通过，也不另造验收状态机。

### 本轮误读与纠正

以下记录此前解释和初版修订中的误读，作为后续改动的约束：

- 曾将“不设独立 state”扩大为重新讨论是否保留执行记录。原 `{ status, delivery: { text }, deliverables }` 与交付链路应保留；后续先区分数据如何保存、传递与已确认的数据契约，不以实现取舍推翻契约。
- 曾把 runner helper 抬高为架构概念。它只是已有 Capability 执行代码的返回位置；后续用函数职责描述，不把实现文件名当成新增 Agent 角色或框架层。
- 曾忽略 `publish_artifact` 原有的本地文件发布兜底，把这条已有路径也泛列为声明问题。后续先核对现有工具输入和职责；自然返回本地路径后调用发布工具即可，只有原契约未覆盖的已有 URL 登记等问题才继续讨论。

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
| `publish_artifact(path, title?)` | 经 source reader 读文件（workdir、`/tmp` 或 session 临时目录），保存快照，返回 `ArtifactRef` 成功回执及可粘进回复的 Markdown 链接；成功回执是文件交付的凭据 | 不需要 |
| `list_artifacts()` | 列出当前 session 发布的 artifacts | 不需要 |
| `download_artifact(uri, path?)` | 把引用下载到本地（默认 session 临时目录），返回本地路径；之后用 files 工具读取 | 不需要 |

- Agent 自己决定何时下载、何时读已有的本地文件；存储层不自动下载，也不直接返回正文。
- 发布时的 `threadId` 来自工具的 execution scope，模型不传。
- 必须在 Capability 的 `uses` 里声明 `artifacts` 才能用，内置 Capability 也一样。
- `uses` 同时决定 artifacts instructions 的注入；生成文件的工具无需增加交付声明。
- 单文件上限 100 MB，超过时 `publish_artifact` 报错，不截断；不设 session 总量上限。

## Host

Adapter 在 Host 配置里选：

- `local`（默认）：`~/.pinpawo/workspaces/<workspaceId>/artifacts/<threadId>/<artifactId>/<name>`，`fetch` 返回文件流。
- `cos`：bucket + prefix，对象键与 `<key>` 一致；`fetch` 返回签名 URL。密钥放在全局配置 `~/.pinpawo/config.json` 或环境变量，不进 workdir。

`ArtifactSourceReader` 按 files Toolkit 的规则解析路径（相对路径基于 workdir，绝对路径原样），只读普通文件。

人打开引用：Agent Session HTTP 增加 `GET /agent-session/artifacts?uri=…`，`local` 返回文件流，`cos` 302 跳到签名 URL。Studio HTTP Plugin 同样代理。Console 用 react-markdown 的 `urlTransform` 识别 `artifact://`，与现在的 `participant:` 链接同一处；TUI 显示标题和本地路径或 HTTP 地址。

可选：Host 在每次 root invocation 用 toolkit 导出的 `renderArtifactsSection(store, threadId)` 生成一个 common system section（最多 20 条，没有产物时不生成），补"历史压缩后 Entry 不知道有哪些产物"这一个场景。走现有的 `systemPromptSections`，该 system section 不进 state 或 checkpoint。

## 后续：artifacts 管理

以下有价值，但不是第一阶段的前置条件，由独立的 artifacts 管理能力承接：

- 从引用反查归属（Pet、session、存储对象）和管理入口。
- 删除入口、保留策略、失败清理、孤儿文件处理。第一阶段不承诺随 session 删除自动清理。
- 是否需要一个通用机制，让 toolkit 按 scope 提供动态上下文。

## 移除的旧实现

以下为 #1047 的历史清理对象，具体退役边界见下一节。本轮只支持现行契约，不追加旧 store、checkpoint 或假设第三方 Capability 的兼容机制，也不迁移或删除旧数据：

- pet-agent：`types/artifact.ts`、`orchestrator/capabilityArtifacts.ts`、`orchestrator/artifacts/discovery.ts`、`sessionCapabilityArtifacts`、`SubagentResult.artifacts`、finalize context 中的 `artifactStore` / `recordCapabilityArtifact` / `artifactRefs`；`delegate_capability` 旧结果字段 `artifacts` 已删除，后续新增 `deliverables`。
- Host：`FileCapabilityArtifactStore`、`artifact_discovery` Toolkit、`capabilityArtifactRoot`、各处旧 store 注入；TUI 对 `artifact_discovery_context` 信封的解析。
- 文档：`docs/reference/artifacts/` 移入 history。

Channel 后续新增 `deliverables`（见[交付物链路](#交付物链路)）。
普通 `lifecycle.finalize` 保留 `output` 改写和只读 context `messages`，返回值不再支持
`messages`；交付物不通过这个 hook 声明。

## 实现顺序

1. 删除旧 pipeline（一个 PR）。改 prompt 后重跑受影响的 Supervisor eval。
2. 按发布成功回执收敛文件交付入口；通过现有 Toolkit instructions 引导模型按任务决定发布，沿 Capability 原出口返回引用与执行记录。汇总承载位置按简单原则另定，不增加压缩专用保留或恢复机制。
3. 交付物链路：`message.completed.deliverables`、Channel 新增字段、Console / TUI 渲染。
4. artifacts Toolkit 与 Host `local` adapter、source reader。
5. HTTP 打开引用。
6. `cos` adapter。

## 清理阶段实施状态

本节记录 #1047 的清理范围，不改变上文的设计目标或将其视为已经实现。

旧 Capability Artifact store、discovery Toolkit、专用 Host/Studio 注入和 finalize
写入接口已退役。普通 finalize 保留 `output` 收尾接口及只读 context `messages`；
返回值 `messages` 的无消费赋值和输出类型已删除，不据此声称该 hook 已被实际业务使用。
Channel 的旧 `artifacts` 输入、消息类型和展示也已删除；原有消息 JSON 不重写，
旧附件值不再通过 API 或 Console 可见。显式发布、交付物传递、下载与 local/COS
adapter 尚未由本清理提供；新能力仍需另行实现与验证。上文保留原草稿的目标与历史接口描述，
不应把它们当作本清理后的当前能力。

本次删除 `sessionCapabilityArtifacts` channel、旧 Ref 类型和 reducer，旧索引不再进入
当前 state。
按用户明确的自测阶段规则，本次也删除旧执行记录 `artifacts` 的兼容读取及专门测试，
只支持现行契约；历史 checkpoint 和第三方 Capability 兼容仅在用户明确要求时处理。
按现有版本隔离方式，checkpoint namespace 升至 `capability-v6`，新 runtime 不读取
v5 checkpoint，不恢复旧 reader，也不迁移或删除旧 checkpoint 与 store 文件。TUI
会话注册表随版本隔离；Studio 独立的 `resident-sessions` 注册表路径不变，已有条目
继续加载，不能据此认为所有旧会话都已清空。旧文件不再能通过原 discovery 工具访问。
详见[当前退役边界](../../reference/extensions/capability-toolkit.md#7-旧-artifact-pipeline-退役)。

## 后续实现状态（2026-11-05，待 review）

#1051 的实现叠加在 #1050 的 `e8badc2c` 上；其 base 为已包含 #1047 的 main
`29f0bec9`。发布、当前 session 列表、共享引用下载、local/COS adapter、HTTP
读取及公开消息字段已接入，见 [Toolkit](../../../toolkits/artifacts/README.md)
和 [Host 配置](../../../services/host/src/artifacts/README.md)。现有装配已支持按
Capability 的 `uses` 注入 Toolkit instructions；下载免审，压缩沿用既有机制。

本次只对齐设计文档，没有修改运行代码。当前 #1051 仍从返回时剩余的 ToolMessage
读取通用 `artifact.deliverables`，并保留输入消息对象/ID 排除和 Supervisor 的字段
强制验收提示；内置 browser Capability 也尚未使用 `artifacts`。这些现状不代表
本轮的发布回执方案已完成：后续需把文件汇总限制为 `publish_artifact` 成功结果，
收简额外过滤与协议验收要求，并让需要发布文件的 Capability 显式使用 artifacts。
state 与 messages 的汇总承载选择仍待确定。

公开引用按既有 `review_current` 结论选取：每个 completed plan item 的最新返回执行，
并限定为当前 run。Entry 与 Supervisor 在生成最终回复时把选定引用写入该回复的
结构化元数据，后续事件、snapshot 和 Channel 原样传递；历史回放不依赖当前 plan。
当前被打回执行已收集的引用留在执行记录，已发布快照留在 store 中，但不随最终回复交付；
新的文件凭据来源限制尚待上述代码对齐。

仍未决定：已有 URL 如何进入结构化交付，继续等待上文的设计决定；
没有扩展 `publish_artifact` 输入或新增登记工具。可选 system section 未接入。
Console 可下载引用；TUI 当前显示标题和稳定 URI，stdio 模式尚未提供直接打开文件的
本地路径或 HTTP 地址。COS 通过 mock transport 验证，未用真实 bucket 验证；Console
跟随 COS 签名地址时还需 bucket CORS 允许其来源。旧 checkpoint、旧 artifact 数据及
第三方兼容不在本实现范围内；未新增迁移或兼容 reader。
