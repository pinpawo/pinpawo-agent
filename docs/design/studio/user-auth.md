# Studio 用户身份登录

> 状态：设计草案（未实现）
> 更新：2026-11-05
> Issue：[#1053](https://github.com/pinpawo/pinpawo-agent/issues/1053)

Studio 目前只有「凭证」，没有「人」。本文设计一层最小的用户身份：用户用用户名密码登录，
拿到自己的会话凭证，用这个身份同时访问 Studio HTTP 与 Channel。设计成立的关键是**不新造
身份体系**——登录用户直接映射成一条已有 `studio_clients` 记录，Channel 的
`human:<clientId>` 语义、成员关系和吊销语义因此自动继承。

## 1. 现状

鉴权分三层，全部集中在两个地方：

| 层 | 位置 | 行为 |
|---|---|---|
| 本机 Host token | `services/host/src/wire/auth.ts` | `~/.pinpawo/local-server-token`（32 字节 base64url，0600，仅文件缺失时生成）；只认 `Authorization: Bearer`，`timingSafeEqual` 比较，显式拒绝 query token 与 WS subprotocol；`isAllowedWireOrigin` 只允许回环且端口等于本地端口 |
| Studio HTTP | `plugins/studio-http/src/studioHttpPlugin.ts` | 默认 3211，`LOOPBACK_HOST = '127.0.0.1'` 硬编码；`allowedOrigins` 显式集合，非白名单 `403`；`authenticate()` 是唯一把 Bearer 换成 principal 的地方；`principal.scope` 只有 `studio` / `client` 两级；内置路由除 `GET /me`、`GET /pets` 外只接受 `studio` scope |
| 外部 JWT | `plugins/studio-http/src/jwtIssuers.ts` | `jwt.issuers` 配置后用 `jose` 校验 `iss`/`aud`/`exp`/`sub`，`sub` 映射为 `<clientPrefix>.<sub>`，首次使用自动登记客户，本地吊销优先 |

「用户」其实已经存在，只是没有自助入口：

- `packages/studio/src/clients/studioClients.ts` 的 `studio_clients` / `studio_client_keys` 两张表，key 前缀 `pps_`，只存 SHA-256，创建时返回一次，可吊销；
- 管理入口 `POST /clients`、`/clients/keys`、`/clients/revoke` 只接受本机 token，CLI 是 `pinpawo-studio clients`；
- Channel（`plugins/channel/src/channelPlugin.ts`）把请求 principal 直接当 `human:<clientId>`，成员表只分 `human` / `pet`，未吊销客户才能加为成员。

缺口只有三处：没有账号密码存储、没有登录端点、Console 只能粘贴 token。因此本次不新增
身份实体，只新增「认证方式 + 权限粒度」。

## 2. 目标与非目标

目标：

1. 用户用用户名 + 密码登录，拿到自己的会话凭证；
2. 该身份同时可用于 Studio HTTP 与 Channel，不需要管理员线下发 key；
3. 权限可管：谁能看 Channel、谁能 dispatch、谁能进 Pet session，由管理员显式授予；
4. 未启用时行为与今天完全一致；本机 token、`pps_` key、外部 JWT 都继续有效。

非目标：

- SSO / LDAP / OIDC 对接（保留 `jwt.issuers` 作为后续扩展路径）；
- 注册审批、邀请邮件、邮件找回密码；
- TLS 与反向代理本身（沿用「loopback + SSH 隧道，或同机反代终结 TLS」的既有边界）；
- OS 级隔离：登录用户仍是 Studio 调用方，Pet 执行以 Host 进程权限运行（见 §9）。

## 3. 方案

### 3.1 形态：独立插件

新增 `plugins/studio-auth`（包名 `@pinpawo-plugin/studio-auth`），在 Studio 配置
`<workdir>/.pinpawo/studio.json` 的 `plugins` 数组里显式启用，默认不启用：

```json
{ "id": "@pinpawo-plugin/studio-auth", "options": { "sessionTtlHours": 12, "idleTimeoutMinutes": 30 } }
```

插件做三件事：

1. 用自己的迁移历史建 `studio_auth_*` 三张表（`studio.storage.open('studio_auth', migrations)`）；
2. 向 `http` 贡献 `/auth/*` 与 `/users*` 路由；
3. 向 `http` 贡献一个**凭证校验器**，让 Studio HTTP 能识别会话 token。

选择插件而不是内置到 HTTP：HTTP 插件按现有约定不感知领域（它只转发 `context.dispatch` 与
贡献 route），账号表也不该属于 Studio core 的 `studio_clients` 迁移。Trigger 插件已有
`authorization: 'route'` 的先例，说明「插件自己校验凭证」是既有模式，见
[HTTP Plugin](http-plugin.md) §1 `routes` hook。

### 3.2 账号与密码

密码学不自己写：账号、密码哈希、凭据账户都交给 **Better Auth**（见 §3.9）。

- Better Auth 的 `emailAndPassword` 负责 scrypt 哈希与校验，`username` 插件负责登录名（大小写不敏感、唯一）；
- Studio 只保留策略：密码长度 ≥ 12（上限 256），管理员建号时必须给初始密码，不强制首登改密，但支持自助改密；
- 用户名是登录句柄，Better Auth 仍要求 email，因此内部用 `<username>@studio-auth.invalid` 合成，用户永远看不到也不会用到它；
- 用户名校验 `^[A-Za-z0-9][A-Za-z0-9._-]{0,57}$`（留出 `user.` 前缀后仍满足 Studio client id 的 64 字符上限）；
  同一条规则以 `usernameValidator` 传给 Better Auth 的 username 插件（并把其最短长度从默认 3 调到 1），
  否则 `ab`、`ada-lovelace` 这类合法名字会"本地通过、Better Auth 拒绝"，最后变成误导性的 409。
  校验统一在创建 Studio client **之前**，失败直接 `400`，不会留下孤儿 client。

### 3.3 会话凭证

会话同样由 Better Auth 签发，本插件只补"过期之外"的两条规则：

- 会话表 `studio_auth_session`（`token`、`user_id`、`expires_at`、`updated_at`）；token 是 Better Auth 生成的不透明串，插件只做形状预检（`^[A-Za-z0-9_-]{20,200}$`）再交给 `getSession({headers})`；
- 绝对有效期 12 小时（`expiresIn = updateAge`，因此不会被滚动续期无限延长）；空闲 30 分钟由本插件读 `updated_at` 判定，超时即删除该会话并 `401`；
- 撤销：登出删除当前会话行；改密删除该用户其他会话；管理员禁用删除全部会话且禁止再登录；client 被 `POST /clients/revoke` 吊销后，认证阶段直接拒绝；
- 传输沿用现有 `Authorization: Bearer`（当前部署无 TLS，因此不用 cookie）；`bearer` 插件只用于让 `getSession` 接受这个头；
- 扩展点：将来经 TLS 反代暴露时，可切换为 HttpOnly + SameSite cookie，token 与表结构不变。

### 3.4 身份映射：用户即 Studio client

- 每个用户对应一条 `studio_clients`：`clientId = 'user.<username>'`；
- 必须满足现有校验 `^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`（`studioClients.ts` 的 `CLIENT_ID`），所以用 `.` 而不是 `:`；同时要避开 JWT issuer 的 `<clientPrefix>.<sub>` 命名空间，因此 `user` 声明为本插件保留前缀，issuer 不得使用；
- 会话 principal：`{ clientId: 'user.<username>', scope: 'client', capabilities: [...] }`；
- Channel 侧零改动：`human:user.<username>` 自动成为成员引用，label 反查走 `studio_clients`；
- 管理员吊销该 client（`POST /clients/revoke`）后，其会话在认证阶段即被拒绝（校验 client 未吊销）。

### 3.5 权限模型

保留两级 `scope`，新增 capability 列表：

| capability | 含义 |
|---|---|
| `channel.read` | 读取自己所在 Channel 的成员、消息、session 绑定 |
| `channel.write` | 发消息、建 Channel、管理成员；在 Channel 内 `@` 一个 Pet 会真正触发该 Pet 运行（见 3.5.1） |
| `studio.view` | 读 `/dispatch/queues`、Pet 列表等只读投影 |
| `studio.dispatch` | 仅 `POST /dispatch`（HTTP 直调），不含经 Channel 触发的运行，见 3.5.1 |
| `studio.events` | 订阅 `GET /events` 全局事件流 |
| `pet.session` | `/pet-sessions/*`（snapshot / events / review） |
| `studio.manage` | `POST /pets`、`/pets/rename`、`GET /pet-definitions` |

默认最小集：`channel.read`、`channel.write`、`studio.view`；dispatch、事件流、Pet session
需要管理员显式授予。本机 token 保持 `studio` scope + 全部 capability，`pps_` key 与 JWT
客户默认只拿到 `channel.read` / `channel.write`（与今天能用 Channel 路由的行为一致）。

落点：

- `StudioHttpPrincipal` 增加**可选** `capabilities?: readonly string[]`：只有插件贡献的凭证（登录会话）带这个字段；本机 token、`pps_` key、JWT 不带，继续走原来的兜底规则（`studio` 全权，`client` 只拿 `channel.read` / `channel.write`）。`/me` 也只在凭证声明了 capabilities 时才回显该字段，老客户端的响应形状不变；
- `StudioHttpRoute` 增加可选 `capability?: string`，语义是**附加要求**，不是放行条件：声明了 capability 的路由仍要先过 scope 判定，所以给 `authorization: 'studio'` 的路由加 capability 不会把管理路由开放给普通用户；
- 允许「capability 打开某条内置路由」的**唯一**入口是 `studio-http` 自己维护的 `BUILTIN_ROUTE_CAPABILITIES` 白名单（`POST /dispatch`、`GET /events`、`/pet-sessions/*` 等），外部插件只能加要求、不能自行放大；
- 内置路由标注：`POST /dispatch` → `studio.dispatch`，`GET /events` → `studio.events`，`/pet-sessions/*` → `pet.session`，`GET /dispatch/queues` → `studio.view`，`POST /pets`、`/pets/rename`、`GET /pet-definitions` → `studio.manage`；`/clients*`、`/users*` 仍只接受本机 token；
- Channel 路由由 channel 插件自己声明 `channel.read`（GET）/ `channel.write`（POST）：成员关系决定「能看到什么」，capability 决定「能不能碰 Channel」；
- 缺 capability 的判定顺序：先 scope 再 capability。声明了 capabilities 的凭证会收到 `"This client lacks the \"<capability>\" capability."`，`pps_` key / JWT 继续收到原来的 `"This client may not use this route."`（状态码都是 `403`）；
- 三条资源边界：workdir 归属（Host 级，当前单 workdir，不做多租户）、Pet 归属（capability 先行，细化到 definition 是后续）、Channel（成员关系决定可见性，已实现）。

#### 3.5.1 两类执行入口：HTTP 直调与 Channel

一个容易误解的点要先说清楚：**`studio.dispatch` 只约束 HTTP 直调 `POST /dispatch`，不约束经 Channel 触发的 Pet 运行。**

经 Channel 的路径是：`POST /channels` 携带 `pets: [petId]` 建 Channel → `POST /channels/messages` 携带 `mentions: [{ participantId: 'pet:<petId>' }]` → `channelPlugin.dispatchPet()` → `host().dispatch()` → `pet.runtime.dispatch.dispatch`。这条链路只经过两个判定：

1. Channel 路由的 capability（`channel.write`）；
2. Channel 成员关系（Pet 必须是当前成员，`requireMember`）与 client 未吊销。

也就是说，**默认权限集里的 `channel.write` 已经等价于「可以在 Channel 内让 Pet 干活」**。这是有意的产品决定（PR #1055 review 第 1 条的结论），理由：

- Channel 现有的授权模型是「成员身份 + 客户未吊销」，成员关系本身就表达「允许这个人在这个 Channel 里说话」；再叠一层 `studio.dispatch` 会让两套规则互相解释不清——同一句 `@executor` 到底看成员还是看 capability？
- `pps_` key 与外部 JWT 默认只有 `channel.read` / `channel.write`，若让 Channel 触发也要求 `studio.dispatch`，既有 Channel 集成会静默失效，需要额外兜底与迁移；
- 想限制「谁能让 Pet 干活」，正确的位置是 Channel 成员管理和 capability 授予（不给 `channel.write`，或不让该 Pet 加入这个 Channel），而不是在 dispatch 入口再加一道。

安全含义写成一句话：**给一个用户 `channel.write`，等于给他在他能进入的 Channel 里触发 Pet 的能力**；只读用户给 `channel.read` / `studio.view`，不要给 `channel.write`。

将来若要收紧到「任何 Pet 执行都必须显式授权」，需要动三处：`channelPlugin` 的 `dispatchPet()`（以及 `deliver` / `run` 两条调用点）加 capability 判定、给 `pps_` / JWT 的 `DEFAULT_CLIENT_CAPABILITIES` 补 `studio.dispatch` 兜底、以及一次针对存量用户的数据迁移（补齐或明确降级）。本分支没有做这件事，行为保持与今日一致。

### 3.6 认证接入：`authenticators` hook

HTTP 插件新增一个可选 hook（与 `routes` 同为 `StudioPluginHooks` 上的具名 hook）：

```ts
export type StudioHttpAuthenticator = {
  /** Return a principal for a token this authenticator owns, else undefined. */
  verify: (token: string) => Promise<StudioHttpPrincipal | undefined> | StudioHttpPrincipal | undefined;
};
```

`authenticate()` 的顺序：本机 token → 外部 JWT（现有 `looksLikeJwt` 分支）→ client key →
贡献的 authenticators（按注册顺序，第一个返回 principal 的胜出）。这样 HTTP 插件仍然不知道
「用户」是什么，只认识 `StudioHttpPrincipal`；未启用 studio-auth 时这个 hook 为空，行为与今天一致。

### 3.7 存储

实现走插件自有迁移历史（`studio.storage.open('studio_auth', …)`，与 `studio_clients` 的
`0001_clients` 互不干扰）。四张 Better Auth 表由 `getAuthTables(studioAuthOptions(...))` 在迁移
`0001_better_auth` 里按**安装的库版本**生成，表名统一加 `studio_auth_` 前缀：

```sql
-- 0001_better_auth：四张表由库生成，字段名映射见 authOptions.ts
create table studio_auth_user (
  id text primary key,
  name / email / email_verified / image,
  created_at / updated_at,
  username / displayUsername,                  -- username 插件
  client_id,                                   -- 'user.<username>'（additionalFields）
  capabilities,                                -- JSON 数组
  failed_attempts, locked_until, disabled_at
);
create table studio_auth_account (             -- 密码凭据行（provider_id = 'credential'）
  id text primary key, account_id, provider_id, user_id, password, …
);
create table studio_auth_session (
  id text primary key,
  token,                                       -- 见下：存的是 SHA-256 hex，不是原 token
  user_id, expires_at, created_at, updated_at, ip_address, user_agent
);
create table studio_auth_verification ( … );   -- 库要求存在，本设计不使用
create index studio_auth_user_by_username on studio_auth_user (username);
create index studio_auth_session_by_user on studio_auth_session (user_id);

-- 0002_auth_audit
create table studio_auth_audit (
  occurred_at  text not null,
  action       text not null,                  -- login.ok / login.fail / logout / password.change / user.create / user.disable / user.capabilities
  username     text,
  user_id      text,
  result       text not null,                  -- ok / denied / error
  reason       text,
  remote_addr  text,
  user_agent   text
);
create index studio_auth_audit_by_time on studio_auth_audit (occurred_at);

-- 0003_auth_session_token
create index studio_auth_session_by_token on studio_auth_session (token);

-- 0004_auth_credential_version
alter table studio_auth_user    add column credential_version integer not null default 0;
alter table studio_auth_session add column credential_version integer not null default 0;
```

**会话凭证只存哈希。** Better Auth 自己的 session API 会把原 token 落库，因此本插件不使用它：
登录校验通过后由插件 `randomBytes(32)` 自签 token，库里只写 `sha256(token)`，`updated_at`
同时充当「最后使用时间」以驱动空闲超时（绝对 12h + 空闲 30min，不滚动续期）。会话 `id` 由插件
生成，登出/改密/禁用都按 `id` 或 `user_id` 删除。这样即使数据库或备份泄露，也拿不到可用的
`Authorization` 值。

**凭据版本。** 登录与改密是两条并发路径：登录先读密码哈希、异步校验，再签发会话；改密则在写新
哈希后吊销全部会话。两步之间若不加协调，一个用旧密码获准的登录可能在吊销发生之后才把会话写进
库，于是"改完密码旧密码仍能进"。因此：

- `studio_auth_user.credential_version` 在每次改密/重置时于同一事务内 +1；
- 登录用一次读取拿到的 `{hash, version}` 作为快照去校验；签发会话时在事务内重新比对版本，不一致
  就不签发（对外仍是 `401 Invalid username or password.`，审计 `reason=credential-changed`）；
- 会话行记录签发时的版本，`verifySession` 发现版本落后即删除该会话并拒绝；
- 管理员重置 = 递增版本 + 写新哈希 + 删除该用户全部会话，同一事务；
- 自助改密 = 递增版本 + 写新哈希 + 删除其它会话，并把**当前会话**重标为新版本（发起改密的这台
  设备继续可用），其余设备立即失效。

**版本闸覆盖两条写入路径**，不只是登录签发：

- 登录：快照里的 `{hash, version}` 一起校验，事务内比对版本后才签发会话（见上）；
- 自助改密：校验用的哈希与提交时比对的版本来自**同一个快照**；提交时先做条件递增
  `UPDATE ... SET credential_version = credential_version + 1 WHERE id = ? AND COALESCE(credential_version,0) = ?`，
  影响行数为 0 就整体回滚 —— 密码不写、会话不动、当前会话也不重标，返回 `409`
  （`{"error": "Password was changed elsewhere. Sign in again and retry."}`），审计
  `password.change / denied / reason=credential-changed`。

为什么必须两条都盖：自助改密要先用 scrypt 异步校验旧密码，这个耗时窗口里管理员可能已经完成重置并
吊销会话；若提交时不比对版本，旧请求会把管理员刚设的新密码**覆盖回**用户自选的新密码，而两边审计
都显示 `ok`，事后无法从审计看出被覆盖。加上版本条件后，这类过期写入会被拒绝，操作员的动作总是生效。
两个自助改密并发时同理：后提交者 `409`，先提交者的新密码生效。

当前会话的保留同样是条件性的：只有该会话行仍存在、且其 `credential_version` 仍等于本次读到的版本时
才重标为新版本；否则不重标，并返回 `200 {"revoked": true}`，明确告知这台设备需要重新登录（不再出现
"返回成功但实际已被登出"）。

**管理员重置同样走版本闸，禁用也递增版本。** 只盖登录与自助改密还不够，剩下两处写入会让并发结果
不可解释：

- **管理员重置**（`POST /users/password`）：处理开始时读取 `{hash, version}` 快照，提交时带上
  `expectedVersion` 走同一套条件递增。两个操作员同时重置同一个账号时，先落库的那个生效，另一个拿到
  `409 {"error": "Password was changed elsewhere. Reload the user and retry."}` 并**不覆盖**，
  审计写 `user.password / denied / reason=credential-changed`。调用方拿到 `409` 应重新拉取用户状态
  （`GET /users`）后重试，而不是盲目重发。
- **禁用**（`POST /users/disable` 且 `disabled: true`）：状态变更、版本 +1 与会话删除在**同一事务**里
  完成。这样"改密已校验旧密码、尚未落库"时发生的禁用会让那次改密在提交时被版本闸拦下（`409`），
  不会出现"账号已禁用但密码被改掉"的残留。

哪些动作动 `credential_version`，一句话记法：**登录不动；自助改密 +1；管理员重置 +1；禁用 +1**。
新增任何管理动作时，只要它会写入凭据或改变账号可用性，就必须在这张表里补一行，否则版本闸会被绕过。

时间一律 ISO-8601 文本，与 `studio_clients` 等现有表一致；`studio_auth_user.client_id`
**不建跨 owner 外键**（迁移顺序与 SQLite/Postgres 行为差异），由应用层保证「先建 client 再建 user」：
建号时先 `clients.ensure`，再 `signUpEmail`。若后者失败，留下的是一个没有任何凭据的 client 行，
不会产生"有身份却无法登录"的用户；同一用户名重试即可继续使用该 client。
审计表**不记录密码、token、token 哈希**。

`remote_addr` 来自 HTTP 层传下来的 socket 对端地址（`StudioHttpRouteRequest.remoteAddress`），
而不是转发头：只有部署显式声明 `trustProxy` 时才采信 `X-Forwarded-For`（取首段）。IPv4-mapped
IPv6（`::ffff:127.0.0.1`）归一化为 IPv4，IPv6 zone id 丢弃，便于与其它日志对照。

### 3.8 失败锁定与限速

- 同一 `username_lower` 在 15 分钟窗口内累计 5 次失败 → 锁定 15 分钟（`locked_until`），锁定期间返回 `429` 且不校验密码；
- 登录成功清零 `failed_attempts`；
- 计数与锁定写在 `studio_auth_user.failed_attempts` / `locked_until` 上，因此重启不丢、可测；
- Better Auth 自带按 IP 的限流默认关闭（`rateLimit.enabled = false`），避免两套计数互相打架；按地址限速留作后续增强（Session 级目标见 §10）；
- 管理员禁用期间或 client 已吊销时，即使密码正确也拒绝。

### 3.9 实现选型：用 Better Auth，而不是手写密码学

手写 scrypt + 会话表当然可行，但认证是"错了很难发现"的一类代码，所以实现选了成熟库：

| 方案 | 结论 |
|---|---|
| **Better Auth**（`better-auth@1.7.x`） | **采用**。TypeScript 原生、框架无关、自带 email+password、session、username 插件、可吊销会话，官方支持 Kysely 适配器（本项目存储就是 Kysely + `node:sqlite`） |
| @oslojs/* 原语 + 手写 | 控制力最强，但密码学细节与 session 语义都要自己维护，违背"简单可靠" |
| NextAuth / Passport | 与自建 Hono 路由 + Bearer 不匹配 |
| Keycloak / Ory Kratos 等 IdP | 需要额外服务与运维，对单机 Studio 过重；将来要接公司统一身份时更有价值 |

代价与边界：

- Better Auth 自带 `user` / `session` / `account` / `verification` 四张表，表名统一加 `studio_auth_` 前缀；`client_id`、`capabilities`、`failed_attempts`、`locked_until`、`disabled_at` 是它允许的 `additionalFields`，身份规则仍在本插件；
- 表结构由 `getAuthTables(studioAuthOptions(...))` 在迁移时按库版本生成，**库升级若改 schema，启动时 Better Auth 的 schema 校验会直接报错**，而不是运行时才炸；
- **用它的地方**：`signUpEmail` 建号 + 凭据行、`hashPassword` / `verifyPassword`（`better-auth/crypto` 的 scrypt，走 libuv 线程池）；这两项是"写错了很难发现"的密码学部分；
- **不用它的地方**：不用它的 HTTP handler、不给它监听端口、不接 cookie/social/OAuth；**也不使用它的 session API**（会把原 token 落库），会话由本插件自签并只存 SHA-256（见 §3.7）。因此 `session` 表虽然存在，但只承载插件写入的哈希行；
- 版本精确锁定（`"better-auth": "1.7.17"`，不带 `^`）：迁移与哈希行为都绑定该版本，升级要有意识地做并跑登录/改密用例；
- 不把 Better Auth 的 cookie/social/OAuth 能力接进来，保持只支持"用户名 + 密码"这一条路径。

## 4. 端点草案

| 路由 | 鉴权 | 请求 | 响应 |
|---|---|---|---|
| `POST /auth/login` | `route`（handler 自校验） | `{username, password}` | `200 {token, expiresAt, user: {userId, username, clientId, capabilities}}`；`401 {error: "Invalid username or password."}`（密码错、用户名不存在、账号被禁用都是这一个答案）；`429 {error: "Too many attempts.", retryAfterSeconds}`；`403 {error: "This client has been revoked."}`（密码已通过但 client 被吊销） |
| `POST /auth/logout` | 会话 | – | `204` |
| `GET /auth/me` | 会话 | – | `200 {userId, username, clientId, capabilities, expiresAt}` |
| `POST /auth/password` | 会话 | `{currentPassword, newPassword}` | `204`（撤销该用户其他会话，当前会话保留）；`401` 旧密码错；`400` 参数/口令长度不合法；`409` 凭据在提交前已被改密/重置（条件提交未命中，整体回滚，需重新登录后重试）；`200 {"revoked": true}` 表示改密已生效但当前会话在此期间被吊销，需重新登录 |
| `GET /users` | 本机 token | – | `200 {users: [{userId, username, clientId, displayName, capabilities, disabledAt?, lockedUntil?}]}` |
| `POST /users` | 本机 token | `{username, password, displayName?, capabilities?}` | `201 {userId, clientId, capabilities}`；`409` 用户名已存在 |
| `POST /users/password` | 本机 token | `{userId, password}` | `204`，撤销该用户全部会话；`409 {error: "Password was changed elsewhere. Reload the user and retry."}` 并发重置时后提交者被拒（条件提交未命中，整体回滚，密码与会话均不变） |
| `POST /users/capabilities` | 本机 token | `{userId, capabilities}` | `200 {userId, capabilities}` |
| `POST /users/disable` | 本机 token | `{userId, disabled}` | `200 {userId, disabled}`；禁用同时吊销 client 与会话，并在同一事务内递增 `credential_version`，使进行中的自助改密无法再落库 |

状态码约定：`401` 未认证（无/过期/已吊销凭证）或登录凭据无效；`403` 已认证但无 capability、
或不属于该 Channel；`429` 登录被锁定；`400` 请求体不是合法 JSON；`415` 请求的
`Content-Type` 不是 `application/json`。后两者沿用 `studio-http` 的 `HttpRequestError`
（该错误类已从包导出），插件把它转成同样的状态码，而不是折成 `500`。所有响应沿用现有 `{error}` 结构。
`409` 用于"凭据已被他人/管理员改动"的乐观并发冲突（自助改密或管理员重置的条件提交未命中），与 `401`
（旧密码错误）区分开，避免把并发冲突误报成密码输错。

**不能**把 `/auth/*`、`/users*` 加进 `RESERVED_ROUTE_PATHS`：那个集合是 `normalizeRoute` 拒绝
贡献方注册的清单，加进去会让本插件自己的路由在注册时直接抛
（`Studio HTTP route must use an unreserved absolute path`），插件起不来。这两组路径不是
`studio-http` 内置路由，因此留给插件注册即可；重复注册由 hook 的 `routes` 映射按
`METHOD /path` 覆盖，属于配置错误，会在开发期暴露。`/auth/login` 走 `authorization: 'route'`，
因此仍需通过 `allowedOrigins` 与 body limit 检查（Console 源本来就在白名单里）。

## 5. 需要改动或新增的文件

新增 `plugins/studio-auth/`：

- `package.json`（`@pinpawo-plugin/studio-auth`）
- `src/studioAuthPlugin.ts`：`StudioPlugin` 实现，`start()` 建表 → 贡献 `/auth/*`、`/users*` 路由 → 贡献 authenticator；`stop()` 反向清理
- `src/authOptions.ts`：Better Auth 配置（表名/列名映射、`additionalFields`、username 插件、`autoSignIn: false`）
- `src/migrations.ts`：按 Better Auth 的 schema 生成 `studio_auth_*` 表 + 索引 + 审计表
- `src/repository.ts`：本插件表的行级访问（用户、会话、失败计数、审计）
- `src/capabilities.ts`：capability 白名单、默认最小集与解析
- `src/studioAuthPlugin.test.ts`：登录/登出/改密/锁定/过期/审计/生命周期用例
- `src/studioAuthHttp.test.ts`：与**真实** `studio-http` + 真实 hook registry 的集成用例

修改：

- `plugins/studio-http/src/studioHttpPlugin.ts`：`StudioHttpPrincipal` 增加 `capabilities`；`StudioHttpRoute` 增加 `capability`；中间件先 scope 再 capability；新增 `authenticators` hook 并在 `authenticate()` 里兜底调用（每个 verifier 单独 try/catch，异常按"不是我的凭证"处理）；`jsonResponse` 支持 `204` 无 body；导出 `HttpRequestError`，让贡献方把请求体错误透传成 `400`/`415`
- `plugins/channel/src/channelPlugin.ts`：注册路由时声明 `channel.read` / `channel.write`（两行，身份继承逻辑不变）
- `packages/studio/src/index.ts`：导出 `StudioPluginHookRegistry`，让嵌入方（和集成测试）能像 `createStudio` 一样接线
- `apps/studio-console/src/App.tsx`：连接弹窗增加「用户名 / 密码」表单，登录成功复用现有 `sessionStorage['studio.token']`，额外存 `studio.user` 用于展示；`401` 时重新弹出登录而非只显示错误 —— **本分支未做，留作下一步**（后端 `/auth/*` 已可用）
- `packages/studio/templates/default/studio.json`：示例中给出可选的 `@pinpawo-plugin/studio-auth` 条目（注释性文档放在 README，不默认开启）—— **本分支未做**，启用方式写在 `services/studio/README.md`
- `docs/reference/api/studio.md`：补 `/auth/*` 与 `/users*` 契约
- `docs/design/studio/http-plugin.md`：补 `authenticators` hook 与 capability 门

## 6. 兼容与迁移

- 插件默认不启用：未启用时没有 `/auth/*`，`authenticate()` 行为不变，现有测试应全绿；
- `pps_` key、JWT 客户与本机 token 的**响应与 principal 形状完全不变**：只有插件贡献的凭证才带 `capabilities` 字段，其余凭证继续按今天的兜底规则判定（`studio` 全权、`client` 只有 `channel.read` / `channel.write`）；
- 本机 token 保持全权，`pinpawo-studio clients` 等管理员流程不受影响；
- 建表是新增迁移，不改既有表；启用后首次启动自动建表；
- 回滚：从 `studio.json` 移除插件即可（三张 `studio_auth_*` 表保留，可手工 drop）；用户对应的 `studio_clients` 记录不会自动删除，可继续用 `clients` CLI 吊销；
- 首次启用且无用户时，`/auth/login` 返回 `401`，响应体提示「使用本机 token 创建第一个用户」。

## 7. 测试与验收

单元：

- 密码哈希/校验（正确、错误、格式损坏、用户名不存在时等时）；
- 会话：过期（绝对与空闲）、吊销、登出、改密撤销其他会话；
- 锁定：5 次失败锁定、窗口过期恢复、地址限速；
- capability 判定：缺 capability 返回 403，本机 token 恒通过。

单元与插件级（`plugins/studio-auth/src/studioAuthPlugin.test.ts`，内存 SQLite）：

1. 本机 token 建号 → `POST /auth/login` 拿 token → `GET /auth/me` 身份与 capabilities 正确；
2. 会话：绝对过期、空闲超时（并顺手删除死行）、登出、改密撤销其他会话；
3. 锁定：5 次失败锁定、窗口过期恢复、**并发失败不能绕过**（原子自增）；
4. 禁用账号：既有会话立即 `401`，再登录也是 `401`（与用户名不存在同一答案）；
5. 库里只有 token 的 SHA-256，拿哈希值当凭证无效；
6. 审计写入失败不影响请求；`X-Forwarded-For` 默认不采信，`trustProxy` 打开后才入库；
7. 启动失败会回滚干净并可重试。

集成（`plugins/studio-auth/src/studioAuthHttp.test.ts`，真实 `studio-http` + 真实 `StudioPluginHookRegistry`）：

1. `/auth/*`、`/users*` 在真实中间件下能注册成功（这条用例正是为了守住前者踩过的坑）；
2. 插件启动顺序无关（http 先起 / auth 先起都成立）；
3. 本机 token 的 `/me` 响应形状不变；会话 token 可访问内置路由；
4. `POST /dispatch` 无 `studio.dispatch` → `403`，授予后 → `202`；
5. `pps_` key 的可达范围与 `403` 文案与改造前一致；
6. 过期会话在 HTTP 层被 `401`；
7. 某个 verifier 抛异常时是 `401` 而不是 `500`；
8. 坏 JSON → `400`、错 `Content-Type` → `415`，`/users` 与 `/auth/*` 同一套答案。

Channel capability 门（`plugins/channel/src/channelCapabilityHttp.test.ts`，真实 `studio-http` + 真实 hook
registry，用一个只返回 capability 的校验器代替登录插件）：

1. 只有 `studio.view` 的会话 → `GET /channels` `403`（提示 `channel.read`）；
2. 有 `channel.read` 没有 `channel.write` → 读 `200`、建 Channel `403`；
3. 两项都授予 → 读 `200`、建 `201`；
4. `pps_` key 与未声明 capabilities 的凭证照旧可读可写；
5. 本机 token 仍全权。

回归：未启用插件时 `plugins/studio-http` 与 `tests/studio-e2e` 现有用例不变。

## 8. 与现有边界的关系

- **仍只监听 loopback**：登录不会改变网络暴露面，远程用户依旧走 SSH 隧道或同机反代；
- **`allowedOrigins` 仍是硬门槛**：Console 换端口要同步改配置；
- **client 仍无事件流**：会话用户默认只有轮询体验，`studio.events` 是可选项而非默认；
- **审计落本地 SQLite**：与 Channel 事实源同库不同表，HTTP 插件不读取审计表。

## 9. 风险与开放问题

- **不是 OS 级隔离**：capability 只约束 HTTP 面。用户拿到 `studio.dispatch` 后，Pet 仍以 Host 进程权限执行命令；多用户共享一台 Host 时应克制授予；
- **无 TLS 时的凭证暴露**：会话 token 走明文 HTTP，只在 loopback + SSH 隧道下安全；一旦经反代暴露必须终结 TLS（并且应同时切 HttpOnly cookie）；
- **Console 存 sessionStorage**：XSS 风险与今天相同，不因本设计改善或恶化；
- **锁定可被用于 DoS 单账号**：依赖地址限速兜底，必要时改成「指数退避 + 不锁账号只延迟」；
- **是否需要 workdir 级多租户**：当前单 workdir，本设计明确不做；
- **`user.` 前缀与 JWT issuer 命名空间**：需在 issuer 文档中声明保留，避免撞名；
- **审计保留期**：暂不清理，后续需要按天轮转或裁剪。

## 10. 实现状态

已在 `plugins/studio-auth` 落地（`feat/studio-auth` 分支）：

| 能力 | 状态 |
|---|---|
| Better Auth（email+password、username、`hashPassword`/`verifyPassword`）+ Kysely/SQLite | ✅ |
| 插件自签会话 token，库里只存 SHA-256；绝对过期 + 空闲超时；登出/禁用/改密即失效 | ✅ |
| `studio_auth_*` 表与迁移、审计表 | ✅ |
| `POST /auth/login`、`POST /auth/logout`、`GET /auth/me`、`POST /auth/password` | ✅ |
| 管理员 `GET/POST /users`、`POST /users/password`、`POST /users/capabilities`、`POST /users/disable` | ✅ |
| 用户 → `user.<username>` client 映射、client 吊销后拒绝 | ✅ |
| capability 最小集与 `studio-http` 的 capability 门（scope 优先，插件只能加要求） | ✅ |
| Channel 路由的 `channel.read` / `channel.write` 门（撤销后真的不可用） | ✅ |
| `/auth/*` 的 `400`（坏 JSON）/ `415`（错 `Content-Type`）契约，不折成 `500` | ✅ |
| `authenticators` hook（`authenticate()` 兜底调用，逐个别名 try/catch） | ✅ |
| 失败锁定（5 次 / 15 分钟，原子计数）与审计脱敏 | ✅ |
| 未启用时行为不变（`studio-http` 19/19、`studio-e2e` 36/36 全绿） | ✅ |
| Console 登录表单 | ⬜ 未做，留作下一步 |
| 按来源地址限速 | ⬜ 未做（当前靠按用户名锁定） |
| `docs/reference/api/studio.md` 的 `/auth/*` 契约 | ✅ 已补 |

验收方式：`npm test -w @pinpawo-plugin/studio-auth`（22 个用例）、
`npm test -w @pinpawo-plugin/studio-http`（19 个用例）、
`npm test -w @pinpawo-plugin/channel`（74 通过 / 1 跳过，跳过项需要 `PINPAWO_TEST_POSTGRES_URL`）、
`npm test -w @pinpawo-tests/studio-e2e`（36 个用例），以及根 `npm run build`、`npm run typecheck`。
