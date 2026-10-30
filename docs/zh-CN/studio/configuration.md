# Studio 配置

[English](../../studio/configuration.md)

一个 workdir 的配置位于 `.pinpawo/studio.json`，Pet 文件位于
`.pinpawo/pets/<petId>.json`，每个 Pet 的 Capability 目录约定为
`.pinpawo/pets/<petId>/capabilities/<name>/CAPABILITY.md`。Pet 还可以在
`.pinpawo/pets/<petId>/PET.md` 中定义跨 Capability 保持一致的工作方式。

```json
{
  "studioId": "content-studio",
  "entryPetId": "writer",
  "pets": ["writer", "reviewer"],
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
嵌入方仍可替换 resolver。安装完整入口 `@pinpawo/studio` 会自动安装六个基础 Plugin；
其他配置的 Plugin 仍需预先安装。核心包为 `@pinpawo/studio-core`，启动过程不会联网下载。Plugin 可以提供 Toolkit 和共享 Capability 定义，由 Host 与每个 Pet 目录中的专用能力
合并装配。执行和工具绑定仍由 Agent 负责，Studio 不注册或执行 Capability。
Pet 本地同名定义优先；不同 Plugin 的同名能力及替换 Host general 的定义会在启动时失败。

`storage` 决定 Plugin 数据放在哪里，省略时是 workdir 下的 `.pinpawo/studio/studio.sqlite`。
改用 Postgres 时写 `{ "kind": "postgres", "urlEnv": "PINPAWO_STUDIO_DATABASE_URL" }`（连接串放在环境变量里）
或 `{ "kind": "postgres", "url": "postgres://…" }`。每个 Plugin 在这个库里有自己的表和迁移历史，
详见 [Studio 存储](../../design/studio/storage.md)。

Studio 只登记 Pet 的稳定 id、公开名称和 `PetDispatchPort`。Agent 私有字段、
Capability inventory、Agent Session 与 checkpoint 都不进入 Studio 注册表。

当前 Channel 寻址、Reply 默认与可信来源见[统一设计入口](../../design/studio/channel-addressing-and-execution.md)。
Channel Plugin 自动向本 Channel 的可信运行注入公共说明、标题/介绍和可选公告，
并提供一份共享 channel_context Capability，按需独立分析消息后把总结返回主 Pet。
PET.md 只定义自身职责和边界，团队分工由公告说明。公告只允许 Studio authority 编辑，
修改影响后续运行，不改变正在执行或待审批运行的快照，也不追加到对话消息历史。
既有工作区需保留定制后手动清理旧的 channel_context 副本和重复公共规则；本地同名
副本仍会优先于共享能力。Pet 或 Capability 文件编辑后重启生效。

人类发的、没有 @ 任何人的 Channel 消息只保存，不唤醒 Pet。把 Channel Plugin 的 `options.routing.enabled`
设为 `true` 后，会用一次模型调用为这类消息选一个 Pet 或不选（`decider: {kind:'llm', modelProfileId}`，
引用 Host 的模型配置）。见 [Channel 路由](../../design/studio/channel-routing.md)。

## 旧 Kanban 工作区迁移

Kanban Plugin、API、工具和默认任务分配／任务完成后 Wiki 自动更新规则已退役。
新模板启用现有 Channel，不再包含 Planner；Executor/Reviewer 返回结果与证据，
Wiki 由明确请求更新。通用 Trigger、Knowledge 和直接 Pet 请求继续可用。

启动和 `init` 不自动改写既有文件。完整步骤只维护在
[迁移指引](../../studio/configuration.md#retired-kanban-workdirs)，按该指引更新配置与能力，
保留项目约定、历史 `.pinpawo/kanban/`、快照、任务历史、Wiki 和其他用户数据。
调用结束不等于目标验收，不自动触发 Wiki。
