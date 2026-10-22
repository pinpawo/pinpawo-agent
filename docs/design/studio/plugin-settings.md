# Studio Plugin 设置

> 状态：设计草案，未实现
> 更新：2026-10-22

## 问题

现在 Plugin 的配置只有 `studio.json` 里的 `plugins[].options`。它在启动时读一次，改了要重启，
Console 也看不到、改不了。像 [Channel Router](channel-router.md) 的开关、阈值、Pet 说明这类
需要运行中调整的值，没有地方放。

## 方案：Studio 核心提供统一的设置约定

由 Studio 提供一种通用的 Plugin 设置机制，而不是由每个 Plugin 各自建表、各自做 Console 页面。

- **Plugin 声明**：Plugin 导出 `settings`，包含一份 JSON Schema 和默认值。没有声明的 Plugin 不受影响。

  ```ts
  type StudioPluginSettingsDeclaration = {
    schema: JsonSchema;        // 只用 object / string / number / boolean / enum / array / 嵌套 object
    defaults: JsonObject;
  };
  ```

- **存储**：一张核心表，归存储 owner `studio`（和客户身份同一个 owner），走现有的 Studio 存储和迁移。

  ```sql
  CREATE TABLE studio_plugin_settings (
    plugin_name TEXT PRIMARY KEY,
    value       TEXT NOT NULL,   -- JSON，按 schema 校验后保存
    revision    INTEGER NOT NULL,
    updated_at  TEXT NOT NULL,
    updated_by  TEXT NOT NULL    -- clientId
  );
  ```

  一个 Plugin 一行，整份 JSON 存，不拆字段。`revision` 用于并发写：写入时带上读到的 revision，不一致返回 409。

- **读取**：`StudioPluginContext.settings`：

  ```ts
  settings: {
    get<T>(): T;                                     // 生效值 = defaults ← studio.json options ← 数据库
    subscribe(listener: (value: T) => void): () => void;
  };
  ```

  三层合并：Plugin 默认值，被 `studio.json` 的 `options` 覆盖，再被数据库里的值覆盖。
  `studio.json` 仍然是部署时的初始值，Console 保存后以数据库为准。
  Plugin 订阅变化，热更新，不需要重启。

- **HTTP**（`studio` 范围，即本机 token）：
  - `GET /plugins/settings`：列出声明了设置的 Plugin，以及各自的 schema、默认值、生效值和 revision。
  - `PUT /plugins/settings`：`{ pluginName, value, revision }`，按 schema 校验，保存后发布 `studio.plugin_settings.updated` 事件。

- **Console**：新增 Plugins 页，按 schema 自动生成表单：boolean 是开关，enum 是下拉，string/number 是输入框，
  object 是分组。不为单个 Plugin 写专门的页面。

## 规则

- **密钥不进数据库。** schema 里只放环境变量名（如 `apiKeyEnv`），不放 key 本身。schema 可以把字段标成
  `"x-pinpawo-secret-env": true`，Console 只显示"已设置/未设置"，不显示值。
- **只放运行时可调的值。** 需要重启才能生效的结构性配置（Plugin 列表、HTTP 端口、存储连接）仍然只在 `studio.json`。
- **校验失败不保存。** 数据库里的值在 Plugin 升级后不符合新 schema 时，这一份数据库值整份忽略，退回
  defaults ← options，并发布 `studio.plugin_settings.invalid` 事件。不做字段级迁移（与 [Studio 存储](storage.md) 的"不兼容旧数据"一致）。

## 为什么不让 router 自己建表

- 开关和阈值是配置，不是领域数据。[Studio 存储](storage.md) 约定 Store 接口"不存配置"。
- 每个 Plugin 自己建表，就要各自做 HTTP 路由和 Console 页面。统一机制只做一次，Scheduler、Trigger、Notice 以后也能用。

## 涉及的改动

| 位置 | 改动 |
|------|------|
| `packages/studio` | `StudioPlugin.settings` 声明、`context.settings`、`studio_plugin_settings` 表和迁移、合并与校验 |
| `plugins/studio-http` | `GET/PUT /plugins/settings` |
| `apps/studio-console` | Plugins 页，按 JSON Schema 生成表单 |
| 首个使用者 | `plugins/channel-router` |
