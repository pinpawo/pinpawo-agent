# Studio 存储

> **状态：已实现（Studio 核心、客户身份、Channel、Scheduler、Trigger、Notice）。** 所有 Studio Plugin 的数据都在 Studio 数据库里，
> 不再有各自的 SQLite 文件。代码：[`packages/studio/src/storage/studioStorage.ts`](../../../packages/studio/src/storage/studioStorage.ts)，
> Channel 的实现：[`plugins/channel/src/store/`](../../../plugins/channel/src/store/)。

## 目标

- Plugin 的数据可以放在 SQLite 或 Postgres，换库不改 Plugin 代码。
- 所有 Plugin 用同一种方式建表和迁移。
- Studio 自己仍不存业务数据；它只打开数据库、跑各 Plugin 的迁移、在关闭时收尾。

范围只到 Studio 和它的 Plugin。Pet 的 checkpoint、会话登记和 Chat Host 不在这里。

## 选型：Kysely

[Kysely](https://kysely.dev) 是一个类型化的 SQL 查询构建器，不是 ORM。

- 同一份查询代码在 SQLite 和 Postgres 上都能跑；方言差异由它处理。
- 自带 Migrator，迁移表名可以按 Plugin 配置，所以每个 Plugin 的版本历史互相独立。
- 纯 TypeScript，没有代码生成，也没有原生依赖。SQLite 直接用 Node 内置的 `node:sqlite`，
  通过一个很小的适配器接进 Kysely；Postgres 用 `pg`，只在配置为 Postgres 时才加载。

没有选的方案：Drizzle 的 schema 按方言分别声明（`sqliteTable` / `pgTable`），两种库要维护两份
schema 和两套迁移，而且没有 `node:sqlite` 驱动；Prisma 要求所有表写在一个 schema 文件里并需要
代码生成，和"每个 Plugin 自带自己的表"不合。

## 配置

`studio.json` 的 `storage` 字段，省略时是 SQLite：

```json
{ "storage": { "kind": "sqlite", "path": ".pinpawo/studio/studio.sqlite" } }
{ "storage": { "kind": "postgres", "urlEnv": "PINPAWO_STUDIO_DATABASE_URL" } }
{ "storage": { "kind": "postgres", "url": "postgres://user@host/studio" } }
```

- SQLite 的 `path` 相对 workdir，默认 `.pinpawo/studio/studio.sqlite`，文件权限 0600，
  WAL、`synchronous=FULL`、`busy_timeout=5000`、`trusted_schema=OFF`、外键开启。
- Postgres 用 `url`，或用 `urlEnv` 指定放连接串的环境变量，免得把密码写进配置文件。
- 嵌入方可以给 `createStudio({ storage })` 传 `{ kind: 'postgres', pool }`，用自己配置好的连接池。
  不传时是内存 SQLite，Studio 关闭即丢。

一个 Studio 一个数据库。

## Plugin 怎么用

`StudioPluginContext.storage`：

```ts
storage: {
  dialect: 'sqlite' | 'postgres';
  open<DB>(migrations: Record<string, Migration>): Promise<Kysely<DB>>;
}
```

Plugin 在 `start` 里调用 `open`。Studio 按名字顺序跑这个 Plugin 还没跑过的迁移，然后返回共享的
Kysely 实例。迁移历史记在 `<pluginName>_migrations` 表里（名字里非字母数字的字符换成 `_`），
锁表是 `<pluginName>_migrations_lock`。多个 Studio 同时启动时，迁移由锁保证只跑一次。

约定：

- **表名以 Plugin 名开头**（Channel 的是 `channels`、`channel_*`）。Plugin 只碰自己的表，不建跨
  Plugin 的外键；Plugin 之间仍然只通过 hook 和事件交流。
- **迁移只做前进**，没有降级。一次迁移失败，`open` 抛错并写明是哪个 Plugin；下次启动重试没跑完的迁移。
- **方言差异放在迁移里。** 目前只有自增主键这一处：SQLite 用 `integer primary key autoincrement`，
  Postgres 用 `serial`。Plugin 用 `storage.dialect` 生成对应的迁移。
- **不兼容旧数据。** 迁入的 Plugin 从 `0001` 开始，不读取它以前的数据库文件。

## 存储接口和服务

可替换的边界是每个领域自己的 Store 接口，不是 Kysely：

- Store 接口只有数据操作，全部是异步的，不做权限判断，读的时候不写，不存配置。事务写成
  `transaction(work: (store) => Promise<T>)`，`work` 拿到的是绑定在这个事务上的 store。
- 规则、权限和事件在上层的服务里（例如 `ChannelService`）。服务只依赖 Store 接口。
- 默认实现用 Kysely 写一份，两种数据库都能用。需要别的后端时，实现同一个 Store 接口即可，
  Plugin 通过选项注入（Channel 的 `createChannelPlugin({ store })`）。

目录约定（以 Channel 为例）：

```
src/store/
  channelStore.ts       Store 接口和行类型
  kysely/
    schema.ts           表的类型（Kysely 的 Database 类型）
    migrations.ts       迁移，按方言生成
    store.ts            Store 接口的 Kysely 实现
    index.ts
```

### 并发

- SQLite：一个 Studio 进程只有一个连接，Kysely 在连接上排队，事务串行执行。
  所以**事务里只能用 `work` 拿到的 store**：在事务里调用别的 store、别的 Plugin 或任何会查库的回调
  （例如 Channel 查客户的 label），这个查询要排在事务后面，事务又在等它，就永远等下去。
  需要别处的数据时，在开事务之前读好（Channel 的 `humanLabels`）。Postgres 不会卡住，但同样的写法
  会多占一个连接，也不在同一个事务里。
- Postgres：默认的读已提交隔离级别。会被并发写到的唯一键用 `INSERT … ON CONFLICT` 处理
  （Channel 的会话预留和带 `external_ref` 的幂等消息），不靠"先查后写"。

## 测试

存储相关的测试同时跑 SQLite 和 Postgres。Postgres 用 [PGlite](https://pglite.dev)（进程内的
Postgres，devDependency），不需要数据库服务；`tests/support/pglitePool.ts` 把它包成 Kysely 需要的
连接池接口。

## 后续

1. Scheduler、Trigger、Notice 已迁入（各自的 `src/store/`），它们自己的 SQLite 文件和逐列 `ALTER TABLE` 都已删掉。
2. Studio 客户身份已建在这里：所有者是 `studio`（迁移表 `studio_migrations`），表 `studio_clients`、`studio_client_keys`。
   Pet 实例（[Pet 实例](pet-instance.md)）用同一份迁移历史，表 `studio_pets`。
   `studio` 因此是保留的 Plugin 名。
