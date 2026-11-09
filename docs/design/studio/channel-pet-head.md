# Channel 内的轻量 Pet Head

> 状态：正常交互链路已实现，仍在自测；异常退出回流及更强恢复保证未实现。
> 更新：2026-11-09

实现依赖[消费基础](channel-timeline-consumption.md)，对应 [#1078](https://github.com/pinpawo/pinpawo-agent/issues/1078)
和[目标设计草稿](https://github.com/pinpawo/pinpawo-agent/pull/1077)。
**Channel 消费公开消息，Host 消费执行任务。**

## 当前路径

- Timeline 立即保存各原始消息，不合并改写作者、引用、附件或顺序。
- `routing.enabled` 现在启用各 Pet 独立的 Head，不再在运行路径调用中央 Router。
  复用 Host 启动时已加载的 `PET.md` 快照，既有 `routing.pets` 可补充简短职责；不维护第二份身份配置。
- Head 每次只决定自己：`skip`、直接 `reply`，或 `dispatch`；后者可附一条先行回应。
  多个 Pet 可以都回应或执行，也可以全部跳过。
- 直接回应在 Channel 内以原 Pet 身份落库，不分配或创建 session，不调用 Host/pet-agent。
  真正执行仍走既有 `dispatchPet`、Channel–Pet session、Host 准入与审批边界。
- 显式 @ 维持现有即时交付行为，跳过自动相关性判断。本次没有改变 @ 的 cooldown 或中断语义。
  这些记录仍可作为公开背景，但消费者不重新交付它们。

`channelPetHead.ts` 复用 Studio 的模型工厂，只做一次结构化调用，无工具循环、SDK 重试或 schema 修复重试。
每 Pet 调用默认 10 秒，范围沿用配置的 100–120000 ms；信号超时也会终止不配合取消的注入决策器的等待。
请求的系统指令、来源和目标 Pet 均由 Channel 确定；模型不能指定其他目标或修改原消息作者。

## 公开输入与来源

Head 使用 Pet 名称、Host 已加载的 `PET.md`、可选简短职责、Channel 公告、适用的新消息、
有界公开前文和本批背景。`PET.md` 包含身份、职责和操作规则，不是单纯职责摘要，也不是 Capability 清单。
Studio 的 `getPetDocument(petId)` 只返回冻结的 `{ content }`，不重新读取文件、不暴露路径；
它和执行 Pet 复用同一启动内容。启动后修改 `PET.md` 需要重启 Host；新建的同定义 Pet 也使用此快照。
模型最多收到前 8000 个字符，截断时为 `pet.document.truncated: true`，缺失时为 `{ missing: true }`；
这些情况不代表不存在其他规则，也不改变执行权限。

输入的 `currentTime` 及每条公开消息的 `occurredAt` 由服务器提供；时间经过不证明任务进展。
触发、历史和本批背景的引用都保留 `messageId`，可读取时附原作者、时间、来源和有界正文，
取不到原文时保留 `{ messageId, missing: true }`，不把它当作没有引用。引用只展开一层；
历史旧记录缺少服务端来源时显式使用 `unknown`，不从正文推断来源。公开成员标签只用于称呼。

执行观察仅提供 Channel 由生命周期事件确认的 `running`，否则为 `unknown`，并不代表空闲。
`execution.runs` 包含已观察到的开始时间及 Channel 自己派发的公开请求 `messageId`/`occurredAt`；
不包含请求正文、Host 队列、私人 session、计划或工具输出。每次最多保留最近 10 个运行、
每个运行最多 200 个公开请求引用，省略时有标记。关联在 Channel 进程中保存，重启后不回读私人状态。
运行退出或等待审批后，不把 Head 的观察升级成失败、完成或可恢复审批的事实。

模型输入整体不超过 96000 个 JSON 字符。正文、公告、成员标签、引用和附件元数据都受限，
截断有标记；公开历史和本批背景先选最近 20 条，再分别分配 8000 字符正文预算，
避免被最终丢掉的旧消息挤占保留消息的预算。超限时先去掉最早背景，再均匀缩短触发消息的摘要，但不删除任何触发消息。
若仅保留身份和最短摘要仍超限，报错并保留进度，需降低 batchLimit；模型不可宣称已经检查省略材料。执行 envelope 仍保留完整适用消息及原始附件，不使用截断后的模型视图。

新消息持久保存服务端确定的 `source`（`member | pet-agent | pet-head`）。客户端不能自设来源、作者或
`addressingError`。非法 Pet @ 继续保留为公开消息并报告错误，同时持久标记，不在重启后误变无 @ 触发。

- Pet 自己的新输出不触发自己的 Head，仍保留在 Timeline 和可读历史中。
- 所有 Head 回应都不唤醒其他 Head，也不触发失败批次重试；之后可作为人类新消息的背景。
- Head 回应不能 @ Pet；需要其他 Pet 执行的协作仍由原始公开请求及实际执行 Pet 的普通发言完成。
- 合法的新消息引用 Pet 先前发言时，保留理解指令所需的一层引用、作者、时间、来源和附件。

`channel_batch` 将每条消息的可信作者和原文分别传给执行 Pet；没有合成“人类作者”或模型生成的新任务。
`headReply` 指向已经落库的真实回应，避免执行 Pet 重复发表“我看看”。
`contextHint.focus` 是模型关注建议，不是原作者指令或新增授权；通过独立 invocation hint 传递。

## 启用、重启与失败

持久的 Head 启用标记区别首次切换与普通重启：

- 首次启用、或关闭后重新启用：在 Channel 行锁下将当前 Pet 的进度设到已提交末尾，避免重跑旧 Router
  已处理的消息或关闭期间的聊天。
- 已启用状态普通重启：保留未处理进度，继续消费。成员加入和重入从加入时的末尾开始。
- 同一进程中，失败尝试保留冻结范围；新消息可以唤醒一次重试，成功后继续读取范围之后的新消息。
  不自动连续重试。一个 Head 失败不阻塞其他 Pet。
- 回复前和派发前重新检查取消及成员代次；Host 准备 scoped context 时再次检查批次代次。
  已被 Host 接纳后的任务不因之后退群被本阶段自动撤销。

先行回应使用稳定的公开消息引用，重试复用真正已经保存的文本。dispatch 使用稳定的现有 Host 幂等 key。
这不构成跨崩溃 exactly-once：Host 幂等记录在内存，冻结尝试也只在本进程保留。
效果产生后、cursor 提交前崩溃可能重复执行；Host 接纳后的 session 确认失败也可能产生不确定结果。
进度写入失败不能推翻已经收到的 Host 接纳事实。

持 Host token 的 Console 区分所观察到的 Head 处理失败、消息保存失败和执行失败；进度保留的失败不伪装为普通 skip。
客户 key 的 Console 只轮询公开 Timeline，未新增持久 Head 失败查询。
这些观察事件并非持久故障队列。完成、取消、等待审批、失败的关联退出说明及故障窗口验收仍属后续阶段，
本阶段不替 Head 自动重跑工作或恢复审批。

## 验证入口

- Channel 插件单测：模型 schema/边界、PET.md 缺失/截断、消息与一层引用时间/来源、最近历史预算、运行的公开请求关联、启用切换、无 session 回应、多 Pet、引用附件、重入与局部失败。
- Studio Core/Host 单测：只读 content 快照、定义与实例映射、同定义后建实例、启动后修改隔离及重启刷新。
- Studio E2E：单独 hint、实际 Channel 上下文读取、边界输入和原生中断延续。
- `npm run eval:channel-pet-head -w @pinpawo-tests/agent-evals`：显式指定 `HEAD_EVAL_MODEL_PROFILE_ID` 才调用真实模型。
  自动检查动作和结构；事实依据、收口及私人进度编造需要按逐例 rubric 人工复核，不能把结构通过当语义通过。
