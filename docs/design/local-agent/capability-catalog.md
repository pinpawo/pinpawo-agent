# Chat Capability Catalog（草案）

> 状态：实施中（#685）
> 范围：Chat Host 的全局用户 Capability；不适用于 Studio per-Pet Capability。

## 边界

Chat Host 从默认目录、`PINPAWO_CAPABILITY_DIRS` 和持久化的
`capability_dirs` 解析全局用户来源。三个来源分别代表默认、进程级临时覆盖和
持久化扩展，保留其语义，但由同一个 resolver 做路径规范化和去重。

Studio 不消费该 catalog。它继续只从
`<workdir>/.pinpawo/pets/<petId>/capabilities/` 严格加载每个 Pet 的定义。

## 快照与开关

Host 启动和显式 rescan 产生用户 Capability 运行时快照，server runtime 以
copy-on-write 的不可变 deps projection 发布它。HTTP `/capabilities` 只投影这个
快照，不重新读取磁盘；这样 UI 中展示的 metadata 和 Chat 实际可执行的 definition
属于同一 generation。

Capability 的有效启用状态由一个配置快照决定：显式的
`config.capabilities[id]` 覆盖 `CAPABILITY.md` 的 `defaultEnabled`。Chat 组装和
HTTP 投影必须复用该解析规则。

## 运行时组装

Host 提供的 baseline 与可选内建 Capability、用户快照以及请求/线程范围的 Toolkit
在请求期编译为 registry。请求范围组件（如 pet profile、artifact discovery）不进入
全局 catalog；静态 Capability 定义也不得在请求期重新扫描或重新创建。

内建 Capability 名称与 `general` 是 host 保留名。用户 loader 在加载时拒绝冲突，
而不是依赖下游静默去重决定优先级。
