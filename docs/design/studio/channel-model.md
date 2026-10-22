# Channel 模型（#943 重新设计）

> 状态：已实现（Channel 侧 PR #958，存储 PR #959，Studio 客户身份见下文"身份"）
> 更新：2026-10-14
> 来源：PR #956 评审后的设计回顾。本文取代 [Channel 寻址、执行与状态](channel-addressing-and-execution.md)
> 中关于目标/修订、参与者登记、Plugin 输入作者、Pet 输出路径和执行/审批观察的部分；寻址语法、replyTo 和 session 绑定规则不变。

## 原则

- **Channel 是自然对话的空间，不是定目标的地方。** 没有必填的目标/范围，也没有修订历史。
- **Channel 是一等实体**，有自己的一行记录；不从消息日志推导。
- **所有参与者都是成员**，成员只分 `human` 和 `pet` 两类。human 背后是人还是外部 agent，Channel 不关心。
  Channel 里没有 operator 角色：持本机 token 的人在 Channel 里也只是一个客户身份（见"身份"），读写要先成为成员。
  它唯一多出的权力是管理任何 Channel 的成员，保证 Channel 总能被修复（见"规则"）。
- **作者是事实**：按写入时原样保存，读出时不投影、不随配置改变。
- **身份由 Studio 提供**：Channel 不存用户目录，也不认证凭据，只接收已认证的 principal 并检查成员关系。
- **schedule / trigger 是 Pet 的自发行为**：它们驱动某个 Pet 在某个 Channel 里推进工作，本身不是发言者。
- **持久化可替换**：存储放在 `ChannelStore` 接口后面，接口只做数据操作。

## Channel 数据

```sql
CREATE TABLE channels (
  channel_id      TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  description     TEXT,
  created_by_kind TEXT NOT NULL CHECK(created_by_kind IN ('human','pet')),
  created_by_id   TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE TABLE channel_members (
  channel_id  TEXT NOT NULL REFERENCES channels(channel_id),
  member_kind TEXT NOT NULL CHECK(member_kind IN ('human','pet')),
  member_id   TEXT NOT NULL,
  joined_at   TEXT NOT NULL,
  left_at     TEXT,                                -- NULL = 当前成员
  PRIMARY KEY(channel_id, member_kind, member_id)
);
CREATE INDEX channel_members_by_member ON channel_members(member_kind, member_id) WHERE left_at IS NULL;

CREATE TABLE channel_messages (
  sequence    INTEGER PRIMARY KEY AUTOINCREMENT,  -- 分页游标
  message_id  TEXT NOT NULL UNIQUE,
  channel_id  TEXT NOT NULL REFERENCES channels(channel_id),
  author_kind TEXT NOT NULL CHECK(author_kind IN ('human','pet')),
  author_id   TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  external_ref TEXT,                              -- 来自外部系统的消息 id（如 Agent Session 消息 id），用于幂等写入
  data        TEXT NOT NULL,                      -- body、replyTo、mentions、artifacts，原样保存
  UNIQUE(author_kind, author_id, external_ref)
);
CREATE INDEX channel_message_history ON channel_messages(channel_id, sequence);

CREATE TABLE channel_sessions (                   -- 保留：Channel 里的某个 Pet 用哪个 session
  channel_id TEXT NOT NULL REFERENCES channels(channel_id),
  pet_id     TEXT NOT NULL,
  session_id TEXT NOT NULL,
  registered INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(channel_id, pet_id), UNIQUE(pet_id, session_id)
);
```

Channel 只有这四张表。`channel_outputs`、`channel_tool_call_messages`、`channel_tool_calls`、`channel_executions`、
`channel_interrupt_notifications` 都去掉：它们是 Pet 运行过程（工具调用、dispatch 生命周期、审批）的副本，
属于 Host 和 Agent Session。

- 成员关系同时决定能否访问、发言、被 @。离开设置 `left_at`；重新加入清空它。历史消息不受影响。

## 规则

- **访问**：请求必须带 Studio 认证后的 principal。不是当前成员的请求返回 403。
- **发言**：作者来自 principal，请求正文不能指定作者。
- **寻址**：只能 @ 当前成员；Pet 回复里的 @ 也按当前 Channel 的成员解析。
- **创建 Channel、增删成员**：Studio 的访问层决定谁能调用；Channel 要求操作者是成员。
  不能移除最后一个人类成员（返回 409），所以 Channel 不会只剩 Pet。持本机 token（`studio` 范围）的调用方
  不是成员也能列出所有 Channel（`GET /channels?all=true`）、查看和增删任何 Channel 的成员，但读消息、发言仍要先加入。
  创建时必须明确列出要加入的 Pet（`pets: [...]`），它们和创建者一起成为初始成员；不会自动加入所有 Pet。之后仍可增删。
- **Pet 视角**：`channel_read_context` 返回 Channel 的标题、说明、成员和分页消息。

## Pet 在 Channel 里

- **Pet 的消息就是普通消息。** Pet 的 Agent Session 里主对话的公开 assistant message（沿用 `isPublicConversationMessage`：
  只取主对话，subagent 等私有 lane 和合成消息不算）
  按普通消息写入 `channel_messages`：作者 `pet:<id>`，`external_ref` 是它在 Agent Session 里的消息 id，正文原样保存。
  它和人的消息同形、同表、走同一套寻址和交接，不加 Pet 专用字段（不再有 `source`、`toolCalls`）。
  `external_ref` 是通用的幂等字段，任何来自外部系统的消息都可以用。
- **Pet 怎么把结果说回 Channel**：不通过 toolkit 写。(Channel, Pet) 绑定的专用 session 里，Pet 的公开 assistant message
  就是它在 Channel 里的发言。Channel 按 session 只订阅 Agent Session 的 `message.completed`（带 messageId，作 `external_ref` 去重），
  写入后解析 @ 做交接。带工具调用的 assistant 消息（`message.tool_calls`，包括它附带的正文）属于执行过程，不展示、不写入 Channel，
  其中的 @ 也不交接；PET.md 写清楚交接要写在不调用工具的回复里。
  这样与人发言对称：人的消息进 Pet 的 session 成为输入，Pet 的公开回复进 Channel 成为消息。Pet 不需要知道 Channel 的写入协议，
  Channel toolkit 只保留读（`channel_read_context`）。每条公开消息都可以 @；PET.md 写清楚只在要交接时才写 @。
- **@ 没有特殊路径。** Pet @ 其他成员（人或 Pet）和人 @ 成员完全一样：一条带 mentions 的消息写入 Channel，
  再由 Channel 统一的 mention 机制投递。不为 Pet 做任何特殊处理。
- **过程不存，成员也不看过程。** Pet 的 operation（工具执行等）、subagent 消息和运行状态（排队、运行、等待审批、失败）
  不写进 Channel，Channel 成员只能看到主对话的公开消息。持本机 token 的人仍可通过 `channel_sessions` 找到 session，
  用已有的 Pet session 视图（`PetSessionView`，`/pet-sessions/snapshot|events|review`，#925）查看过程并处理审批；
  这属于全局 Studio API，不是 Channel 成员权限。
- **交接**：消息 @ 了 Pet 时，Channel 用 `channel_sessions` 的 session 和 `scope:{namespace:'channel'}` 派发。
  没有 @ 的消息只写入 Channel，不派发给任何 Pet，单 Pet 的 Channel 也一样；`replyTo` 不算 @，回复 Pet 的消息不会唤醒它。
  Channel 没有默认或兜底 Pet。Pet 只在下次被 @ 或被 schedule / trigger 唤醒时，通过 `channel_read_context` 读到这些消息。
  可选的 [Channel Router](channel-router.md) Plugin 可以为人类的无 @ 消息选一个 Pet 派发（设计草案）；没装它时行为如上。
  投递结果不落库：发起请求的一方在响应里拿到；同时 Channel 在全局事件总线上发布投递事件（含失败），
  不区分发言者是人还是 Pet。
- **投递失败是 best-effort 边界。** Pet 的公开消息由订阅写入，没有请求方：它 @ 的对象投递失败时，只有全局事件可见
  （持本机 token 的 Console 能看到），Pet 自己和普通成员不会收到回执。本阶段接受这个边界，不恢复执行历史、重试或协调者。
  以后如需有限反馈，再单独设计（例如把失败作为一条可见消息写回 Channel）。

## 事件

Channel 只向 Studio 的全局事件总线发布事件（新消息、投递结果、成员变化）。事件和成员关系没有关联：
谁能收到、怎么消费，由暴露事件的 Plugin（例如 `studio-http`）决定，Channel 不做按成员过滤的事件流。

## schedule / trigger

- Channel 的 `inputs` hook 改为 `run(channelId, petId, request, origin)`，`origin = {kind: 'scheduler' | 'trigger', id}`。
- Channel 只校验 Pet 是该 Channel 的成员，然后用 (channel, pet) 的 session 和 `scope:{namespace:'channel'}` 派发。
  Pet 的公开消息照常以 Pet 身份写入 `channel_messages`，其中的 @ 照常交接。
- 指令不写入 Channel 时间线，只进入 Pet 的 session，封装为
  `{type:'channel_task', version:1, channelId, origin, body}`（没有 author）。
- `run()` 返回 Host 的派发回执（invocationId）和 sessionId。触发记录和原始指令由 scheduler / trigger 自己的 delivery 日志保存，
  关联方向是它们指向 Channel。

## 身份（Studio）

- 以前 Host 只有一个共享 Bearer（`~/.pinpawo/local-server-token`）。现在是客户身份：Studio 维护 `studio_clients(client_id, label, created_at, revoked_at)` 和
  `studio_client_keys(key_hash, client_id, created_at, revoked_at)`，key 只存 SHA-256。表建在 [Studio 存储](storage.md) 里，存储接口是 `ClientStore`
  （[`packages/studio/src/clients/`](../../../packages/studio/src/clients/)）。
- 本机 token 对应普通客户 `local`（启动时登记），额外拥有全局 Studio API（dispatch、events、pets、pet-sessions、clients）的权限；
  其他客户只能访问以 `authorization: 'client'` 注册的路由，目前就是 Channel 路由。
- `studio-http` 统一认证，把 `principal = {clientId, scope: 'studio' | 'client'}` 放进 `StudioHttpRouteRequest`。
  Channel 把它当作 `human:<clientId>` 使用；label 向 Studio 查询；只有未吊销的客户能被加为 human 成员。
- 管理入口：`pinpawo-studio clients add <id> --label <name>`（key 只在创建时打印一次）、`clients add-key`、`clients revoke`、`clients list`，
  对应 HTTP 的 `/clients*`。
- 谁能管理成员：任何当前成员（不区分角色），以及本机 token；最后一个人类成员不能被移除。
- 已知限制：`/events` 是全局事件流，只给本机 token；其他客户看 Channel 只能轮询。

## 存储接口

```ts
interface ChannelStore {
  transaction<T>(run: () => T): T;
  createChannel(row: ChannelRow): void;
  updateChannel(channelId: string, patch: { title?: string; description?: string | null }): void;
  getChannel(channelId: string): ChannelRow | undefined;
  listChannels(filter: { member?: MemberRef }, page: Page): PageOf<ChannelRow>;
  listMembers(channelId: string): ChannelMemberRow[];
  upsertMember(row: ChannelMemberRow): void;
  appendMessage(row: ChannelMessageRow): ChannelMessageRow;     // 带 external_ref 时幂等
  getMessage(channelId: string, messageId: string): ChannelMessageRow | undefined;
  readMessages(channelId: string, range: MessageRange): MessagePage; // 默认最近一页；after 往后、before 往前
  getSession(channelId: string, petId: string): ChannelSessionRow | undefined;
  reserveSession(row: ChannelSessionRow): ChannelSessionRow;
  confirmSession(row: ChannelSessionRow): void;
  listSessions(channelId: string): ChannelSessionRow[];
}
```

接口不做权限判断，读方法不写数据，不保存配置状态。成员规则和默认成员放在上层的 Channel 服务里。

## 旧数据

不兼容旧数据，不做迁移。新实现使用新的存储（现在是 [Studio 存储](storage.md) 里的 Channel 表），启动时不读取旧的 `channels.sqlite`；
旧 Channel、消息和绑定不再可见。发布说明里写明这一点。

## 需要调整的地方

| 模块 | 调整 |
|---|---|
| `plugins/channel` 存储 | 新表结构（不迁移旧数据）；抽出 `ChannelStore` 接口与 SQLite 实现；去掉 revision、`expectedRevision`、`channelGoalSchema` 必填的 goal/scope |
| `plugins/channel` 服务/插件 | 成员规则、principal 驱动的访问控制；`inputs` 改为 `run()`；去掉 `bot` 作者、`POST /channels/revisions`；`channel_read_context` 返回标题/说明/成员/消息；不再订阅 `dispatch.message` 的工具调用，也不记录执行、审批；Pet 公开消息按普通消息映射 |
| `GET /channels/executions`、`/channels/interrupts`、`POST /channels/execute` | 去掉；交给 Pet 统一用带 @ 的消息；过程由本机 token 按 `channel_sessions` 读 Agent Session |
| `POST /channels` | 增加必填的 `pets: [...]`，创建时一起加入 |
| `plugins/channel` 派发输入 | 新增 `channel_task` 封装；`channel_message` 去掉 revision 相关字段 |
| `plugins/scheduler`、`plugins/trigger` | 改调 `run()`，在自己的 delivery 记录里保存执行回执 |
| `plugins/studio-http` | 客户身份认证，向路由传 `principal`；全局路由要求 `scope='studio'` |
| `packages/studio` | 客户身份存储与 `clients` CLI；`channels` 命令增加成员管理 |
| `apps/studio-console` | 新建 Channel 只填标题和可选说明；去掉 Goal revision 和执行历史；成员管理；客户身份连接；`PetSessionView` 的入口从执行历史的 "View session" 改到成员列表里的 Pet 和 Pet 的消息上 |
| 默认 Pet 模板（executor、reviewer、wiki） | PET.md / CAPABILITY.md 去掉"核对最新目标与范围"；增加 `channel_task` 的说明 |
| 测试 | channel / scheduler / trigger / studio-http / studio-e2e / Console 浏览器测试；agent-evals 里用到 Channel 输入封装的地方 |
| 文档 | 实现后更新 `channel-addressing-and-execution.md`、`automation-plugins.md`、`http-plugin.md`、`docs/reference/api/studio.md`、`docs/studio/configuration.md`、`skills/studio/SKILL.md` |

按 PR 依次实现：Channel 侧（#958）、Studio 存储（#959）、Studio 客户身份。PR #956 不再继续，按本文重做。
