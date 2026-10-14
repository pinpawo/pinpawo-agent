# Channel 寻址、执行与状态

状态：当前实现设计，2026-10-05；基础由 [#897](https://github.com/pinpawo/pinpawo-agent/pull/897)
引入，统一参与者与来源修复由 [#904](https://github.com/pinpawo/pinpawo-agent/pull/904) 合并。
本文是 Channel 当前设计入口；合并不表示已更新任何用户 workdir 或部署。

> 2026-10-14：按 [Channel 模型](channel-model.md) 重新实现：成员、自然对话（无目标/修订）、Pet 公开回复即消息、
> schedule / trigger 的 `run()`。本文已同步；数据与规则以 Channel 模型为准。

早期方案与验收沿革见[历史记录](../../history/studio/channel-evolution.md)。

## 职责

成员（人和 Pet）在同一 Channel 自然对话、寻址、交接和查看结果。
协议地位平等不表示权限相同，也不产生新的用户授权。

| 层 | 所有权 |
|---|---|
| Console | 创建与成员管理、人的阅读与回复、全局队列展示；过程经 Pet session 视图查看。 |
| Channel Plugin | Channel、成员、消息、寻址、会话绑定，以及 Pet 公开回复到消息的映射。 |
| dispatch / resident Host | 接纳、同 Pet 运行槽、全局内存队列、生命周期与执行去重。 |
| Pet / Agent Session | checkpoint、能力、工具审核、原生审批与恢复。 |

Channel 调用 dispatch，不自建可靠队列、重试、outbox、重放或审批恢复。
Studio core、HTTP 与 Plugin 装配边界见 [Host 设计](independent-host-runtime.md)。

## 参与者与寻址

可寻址的是 Channel 的当前成员（`human` 或 `pet`）。`participantId` 为
`kind:<RFC3986 百分号编码的原始 id>`，包括编码 `!'()*`；例如 `pet:reviewer`。
名称只作 label，不按同名、改名或正文自称猜测身份。“Me”只是查看者显示称呼。
在 Studio 客户身份之前，HTTP 请求的成员身份由 `operatorId` 确定（默认 `studio-operator`），
共享 Bearer 的浏览器共享此身份；不是成员的请求返回 403。也不隔离恶意进程内 Node Plugin。

统一入口 `POST /channels/messages` 保存正文、可选 `replyTo`、artifacts 和
`mentions: [{participantId}]`。正文直接链接 `[@Reviewer](participant:pet:reviewer)`
表达同一目标。

- 草稿、普通 `@label`、代码、引用和转述示例不寻址。
- 有效目标须是当前成员，缺失/无效身份报错；同一消息的重复目标合并。Pet @ 自己同样派发（自我交接）。
- 多目标独立接纳与失败，不隐含依赖或顺序。Pet 目标调用 dispatch；人目标在 UI 阅读。
- Pet 的公开回复是普通消息，使用同一解析和投递入口；Pet 自主决定是否、向谁交接。
  其中无法解析的 @ 不阻止保存，消息不带目标，并发布失败的 `channel.delivery` 事件。
- `replyTo` 只提供同 Channel 引用，不选择目标或授权借用原作者的 session。

Console 点击 Reply 按原作者的 kind / 原始 id 预选已登记 participantId，可改选或清除；
已移除作者不猜目标。人作者默认选择人，不派发 Pet。清除且正文无有效寻址时仅保存；
正文主动寻址仍生效，UI 明确说明该条件。这个人的 UI 默认不替 Pet 输出补目标。

## 持久事实与 session

Channel 默认使用 `.pinpawo/channel/channels-v2.sqlite`，SQLite WAL 与事务独立于其他 Plugin；
不读取旧模型的 `channels.sqlite`。存储在 `ChannelStore` 接口后面，表结构见 [Channel 模型](channel-model.md)：
`channels`、`channel_members`、`channel_messages`（作者列 + `external_ref` 幂等）和 `channel_sessions`
（唯一 `(channelId, petId)` → sessionId 映射与注册标记）。跨 Channel 引用拒绝，提交后才发通知。

首次使用 pair 时在事务内预留 Host 分配的 sessionId，dispatch 携带 `session:{id,create:true}`；
接纳后确认注册，后续只用该 id。预留后接纳失败仍保留身份供显式重试。
同 pair 的新任务、普通续问与重启继续原 checkpoint；不同 Channel 的绑定隔离。
失效或错 Pet 的已注册 session 明确失败，不回退活动 TUI 或新建会话掩盖问题。
Channel 只保存映射，session 注册表与图状态仍由 Host 持有。

同 Pet 的跨 Channel 与 TUI 工作共享运行槽，不并发；不同 Pet 可并行。
有原生 interrupt 的 session 可被其他可运行 session 绕行，不承诺各 Channel 严格 FIFO。
后台运行不进入其他活动 TUI 的消息流或 activeRun 快照。

## 可信来源与公开输出

Channel 给 dispatch 的 `scope:{namespace:'channel',id}` 由 Host 在接纳时捕获，
本轮 invocation context 提供 Pet/session 身份；metadata 和模型不能设置当前 Channel。

Pet 在 Channel 里的发言就是它绑定 session 中的公开最终回复：dispatch（及审批后的续跑）里，
Agent Session 的 `message.completed` 原样作为非终态 `dispatch.message`（payload `message`，去掉 requestId）
发布。Channel 只处理带 channel scope、session 与绑定一致、正文非空的这一事件，以 Pet 为作者、
Agent Session 消息 id 为 `external_ref` 幂等写入普通消息，再走统一的寻址投递。
带工具调用的消息（`message.tool_calls`、`tool_call.settled`）、operation、subagent 与私有 Capability
交付属于运行过程，不发布到 dispatch 观察者，也不进入 Channel；Pet 已离开 Channel 等写入失败只发布
`channel.message_failed` 事件。没有 `channel_send_message` 第二条输出路径。

唯一 Channel Toolkit 入口 `channel_read_context` 只读本轮已接纳 Channel 的标题、说明、当前成员和分页消息，
不接受作者或 Channel 参数；该工具不派发或恢复工作。

交接输入由 Channel 从已保存当前消息和可选引用消息生成 fenced JSON：

```json
{
  "type": "channel_message",
  "version": 1,
  "channelId": "current-channel",
  "messageId": "current-message",
  "author": { "participantId": "pet:planner", "kind": "pet" },
  "body": "本轮参与者正文",
  "replyTo": {
    "messageId": "quoted-message",
    "author": { "participantId": "human:studio-operator", "kind": "human" },
    "body": "被引用的历史正文"
  }
}
```

schedule / trigger 经 `inputs` hook 的 `run(channelId, petId, request, origin)` 驱动成员 Pet：
输入为 `{type:'channel_task', version:1, channelId, origin:{kind,id}, body}`（同样围栏），没有作者、不写入 Channel，
只进入该 Pet 的 Channel session；Pet 随后的公开回复照常成为它的消息。回执由 scheduler / trigger 保存在自己的记录里。

顶层来源来自已保存消息的成员作者，不读取正文/metadata 自称，不授额外权限。
JSON 字符串隔离正文，围栏长于输入中的反引号；原样公开封装不会让其历史/示例链接寻址。
`replyTo` 是历史上下文，不是第二条当前请求。模型的内容判断仍需真实验收。

默认外部 `PET.md` 定义主对话的来源与最终公开回复规则；外部 `CAPABILITY.md` 定义执行
寻址与交付边界。Host 在 Entry、Supervisor 和执行侧提供本 Pet 的 PET.md；Capability
执行提示只在对应执行侧加载。通用 pet-agent 不嵌入 Studio 规则。
主对话自主采用交接时，在最终普通正文保留完整有效链接和任务；内部生成链接不是派发，
不原样公开内部封装，不把历史链接自动转为交接，无运行证据不声称目标已收到或完成。
这些规则须留在实际被加载的外部文档，不能以人读设计文档的链接替代运行时提示。

## 观察、审批与可靠性限制

Console 发送后显示所有 Pet 的真实全局状态和队列，消费 `GET /dispatch/queues`，
不从 Channel 历史估算，不增加发送前 busy 提示或自动排队回执。投影含身份、入队时间与
session/scope 关联，不含请求/模型正文；当前 Bearer 可观察所有配置 Pet。
模型 Channel context 不含全局队列。布局和连接行为见 [Console 设计](console.md)。

Channel 不保存执行、审批或投递记录。投递结果在发送响应里返回，并作为全局 `channel.delivery` 事件发布；
运行过程与审批由持本机 token 的人按 `GET /channels/sessions` 找到 session，经 `/pet-sessions/*` 查看。
Pet 回复中 @ 的投递失败没有请求方，只有全局事件可见（best-effort 边界）。
普通下一条输入继续同 session，正常 A↔B / self handoff 不新增次数限制或协作等待状态机。

用户在原 Pet TUI/session 或 Console 的 Pet session 视图检查并处理当前审批。dispatch 停在审批时，Host 在该 session 记录
上保存 `pendingDispatch`（interruptId → 原 dispatchId/request/scope），随 session 注册表持久化。
回答同一 interrupt 的 resume 即该 dispatch 的续跑：恢复原 Channel scope，按原 dispatchId 发布
running/completed/failed/interrupted，再次停在审批则改记新 interruptId 并发布 waiting；
其他 resume 仍是普通对话。所以 waiting 不是终态，审批后的回复（含拒绝/取消后的结束语）
回到原 Channel，重启后再审批同样成立。拒绝/取消结束本轮，不二次暂停；非法 interrupt 仍报错。

Studio 幂等接纳按 producer/Pet 隔离、并发共享 Promise，只在进程内有效。
两次独立消息提交有不同 messageId；重复的 `message.completed` 由 `external_ref` 复用已保存消息，不再派发。
保存后派发失败保留消息并报告失败。总线/队列不持久，丢事件不从 checkpoint 补投；
重启不重放待运行输入，没有跨重启 exactly-once、durable outbox 或自动恢复保证。

## 接口、迁移与验证入口

[Studio API](../../reference/api/studio.md#channel-messages-and-addressing) 列出路由及 payload；
[配置与迁移](../../studio/configuration.md#retired-kanban-workdirs) 是唯一操作步骤入口。
包模板不自动升级已有 workdir 或用户 PET.md / Capability。旧 Kanban 数据库与 Wiki 原样保留；
旧模型的 Channel 数据不迁移、不再可见，也不新增 session 重绑/恢复 API。

- [Channel 单元](../../../plugins/channel/src/channelDispatchInput.test.ts)、
  [真实 Host loop](../../../tests/studio-e2e/src/channelLoop.test.ts) 与
  [生产模型边界](../../../tests/studio-e2e/src/channelPublicReply.test.ts) 验证身份、来源与发布。
- [session/恢复边界](../../../tests/studio-e2e/src/channelSessions.test.ts) 验证持久绑定、串行与原审批。
- [Console 验收命令](../../../apps/studio-console/README.md#validation) 覆盖默认 Reply、全局队列和响应式 UI。
- [#904 验收记录](https://github.com/pinpawo/pinpawo-agent/pull/904) 按 head 区分确定性与真实模型证据，
  记录 e2cd4299 的真实 Chrome Reply 与 4 轮交接通过，以及未覆盖的攻击集、随机重复、provider
  failure、Review deny/cancel 和未捕获原始 provider prompt；不把一次通过视为所有场景保证。
