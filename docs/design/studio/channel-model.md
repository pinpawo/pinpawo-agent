# Channel 模型（#943 重新设计）

> 状态：已定，待实现
> 更新：2026-10-14
> 来源：PR #956 评审后的设计回顾。本文取代 [Channel 寻址、执行与状态](channel-addressing-and-execution.md)
> 中关于目标/修订、参与者登记和 Plugin 输入作者的部分；寻址、session 绑定、可信来源与执行观察规则不变。

## 原则

- **Channel 是自然对话的空间，不是定目标的地方。** 没有必填的目标/范围，也没有修订历史。
- **Channel 是一等实体**，有自己的一行记录；不从消息日志推导。
- **所有参与者都是成员**，成员只分 `human` 和 `pet` 两类。human 背后是人还是外部 agent，Channel 不关心。
  Channel 里没有 operator 概念：持本机 token 的人也只是一个客户身份（见"身份"），和其他成员一样。
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
  author_kind TEXT NOT NULL CHECK(author_kind IN ('human','pet','legacy')),
  author_id   TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  data        TEXT NOT NULL                       -- body、replyTo、mentions、artifacts、source、toolCalls，原样保存
);
CREATE INDEX channel_message_history ON channel_messages(channel_id, sequence);
```

不变的表：`channel_sessions`、`channel_outputs`、`channel_executions`、`channel_tool_call_messages`、
`channel_tool_calls`、`channel_interrupt_notifications`。工具调用结果仍然单独存放，读出时合并进 `toolCalls[].status`。

- 成员关系同时决定能否访问、发言、被 @。离开设置 `left_at`；重新加入清空它。历史消息不受影响。
- `legacy` 只用于迁移来的旧 `bot` 消息，新数据不会产生。前端按"旧来源"显示。

## 规则

- **访问**：请求必须带 Studio 认证后的 principal。不是当前成员的请求返回 403。
- **发言**：作者来自 principal，请求正文不能指定作者。
- **寻址**：只能 @ 当前成员；Pet 回复里的 @ 也按当前 Channel 的成员解析。
- **创建 Channel、增删成员**：Studio 的访问层决定谁能调用；Channel 只要求操作者是成员（创建时创建者自动成为成员）。
  新 Channel 默认加入创建者，Pet 由创建者或其他成员加入，不会自动加入所有 Pet。
- **Pet 视角**：`channel_read_context` 返回 Channel 的标题、说明、成员和分页消息。

## schedule / trigger

- Channel 的 `inputs` hook 改为 `run(channelId, petId, request, origin)`，`origin = {kind: 'scheduler' | 'trigger', id}`。
- Channel 只校验 Pet 是该 Channel 的成员，然后用 (channel, pet) 的 session 和 `scope:{namespace:'channel'}` 派发。
  Pet 的工具调用消息和回复以 Pet 身份写入 `channel_messages`，回复里的 @ 照常交接。
- 指令不写入 Channel 时间线，只进入 Pet 的 session，封装为
  `{type:'channel_task', version:1, channelId, origin, body}`（没有 author）。
- `run()` 返回执行回执（executionId、sessionId）。触发记录和原始指令由 scheduler / trigger 自己的 delivery 日志保存，
  关联方向是它们指向 Channel。

## 身份（Studio）

- 现状：Host 只有一个共享 Bearer（`~/.pinpawo/local-server-token`），`studio-http` 逐个请求比对它。
- 改为客户身份：Studio 维护 `studio_clients(client_id, label, created_at, revoked_at)` 和
  `studio_client_keys(key_hash, client_id, created_at, revoked_at)`，key 只存 SHA-256。同样放在可替换的存储接口后面。
- 本机 token 对应一个普通客户身份，额外拥有全局 Studio API（dispatch、events、pet-sessions）的权限；其他客户只能访问 Channel 路由。
- `studio-http` 统一认证，把 `principal = {clientId, scope: 'studio' | 'channel'}` 放进 `StudioHttpRouteRequest`。
  Channel 把它当作 `human:<clientId>` 使用；label 向 Studio 查询。
- 管理入口：`pinpawo-studio clients add <id> --label <name>`（key 只在创建时打印一次）、`clients revoke`、`clients keys add`。

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
  appendMessage(row: ChannelMessageRow): ChannelMessageRow;
  getMessage(channelId: string, messageId: string): ChannelMessageRow | undefined;
  readMessages(channelId: string, page: Page): PageOf<ChannelMessageRow>;
  // sessions / outputs / executions / tool calls / interrupts：与现有方法一一对应
}
```

接口不做权限判断，读方法不写数据，不保存配置状态。成员规则、默认成员和迁移放在上层的 Channel 服务里。

## 迁移（v5 → v6，一个事务）

1. 每个 Channel 生成一行 `channels`：title 取最新 revision，goal 和 scope 合并进 description，创建者取第一条 revision 的作者。
2. `channel_entries` 中的 message 行搬到 `channel_messages`，作者提升成列（`bot` 写成 `legacy`），`data` 原样保留。
3. revision 行不再保留（内容已经并进 description）。
4. 生成 `channel_members`：历史 human 作者（旧数据里的 `studio-operator` 就是本机 token 的身份，原样保留）、历史发言或已绑定 session 的 Pet。
5. 删除 `channel_entries`。

## 需要调整的地方

| 模块 | 调整 |
|---|---|
| `plugins/channel` 存储 | 新表结构和迁移；抽出 `ChannelStore` 接口与 SQLite 实现；去掉 revision、`expectedRevision`、`channelGoalSchema` 必填的 goal/scope |
| `plugins/channel` 服务/插件 | 成员规则、principal 驱动的访问控制；`inputs` 改为 `run()`；去掉 `bot` 作者、`POST /channels/revisions`；`channel_read_context` 返回标题/说明/成员/消息 |
| `plugins/channel` 派发输入 | 新增 `channel_task` 封装；`channel_message` 去掉 revision 相关字段 |
| `plugins/scheduler`、`plugins/trigger` | 改调 `run()`，在自己的 delivery 记录里保存执行回执 |
| `plugins/studio-http` | 客户身份认证，向路由传 `principal`；全局路由要求 `scope='studio'` |
| `packages/studio` | 客户身份存储与 `clients` CLI；`channels` 命令增加成员管理 |
| `apps/studio-console` | 新建 Channel 只填标题和可选说明；去掉 Goal revision；成员管理；客户身份连接 |
| 默认 Pet 模板（executor、reviewer、wiki） | PET.md / CAPABILITY.md 去掉"核对最新目标与范围"；增加 `channel_task` 的说明 |
| 测试 | channel / scheduler / trigger / studio-http / studio-e2e / Console 浏览器测试；agent-evals 里用到 Channel 输入封装的地方 |
| 文档 | 实现后更新 `channel-addressing-and-execution.md`、`automation-plugins.md`、`http-plugin.md`、`docs/reference/api/studio.md`、`docs/studio/configuration.md`、`skills/studio/SKILL.md` |

建议按两个 PR 依次实现：先 Channel 侧（表、接口、成员、`run()`、模板），再 Studio 客户身份（认证与 principal）。
在第二个 PR 之前，本机 token 固定对应 `human:studio-operator`（沿用现有 id，以免历史作者断开），第二个 PR 把它登记为一个普通客户身份。PR #956 不再继续，按本文重做。
