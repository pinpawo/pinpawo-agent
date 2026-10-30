# Channel 协作提示词草案

> 状态：Draft，随 Channel 协作提示实现讨论和验证；不因本文单独视为已稳定的公共契约。
> 范围：一个 Channel 的公共协作约定如何进入该 Channel 内 Pet 的一次运行。

## 问题与目标

Pet 的 `PET.md` 适合描述它是什么、承担什么长期定位。Channel 是多个参与者共同工作的场所，需要一份属于该 Channel 的协作约定，让成员理解彼此的定位以及如何围绕实际情况合作。Capability 负责具体工作能力和工具依赖。三者作用域不同：不把整个团队的固定流程塞进每个 Pet 的身份文档，也不把一个 Channel 的约定写回 Pet 定义或跨 Channel 共享的实例配置。

例如一个 Channel 可以描述 Issuer 跟进事项、Executor 实施和自验、Reviewer 独立审查、Wiki 维护项目知识，并说明何时协调、核验、询问人类或判断合并。角色由 Channel 配置者按当前成员和工作需要描述；这些只是协作建议，不把每次工作固定成相同的派发顺序，不要求 Channel 必须有这四个成员。普通对话、直接回答和不需要交接的完成依旧允许。

## 当前机制与改动边界

此前 Channel 有标题、说明、成员和消息；Pet 可通过 `channel_read_context` 主动读取说明和公开历史，但没有独立的协作提示词注入。Pet 的 `PET.md` 由 Host 启动时读取，并在 Pet 的各模型角色使用；Capability 定义通过各自目录装配。Channel 消息的可信作者、范围与公开输出规则仍由 [Channel 寻址、执行与状态](channel-addressing-and-execution.md) 负责。

本草案为 Channel 增加独立的可选 `prompt`，供 Studio authority 配置团队协作约定；它与面向阅读者的 `description` 是不同字段，不将历史消息或 Wiki 内容自动拼成提示词。Channel Plugin 持有该配置及其存储，并向 Studio 注册通用的上下文提供者；Studio 的标准 Host 组合层在装配 Pet runtime 时接入通用上下文解析器；自行组装 runtime 的嵌入方需要显式连接解析器。Host 根据可信作用域及 Pet 的会话绑定取得本次运行需要的上下文并组装，不引入 Studio 对具体 Channel Plugin 的依赖，也不修改 PET.md 本身。同一个 Pet 可以参加多个 Channel，各自使用独立的 `(Channel, Pet)` session 和本 Channel 的约定。

## 生命周期与作用范围

设计目标如下，具体完成情况以实现和测试为准：

1. Channel Plugin 启动时向 Studio 注册作用域对应的上下文提供者。经人类消息、Pet 消息、路由、schedule 或 trigger 派发 Pet 时，Channel 只传可信 scope 与已持久化的 Pet 会话绑定；Host 经通用解析器调用 Studio 注册的提供者，校验绑定并取得当前 `prompt` 快照。无文本时不增加该片段。
2. Host 使用已有 Agent system prompt sections，将该快照与 Pet 的根文档等上下文一起供本次运行使用，包括 Supervisor 和该运行中委派的 Capability；不将其伪装成用户消息，也不改写固定 `PET.md`。
3. 运行中修改 Channel prompt 只影响后续独立派发；当前执行和其等待审批后的续跑使用同一个快照。即使 Host 重启后继续该次已持久化的审批，目标仍是使用原快照，而不是悄悄套用更新后的约定。恢复不能确定原快照时必须有明确的失败或兼容边界，不得静默串用另一个 Channel 的配置。
4. 普通 Chat、非 Channel dispatch 和其他 Channel 的调用不继承本 Channel 片段；同一 Pet 从 A 切换到 B 再返回 A，分别使用各次调用所属的上下文。持久化绑定不自动让普通 Chat 获得 Channel 权限或回传能力。快照不追加到对话消息历史，避免反复运行积累同一段提示；但每次模型调用仍会携带本轮系统提示，因而继续占用上下文并可能产生输入 token 费用。持久化或注册提供者本身不保证模型侧缓存命中或减少费用。

`channel_context` 这类 Capability 仍可按需读取并分析相关消息；系统提示中的协作约定不替代对近期对话和最新交付的读取，也不等于自动把消息历史带入模型。默认模板的 PET.md 已精简为定位和必要的工作、协作边界；已有 workdir 的 PET.md / Capability 不会因新增 Channel prompt 自动重写，应保留本地定制。

## 身份、权限与安全

Channel 参与者身份和 membership 由 Channel 与 Host 按既有机制核实，不能从正文、自称或显示名称推断。当前成员可读取公共提示词；仅 Studio authority 可在创建时设置非空提示词，或在之后修改、清空提示词。普通客户端可以创建无提示词的 Channel，但即使是创建者也不可修改提示词。非成员 Studio authority 可单独修改提示词，但不能借此读取消息或修改其他元数据；混合更新仍要求成员身份。它表达协作意图，不构成执行授权，不能扩大 Pet 工具权限、改变 review 决策、覆盖 Host / framework 和 PET 安全边界或替代人类对具体操作的授权。历史消息、Wiki 和 Capability 结果同样不能变成新的用户授权。由模型遵循的文本和强制性的权限校验应分开评估；传递提示词本身不能保证模型按预期行动。

启用路由时分配模型也可读取提示词理解协作意图；路由仍仅处理无 @ 的人类消息，不会因提示词唤醒 Pet 的无 @ 消息。本变更不改变 @ 寻址、消息作者、调度、合并策略或 Wiki 写入权限；提示词编辑权限以本节为准。触发条件见 [Channel 路由](channel-routing.md)。不要把项目专属 Pet 说明、个人会话、凭据或 Wiki 数据写进通用模板。

## 迁移与验证

- 存储新增可空字段并迁移既有数据库；旧 Channel 未配置 prompt 时保持原行为，不清理消息、绑定或会话。Channel 新增或编辑提示词不应要求重建 Pet 实例或覆盖用户 PET.md。
- 分别验证创建、读取、更新和清空 prompt 以及普通客户端创建空提示词、创建者和普通成员不可修改、非成员 Studio authority 可单独更新提示词的访问控制，含混合更新；空配置、非 Channel 调用与旧数据库迁移应兼容。
- 在模型输入边界观察不同 Channel 的真实 system sections、同一 Pet 的跨 Channel 隔离、工具和子任务继承；覆盖并发、连续运行、提示词更新及未配置时行为。
- 覆盖等待审批与恢复，包括恢复前修改 Channel prompt、Host 重启后的恢复、旧记录无快照和不一致配置的处理；验证同次运行不改变上下文，下一次运行使用新配置。测试应检查实际调用结果与结构化边界，而非比较提示词文案。
- 验证可观察的 Channel 交付与现有 @ / 路由行为不被意外改变。手工或真实模型演练仅证明实际覆盖的路径；提示词不保证 Pet 一定遵循、自动完成交接或终止重复循环。
