# Studio 配置

[English](../../studio/configuration.md)

一个 workdir 的配置位于 `.pinpawo/studio.json`，Pet 文件位于
`.pinpawo/pets/<petId>.json`，每个 Pet 的 Capability 目录约定为
`.pinpawo/pets/<petId>/capabilities/<name>/CAPABILITY.md`。Pet 还可以在
`.pinpawo/pets/<petId>/PET.md` 中定义跨 Capability 保持一致的工作方式。

```json
{
  "studioId": "content-studio",
  "entryPetId": "planner",
  "pets": ["planner", "writer"],
  "plugins": [
    { "id": "@pinpawo-plugin/studio-http", "options": { "port": 3211 } },
    { "id": "@pinpawo-plugin/channel" }
  ]
}
```

Pet 配置至少包含 `petId` 和 `name`，可选 `modelProfileId` 与
`defaultCapabilityName`。后者只在 Supervisor 的紧凑路由清单中标记
该 Pet 目录中已存在的一项默认候选；完整文档仍与其他 Capability 一样通过搜索披露，
且不绕过可用性与 Toolkit 绑定。配置不包含
`lazy`、`disabled`、Capability 名单、thread 或
continuation。所有配置 Pet 都在 Host ready 前 eager 构造；任意一个失败都会整体回滚。

旧 `personality`、`species`、`stage` 字段会报错，并提示将其内容迁移到 `PET.md`。
`serverBinding` 也已移除，因为当前没有云端 Pet 同步消费方。默认 Pet Profile Toolkit
及云端 memory/history 注入接口已删除；会话历史仍由 session checkpoint 管理。
原 `role` 与 `serviceSummary` 字段已移除——从未有消费方读取它们。

`PET.md` 是这个 Pet 的根文档，定位与 agent 使用的 `AGENTS.md` 或 `CLAUDE.md`
一致。它定义 Pet 的身份、职责、工作原则、边界和长期约定，并完整应用于该 Pet 的直接
Chat 回复、Run Supervisor、Capability 执行和最终 Answer。可执行职责与 Toolkit 依赖
仍属于 `CAPABILITY.md`，机器配置属于 Pet JSON，项目自身的开发规则属于 `AGENTS.md`。
Studio 按 Pet 从 `.pinpawo/pets/<petId>/PET.md` 定位该文档；普通的单 Pet Chat Host
则从 `<workdir>/PET.md` 定位同一个文档契约。agent 接收的是 `PetDocument`，不解释这两种
文件系统约定。
Studio Host 启动时读取一次 `PET.md`，修改后需要重启 Host 才会生效。该文档作为模型的
根上下文载入；实际工具与 Capability 仍由编译后的 registry 提供，框架生命周期与安全
契约保持权威。

standalone CLI 把 Plugin id 作为已安装 package 名交给 `StudioPluginResolver`，package
通过 `createStudioPlugin()` 创建 Plugin。Studio core 不扫描或静态 import 具体 Plugin；
嵌入方仍可替换 resolver。每个已配置 package 必须和 `@pinpawo/studio` 一起预先安装，
启动过程不会联网下载。Plugin 可以定义 Toolkit，但 Capability 属于 Agent，并只从每个
Pet 的约定目录加载。

Studio 只登记 Pet 的公开名称、角色、服务摘要和 `PetDispatchPort`。Agent 私有字段、
Capability inventory、Agent Session 与 checkpoint 都不进入 Studio 注册表。

## 旧 Kanban 工作区迁移

Kanban Plugin、API、工具和默认任务分配／任务完成后 Wiki 自动更新规则已退役。
新模板启用现有 Channel；Planner 返回计划，Executor/Reviewer 返回结果与证据，
Wiki 由明确请求更新。通用 Trigger、Knowledge 和直接 Pet 请求继续可用。

启动和 `init` 不会自动改写旧配置。手动移除 `studio.json` 中的旧 Kanban Plugin、
`dispatch-assigned-kanban-task` 与 `wiki-on-task-done`，安装并启用 Channel；对照新模板
更新各 Pet 文档，移除所有 `kanban*` Toolkit 调用及只写任务状态的 `studio_reporting`
能力，保留项目自己的约定。完整步骤见[迁移指引](../../studio/configuration.md#retired-kanban-workdirs)。

历史 `.pinpawo/kanban/`、JSON 快照、任务历史、Wiki 和其他用户数据原样保留；
不清理 schema、不自动迁移、不提供空壳插件。调用结束不等于目标验收完成，不触发 Wiki。
