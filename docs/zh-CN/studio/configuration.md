# Studio 配置

[English](../../studio/configuration.md)

一个 workdir 的配置位于 `.pinpawo/studio.json`，Pet 文件位于
`.pinpawo/pets/<definitionId>.json`，每个 Pet 的 Capability 目录约定为
`.pinpawo/pets/<definitionId>/capabilities/<name>/CAPABILITY.md`。Pet 还可以在
`.pinpawo/pets/<definitionId>/PET.md` 中定义跨 Capability 保持一致的工作方式。

默认模板统一维护 Issuer、Executor、Reviewer 和 Wiki，并在 `definitions` 中加载这四份
定义。JSON 沿用 `pets/<definitionId>.json`，PET.md 和专用 Capability 放在相应定义目录中。
Issuer 的默认能力为 `studio_issue`，保留 files、shell、web、git、github 和 channel 工具。
Host 启动时加载定义不会自动新增实例；`init` 会为默认模板的每份定义创建一个初始实例。
给已有工作区补充定义后，显式执行 `pinpawo-studio pets create issuer --definition issuer --name Issuer`
创建实例，再将它加入目标 Channel。
已有工作区需保留定制后补充定义、合并 `definitions` 并重启 Host，不会因初始化自动升级，
也不会自动获得 Issue 写权限或创建定时巡检。

```json
{
  "studioId": "content-studio",
  "definitions": ["writer", "reviewer"],
  "plugins": [
    { "id": "@pinpawo-plugin/studio-http", "options": { "port": 3211 } },
    { "id": "@pinpawo-plugin/channel" }
  ]
}
```

Pet 配置至少包含 `definitionId` 和 `name`，可选 `modelProfileId`、
`defaultCapabilityName` 和 `sharedCapabilities`。默认候选必须来自该 Pet 的私有能力目录
或显式选中的共享定义；完整文档仍通过 Capability 搜索披露，不绕过工具绑定。
旧 `petId`、`capabilities` 字段不再使用。

共享 Capability 统一放在 `.pinpawo/capabilities/<目录>/CAPABILITY.md`，Pet JSON 按
文档 frontmatter 的 `name` 引用，例如：

```json
{
  "definitionId": "reviewer",
  "name": "Reviewer",
  "defaultCapabilityName": "studio_review",
  "sharedCapabilities": ["channel_context"]
}
```

省略或留空表示不加载共享能力；私有目录仍照常加载。Studio Host 通过现有
HostCapabilityCatalog 装配两类来源，缺失引用、同名冲突和覆盖 Host general 都明确失败。
共享目录有引用时严格加载验证一次，再按名称选择；没有引用时不扫描。自定义 petsDir
时，共享目录是其同级 capabilities/。这是 Studio 的装配配置，独立 Chat 沿用其 Host catalog。
定义及引用修改后重启 Host；Toolkits 仍由 CAPABILITY.md 的 uses 指定。

旧 `personality`、`species`、`stage` 字段会报错，并提示将其内容迁移到 `PET.md`。
`serverBinding` 也已移除，因为当前没有云端 Pet 同步消费方。默认 Pet Profile Toolkit
及云端 memory/history 注入接口已删除；会话历史仍由 session checkpoint 管理。
原 `role` 与 `serviceSummary` 字段已移除——从未有消费方读取它们。

`PET.md` 是这个 Pet 的根文档，定位与 agent 使用的 `AGENTS.md` 或 `CLAUDE.md`
一致。它定义 Pet 的身份、职责、工作原则、边界和长期约定，并完整应用于该 Pet 的直接
Chat 回复、Run Supervisor、Capability 执行和最终 Answer。可执行职责与 Toolkit 依赖
仍属于 `CAPABILITY.md`，机器配置属于 Pet JSON，项目自身的开发规则属于 `AGENTS.md`。
Studio 按 Pet 从 `.pinpawo/pets/<definitionId>/PET.md` 定位该文档；普通的单 Pet Chat Host
则从 `<workdir>/PET.md` 定位同一个文档契约。agent 接收的是 `PetDocument`，不解释这两种
文件系统约定。
Studio Host 启动时读取一次 `PET.md`，修改后需要重启 Host 才会生效。该文档作为模型的
根上下文载入；实际工具与 Capability 仍由编译后的 registry 提供，框架生命周期与安全
契约保持权威。

standalone CLI 把 Plugin id 作为已安装 package 名交给 `StudioPluginResolver`，package
通过 `createStudioPlugin()` 创建 Plugin。Studio core 不扫描或静态 import 具体 Plugin；
嵌入方仍可替换 resolver。安装完整入口 `@pinpawo/studio` 会自动安装六个基础 Plugin；
其他配置的 Plugin 仍需预先安装。核心包为 `@pinpawo/studio-core`，启动过程不会联网下载。
Plugin 提供 Toolkit 和作用域内上下文，不注册或自动添加 Capability；能力由 Host 显式
选择和装配，执行、工具绑定与审核继续由 Agent 负责。

`storage` 决定 Plugin 数据放在哪里，省略时是 workdir 下的 `.pinpawo/studio/studio.sqlite`。
改用 Postgres 时写 `{ "kind": "postgres", "urlEnv": "PINPAWO_STUDIO_DATABASE_URL" }`（连接串放在环境变量里）
或 `{ "kind": "postgres", "url": "postgres://…" }`。每个 Plugin 在这个库里有自己的表和迁移历史，
详见 [Studio 存储](../../design/studio/storage.md)。

Studio 只登记 Pet 的稳定 id、公开名称和 `PetDispatchPort`。Agent 私有字段、
Capability inventory、Agent Session 与 checkpoint 都不进入 Studio 注册表。

当前 Channel 寻址、Reply 默认与可信来源见[统一设计入口](../../design/studio/channel-addressing-and-execution.md)。
Channel Plugin 自动向本 Channel 的可信运行注入公共说明、标题/介绍和可选公告，
默认模板另外维护一份共享 channel_context Capability，由四个 Pet 的 JSON 分别显式引用，
按需独立分析消息后把总结返回主 Pet。
PET.md 只定义自身职责和边界，团队分工由公告说明。公告只允许 Studio authority 编辑，
修改影响后续运行，不改变正在执行或待审批运行的快照，也不追加到对话消息历史。
既有工作区不自动迁移。保留定制后集中共享定义，移除迁移 Pet 的同名私有副本并添加引用；
保留私有定义时则不添加同名共享引用。两者同时存在会报冲突。Pet 或 Capability 文件编辑后重启生效。

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
