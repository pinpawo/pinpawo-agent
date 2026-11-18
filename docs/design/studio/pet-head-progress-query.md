# Pet Head：在 Channel 内查询工作进度

状态：设计草案，尚未实现。首期只回答明确的进度问题。回答不派活、不打断、不替人审核；没有主动播报、计时巡检、自动重试或补偿派发。不猜百分比、阶段或预计结束时间。

## 1. 现状与依赖

| 已在 `main` 的行为 | 首期边界 |
|---|---|
| [Studio dispatch](../../../packages/studio/src/createStudio.ts) 分配 `invocationId`，以同一个值作为 resident 的 `dispatchId`；resident 接纳才返回 receipt。来自 `studio` 的 `dispatch.accepted` 不带 Pet topic。 | receipt 不是运行句柄，也不代表完成。当前没有持久的「Head、来源消息、invocation」归属记录。 |
| #1095 已使 [resident 生命周期](../../../packages/studio/src/createStudio.ts) 从 `resident-pet` 按 Pet **实例** topic 发布。[EventBus](../../../packages/studio/src/studioEventBus.ts) 只保证单订阅者交付顺序，不回放离线事件。 | topic 是路由，不是归属。目前已合并的 Head 只订阅 Channel。首期依赖另行开发、尚未合入的精确订阅与接纳关联。 |
| [现有 Head Channel port](../../../plugins/channel/src/channelPlugin.ts) 提供 `readContext`、`reply`、`dispatch`。`readContext` 用 Pet 成员身份读最多 50 条上下文，并可按 `replyTo` 精确读同 Channel 的一条消息。 | Head 不直接读 Channel 表或整份 Agent Session。下文的精确交付查询是新增的**内部**读取，不是已有 API。 |

## 2. 入口、目标与任务引用

把进度作为 [Head 判断](../../../packages/studio/src/host/petHead.ts) 的独立分支。明确问既有工作才走此分支；单独提及 Pet 不触发。普通消息走原路径，原来沉默的仍沉默。若同时要求开始、修改或中断工作，先请对方拆开，不能顺带派发，也不能悄悄只答一半。Head 判断意图；代码依据下列证据选任务和组织答复，模型不能提供可信的任务 ID、状态或交付证据。

- **先确定唯一目标 Pet。** 认可本条消息中解析后的单一 Pet mention，或同 Channel 已提交的 `replyTo` 所指的 Pet 作者；都没有时，仅在当前 Channel 只有一只 Pet 时把问题交给它。多个目标或互相冲突时，不让多个 Head 分别派活或回答；没有可辨认的唯一目标时不抢答。名称、正文和模型猜测不替代已解析的身份。
- **有 `replyTo`：** 先查该消息是不是本 Head 已关联的原始来源。也可回复当前 Pet 的普通 Head 确认：核对同 Channel、作者和 `externalRef === head-reply:<该确认的 replyTo>`，只向上走一跳，并要求目标是已关联来源。先前状态答复指向上一次提问，不把它当作原始来源，不递归追溯。显式引用无效、不唯一或没有归属，不回落到别的活跃任务；请直接回复原任务消息。
- **无 `replyTo`：** 只在当前激活中恰有一项可证实仍在进行、没有未辨清候选且问题不指向别的任务时直接选它。多项或候选不全则请指定来源；没有确证则答无法确认。可引用成员原本看得见的来源消息，不显示内部 invocation、队列或 Session 信息。

所有读取以当前 Pet 成员权限限定于 owner Channel。即使同 Pet、同 Channel、同固定 Session，Trigger、Scheduler、手工派发和其他 Head 的工作也不能因此被认领。

## 3. 接纳关联和生命周期

**归属证据。** 在接纳前由内部接缝登记 Studio 分配的 ID，关联 `(petId, channelId, sourceMessageId) → invocationId`。只有同一 Pet、同一 ID 的 Studio receipt 才确认这项归属。提前事件只暂存到该分配 ID，拒绝则丢弃；幂等重放不新建或接管归属。Studio receipt 与 Channel 的 `confirmSession` 是两步：第二步失败不抹去已确认的接纳，也不重派。

**校验和归并。** 订阅 `{ source: 'resident-pet', topic: petId }`，并核对 `payload.petId`、`payload.scope = { namespace: 'channel', id: channelId }` 和已登记的 `payload.invocationId`；若提供 `sessionId` 且与已知绑定不符也丢弃。绝不用 `requestId`、topic 或正文认领。参见 [Studio 投影](../../../packages/studio/src/createStudio.ts)、[resident 事件类型](../../../services/host/src/host/contracts.ts)、[人工审核投影](../../../packages/agent-session/src/review.ts)与[续跑路径](../../../services/host/src/host/dispatchContinuation.ts)。

| 可信事实 | 状态/动作 |
|---|---|
| `dispatch.queued` / `dispatch.running` | 已排队 / 正在运行。迟到的 queued 不能覆盖 running 或 waiting。 |
| `dispatch.waiting` 且 `payload.pendingInterrupt.payload.kind === 'human_review'` | 等待人工审核；不公开审核详情或代操作。其他等待证据不足以声称是人工审核。续跑可以有新的 `requestId`，仍是同一 invocation；当前轮次在可验证的 waiting → running 时更新；已进入新轮次后，旧轮次的阶段通知不能覆盖它。 |
| `dispatch.completed` / `dispatch.failed` / `dispatch.interrupted` | 执行已完成 / 失败 / 已中断。可信终态不退回非终态，也不证明结果已写入 Channel。 |
| `dispatch.message`，且 `payload.message.type === 'message.completed'` | 保存该 invocation 的 Agent 消息 ID；不推进状态。 |
| 缺准确信息 | 现在无法确认；若仍有可信上次观察，注明状态和时间，不冒充当前状态。 |

同 resident 订阅串行归并；重复 `eventId` 或不含新证据的同阶段通知不刷新时间。不用墙钟重排先后，也不假定跨订阅者的 Timeline 写入和 resident 事件有相对顺序。只保留投影，不保留请求、回复、错误详情、审批内容或工具日志。

## 4. 有界状态、只读补证和重开

- 每个 Head 激活最多留 **32** 个待接纳/非终态关联，以及最近 **32** 个进入终态的关联；终态满时淘汰最早进入终态的一项。每项只留必要标识、当前阶段与观察时间、轮次和最近 32 个事件 ID、最近 8 个输出引用。接纳前最多暂存最近 16 条投影；缓冲发生淘汰时，接纳后的非终态不能仅靠剩余缓冲视为当前证据。以上是内部初值，不新增配置。
- 活跃容量满时照常接纳基础派发，不驱逐已知活跃关联；只要有一项接纳但无法追踪，本次激活标记为候选不全，无引用问句不隐式选任务。已有可信引用仍可查询。淘汰、缺记录和查询失败都不代表任务不存在。
- 只在收到问题时补证。非终态最后证据超过 **30 秒**、缺阶段或有已知缺口时，对已知关联至多读取一次 [现有 `listDispatchQueues()` 快照](../../reference/api/studio.md#global-dispatch-observation)。只使用 Pet、`scope`（Channel）、`origin`（来源消息）、`dispatchId` 全匹配且 Session 不冲突的项。有精确 `activeDispatch` 且 `activeOperation === 'dispatch'` 可证实正在运行；精确 `entries` 可证实排队。全局 `waiting/blocked` 不证明该项正在等人工；无匹配、读失败或证据冲突答未知，不据此推断终态。读期间若有新可信事件，按新证据判断，不反复读取。快照只用于当次核对，不能创立归属，不把全局快照给模型。
- 关闭或替换即退订并丢弃状态与未发布答复。重开/重启不回放，也不从队列、Session 或 Timeline 逆推旧任务归属。对旧激活中来源的查询明确答无法确认，即使找到相似队列项。新激活重新接纳的工作才可形成新的归属；重放旧 receipt 不算新的接纳。不单建历史库或恢复协议。

## 5. 交付证明和防止回复再次派发

**核对交付。** [Channel 的 resident 回复路径](../../../plugins/channel/src/channelPlugin.ts) 校验 scope 与 Session 后，以 Agent 消息 ID 作为 `externalRef` 写入 Timeline。现有 [Store](../../../plugins/channel/src/store/kysely/store.ts) 只在重复写入时按唯一键 `author_kind + author_id + external_ref` 查旧行，不提供独立查询；该键不含 Channel。首期新增一个 Channel 所有的内部只读操作（例如 `findCommittedPetOutput(channelId, petId, agentMessageId)`）：验证当前成员权限与 owner，同时限定 `channel_id`、Pet 作者和准确 `external_ref`，只查已提交行，仅返回对应 Timeline `messageId` 或无结果。不加新表、公共 HTTP 或额外写入路径。输入必须来自该 invocation 的可信 Agent 消息引用，排除 `head-reply:` 保留前缀。同作者的其他消息、相似文本、时间相邻和队列缺项都不是交付证明；写入延迟、失败或读不到时只说未确认，不能断言未写。失败/中断不会因较早的输出而变成成功交付。

**正常回复，不 fan-out。** 复用 [Head reply](../../../plugins/channel/src/channelPlugin.ts) 与 [Channel 提交检查](../../../plugins/channel/src/channelService.ts)，`replyTo` 是本次提问 ID；沿用 `head-reply:<提问 ID>` 去重。状态答复和澄清不带 Pet mention，但其他 Head 仍收到没有 mention 的消息。现有 `head-reply:` 不能区分普通回复和状态回复：Channel 只在首次提交成功后的 live Studio 事件上用已有 `metadata` 放内部标记（如 `headReplyKind: 'progress'`），其来源只允许是可信 Head reply 选项，不由公开请求、正文或 mentions 设置。[Head 订阅入口](../../../packages/studio/src/host/petHead.ts) 在调用任何判断前跳过这类事件。不修改持久 Timeline 结构或普通协作回复；其他订阅者继续看到正常的已提交消息。

| 例子 | 答复方式 |
|---|---|
| 回复原消息问「好了吗？」；只证实执行已完成 | 「执行已完成，尚未确认结果已发到本 Channel。」 |
| 同一任务随后查到精确已提交输出 | 「执行已完成，结果已发到本 Channel。」附该 Timeline 消息，不声称所有交付物都齐全。 |
| 有两项在做而未引用；或顺便要求重跑 | 请对方回复要查的原任务；重跑要求另发，不执行。 |
| 重开后问旧任务；或观察过时且准确队列项缺失 | 「目前无法确认这项工作的状态。」有可信旧证据才注明上次所见。 |

## 6. 落地顺序与验收

先接入独立订阅和接纳身份，再实现有界状态及只读定位，最后接入 Channel 交付查找、正常回复和可信防 fan-out。Channel 拥有授权、持久 Timeline 及提交通知；Head 负责意图、关联、状态和答复。Studio EventBus 与 Dispatch 保持独立，Pet Agent / Host 不依赖 Head 或回调它。

| 用合成事件与真实 Channel 端口验收 | 必须通过的断言 |
|---|---|
| 普通/无关消息、纯进度、混合请求、两个在线 Head、重复投递 | 正确静默、答复或澄清；不派发、不打断、不审批；回复不触发其他 Head，两次请求投递只提交一次回复；普通协作不变。 |
| 有两项工作、有/无引用、跨 Channel 引用、相同 Pet 的独立 Trigger | 合法引用只查正确信息；歧义不作猜测；显式引用失效不回落；其他生产者/实例/Channel 不可被认领。 |
| receipt 前早到、接纳失败、接纳后 Channel 确认失败、幂等重放 | 不认领未接纳工作；接纳后确认故障不抹去证据；重放不重复认领或派发。 |
| 重复与乱序事件、人工审核后换 `requestId`、其他等待 | 不回退阶段、不刷新旧证据；续跑关联同一 invocation；不误报人工审核。 |
| 完成但 Channel 写入延迟/失败，错误作者、两订阅先后交换 | 只有同一 invocation 对应的精确提交行能证实交付。 |
| 快照缺项/读失败、容量满/淘汰、关闭/重开 | 该未知则未知；不泄露全局队列、不越权、不恢复旧归属、不补偿派发。 |
