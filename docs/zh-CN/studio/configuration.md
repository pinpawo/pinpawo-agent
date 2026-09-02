# Studio 配置

[English](../../studio/configuration.md)

一个 workdir 的配置位于 `.pinpawo/studio.json`，Pet 文件位于
`.pinpawo/pets/<petId>.json`，每个 Pet 的 Capability 目录约定为
`.pinpawo/pets/<petId>/capabilities/<name>/CAPABILITY.md`。

```json
{
  "studioId": "content-studio",
  "entryPetId": "planner",
  "pets": ["planner", "writer"],
  "plugins": [
    { "id": "@pinpawo-plugin/studio-http", "options": { "port": 3211 } },
    { "id": "@pinpawo-plugin/kanban" }
  ]
}
```

Pet 配置至少包含 `petId` 和 `name`，可选 `role`、`serviceSummary`、
`modelProfileId` 与 `defaultCapabilityName`。后者只在 Supervisor 的紧凑路由清单中标记
该 Pet 目录中已存在的一项默认候选；完整文档仍与其他 Capability 一样通过搜索披露，
且不绕过可用性与 Toolkit 绑定。配置不包含
`lazy`、`disabled`、Capability 名单、thread 或
continuation。所有配置 Pet 都在 Host ready 前 eager 构造；任意一个失败都会整体回滚。

standalone CLI 把 Plugin id 作为已安装 package 名交给 `StudioPluginResolver`，package
通过 `createStudioPlugin()` 创建 Plugin。Studio core 不扫描或静态 import 具体 Plugin；
嵌入方仍可替换 resolver。每个已配置 package 必须和 `@pinpawo/studio` 一起预先安装，
启动过程不会联网下载。Plugin 可以定义 Toolkit，但 Capability 属于 Agent，并只从每个
Pet 的约定目录加载。

Studio 只登记 Pet 的公开名称、角色、服务摘要和 `PetDispatchPort`。Agent 私有字段、
Capability inventory、Agent Session 与 checkpoint 都不进入 Studio 注册表。
