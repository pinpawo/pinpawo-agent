# Channel 基础草案（#892 第一片）

状态：实现草案，2026-10-03。依据 [#892](https://github.com/pinpawo/pinpawo-agent/issues/892)
与[产品方向补充](https://github.com/pinpawo/pinpawo-agent/issues/892#issuecomment-5921068589)，
以及用户明确的“同 Channel 每个 Pet 固定持久 session；同 Pet 串行执行”修订。

长期方向：人向 Bot 表达目标与授权范围，Bot 关注多个 Channel，Pet 执行当前一轮工作并
通过消息、文档、PR 交付。交付不等于目标完成，Pet 反馈不构成新的用户授权。
本片不实现完整 Bot、跨 Channel 协调、Trigger 调度、同 Pet 并发执行或 Supervisor 重构。
Kanban 历史原样保留，不迁移、不双写；不修改 Wiki，不恢复 macOS companion。

## 持久事实与会话归属

`@pinpawo-plugin/channel` 在独立 `.pinpawo/channel/channels.sqlite` 使用 node:sqlite、WAL、
事务，沿用 Kanban 本地 SQLite 方式，不复用其业务表或数据库 user_version。
channel_entries 是目标修订和公共消息的追加日志；修订保存目标、当前范围、作者、时间、
原因及可选 sourceMessageId，通过 expectedRevision 防止覆盖。消息保存 messageId、revision、
body、replyTo、结构化 mentions、产物 URI/label/version；引用必须属于同一 Channel。
日志使用全局 sequence 分页，最新 revision 是当前目标，没有另一套可写目标状态。

schema v2 增加 channel_sessions，PRIMARY KEY(channel_id, pet_id)、UNIQUE(pet_id, session_id)。
一个 Channel 四个 Pet 对应四个各自持久的 Pet session/thread。同一 pair 的后续新任务、
普通回复及 Host 重启复用原身份，不按任务重建；不同 Channel 隔离。
Host session 注册表和图 checkpoint 仍属于 Host，Channel 只保存映射，不复制图状态。context 读取返回当前 Channel 的 sessions 映射，
供调用者定位对应 Pet TUI 会话。

首次显式执行在 SQLite BEGIN IMMEDIATE 内预留 Host 身份分配函数生成的 sessionId，
随后发送 session:{id,create:true}。Host 幂等注册该身份，使用原 Pet session/thread 命名规则，
不改变活动 TUI session；保存注册记录失败时回滚内存插入。接纳成功后 Channel 将 registered
置为 true，后续仅发送 session:{id}。创建中断后的重试复用预留身份。
已注册 session 缺失或属于其他 Pet 时失败，不回退到活动 session，也不新建会话掩盖失效。
原 TUI 显式删除/错误恢复删除会话的行为不改；此后对应 Channel 绑定保留并报告失效。

## 显式执行与普通问答

创建 Channel、保存普通消息、正文 @ 和结构化 mentions 都不自动执行。
POST /channels/execute 是独立显式动作：{channelId,petId,body} 开始/继续该 pair 的工作；
{channelId,replyTo,body} 从被回复消息的可信来源解析原 Pet/session。若同时提供 petId，必须
与来源一致。跨 Channel 引用、无执行来源的回复对象或不匹配绑定均拒绝。
用户回复入库后，将原问题 messageId、正文与本次答复作为普通输入送入原 session。
Supervisor 自然反问原本是普通回复并结束当轮，保留计划；本片不新造问题状态机。

Host dispatch 支持可选通用 session 目标。显式目标在接纳时固定，出队时再次严格解析。
Coordinator 仍只有一个运行槽，逐项读取目标 checkpoint；等待 interrupt 的会话留在队列，
其他可执行会话可串行绕行，同 session 不重叠。TUI 会话操作仍等待正在执行的 dispatch。
无显式 session 的旧调用保留原活动会话语义。

目标与活动 TUI 不同时，不将运行事件广播进活动会话流；活动 snapshot 不包含别的 session
的 activeRun。dispatch 生命周期增加 sessionId，完成事件附带普通 reply，供业务消费者归属。
Channel 按 (petId,sessionId,invocationId) 去重保存完成回复及来源，用于后续 replyTo 路由。
后台输出以完成回复入库；本片不新增多 session 流式订阅接口。

## 可信上下文与授权审批边界

Studio metadata 仍仅为相关数据，不能提供工具身份。通用 scope:{namespace,id} 明确传到
Host；Host admission 复制 scope，运行时以 resident Pet 身份提供 petId、dispatchId 和可选
sessionId。ALS 上下文只在本轮执行中有效，结束即失效。模型不能设置作者或当前 Channel。
模型仅保留读取上下文工具；普通回复来源来自本次带 Channel scope 的
Host dispatch 生命周期，并检查其 Channel pair 绑定。HTTP 作者为配置 operatorId（默认 studio-operator），代表本地
Studio Bearer 权限，不能据此识别不同自然人。本实现不隔离恶意 Node 插件。

f531a14 的审批关联表、消费集合及恢复包装已完整撤除。授权 human_review 仍由用户通过
原 Pet TUI 选择对应 session 并回复；没有额外审批校验/消费、HTTP resume 或审批持久化。
TUI 审批恢复不会继承 Channel ALS，恢复执行中的 Channel 工具目前会拒绝；此限制没有
通过新增恢复机制隐藏。原 TUI 审批后的输出仍在原 session，不承诺自动回填 Channel。
下一次显式 Channel 普通执行会重新获得本轮可信上下文。

## 接口、通知与可靠性边界

Studio Bearer 保护 GET /channels、GET /channels/context，POST /channels、
/channels/revisions、/channels/messages、/channels/execute；历史支持 after/limit。
模型工具 channel_read_context 不接受作者或 Channel 参数；普通公开回复自动保存。
默认模板不启用该插件；显式启用配置为 {"id":"@pinpawo-plugin/channel"}，Pet capability
的 uses 中按需加入 channel。

COMMIT 后才发消息/修订通知。Studio bus、Host dispatch 队列及生命周期通知仍是内存机制，
没有持久 outbox、执行重放或 exactly-once 交付保证。完成事件丢失不会自动从 checkpoint
回填 Channel；去重只保证同一完成事件重复收到时不重复保存。
用户消息保存成功但 dispatch 失败时，消息仍保留，接口返回错误，不能声称已执行。
Host 重启复用 session/checkpoint；重启不自动重新提交内存队列里的任务。

## 验证

相关测试覆盖 SQLite v1→v2 保留历史、唯一绑定、预留身份失败重试、输出去重，真实
LangGraph/FileSaver 与生产 turn runner 下的四 Pet 独立会话、跨 Channel 隔离、普通问题
replyTo、重启续用、同 Pet 串行、等待绕行、原 TUI 授权恢复、活动会话切换、快照隔离及
失效绑定不重建。确定性图节点不调用模型，不据此宣称真实模型自主协作已验证。

执行 npm test -w @pinpawo-plugin/channel、npm test -w @pinpawo-tests/studio-e2e；
同时运行相关 Host 测试与聚合 typecheck/test/build。构建产物应另外检验跨包导出可用。
本轮只提交本地代码，不推送、创建 PR、合并或部署。

### 本轮收敛：completed / waiting（2026-10-03）

普通对话仅通过 `dispatch.completed.reply` 保存，包括 Supervisor 的自然追问。
移除模型 `channel_send_message`；operator HTTP 消息写入保持不变。Host 只发布本轮新的公开 AI reply，
不把最后工具结果、私有 lane 或旧 checkpoint 回复当作答复。
输出依据 Host 捕获的本次 scope，Session 绑定仅校验目的地，不再反向推导发布意图。

`dispatch.waiting` 直接携带既有 `PendingInterruptProjection`，捕获发生在活动 Session 的显示过滤之前。
schema v3 增加 channel_interrupt_notifications；Channel 将该公开投影保存为独立的只读历史通知，`GET /channels/interrupts?channelId=...` 分页读取；
通知不进入普通消息历史、`channel_read_context` 或自动组装的 replyTo 请求。
通知中的 source 提供 Pet/Session 定位，需在原 TUI 选择对应 Session 处理；没有新增 Channel UI 或深链接。
这是发生过的 waiting 通知，不表示当前仍待审批。options 不作为 Channel 操作入口，
不复制 checkpoint、审批状态或恢复映射；TUI resume 仍无 Channel 回程。

`channel.delivery_failed` 加错误日志报告异步保存失败；它不把 dispatch.completed 改成执行失败。
总线没有持久补投，断线/进程退出可能丢通知，此轮不引入 outbox。

### 审批终态（2026-10-04）

仅原生 human_review 审批保持 waiting。拒绝/取消直接结束本轮，明确说明操作未执行，
保留目标与计划；无 pause_task 二次暂停，队列收到终态后可继续接纳同会话明确输入。
后续输入从 Entry 进入新 run，只有用户指示支持继续时才由 Supervisor 重评计划。
Channel 尚未正式运行；旧 pause 检查点及旧 Channel 绑定不在兼容范围，不新增迁移、
重绑或恢复 API，不删除或改写存量数据。未知/非法原生 interrupt 仍明确报错，
真实 human_review 不得绕过授权。

### 原 Console 整合与执行观测（后续片，2026-10-04）

在 `apps/studio-console` 增加固定 Channel 页面，复用原连接、Bearer、SSE 和样式；
不建立第二套 UI。提供目标列表/创建、完整分页消息时间线、公开产物引用、明确选择
Pet 的单轮执行、针对公开回复的 replyTo。replyTo 由后端解析原 Pet/session，不能改为
另一位 Pet；给其他 Pet 的交接使用新的显式请求。公开正文完整显示，不只显示摘要，
不据此保证模型自身不会遗漏交接信息。创建与保存笔记不触发执行。

schema v4 增加 `channel_executions`，只保存接纳和最近一次生命周期观测，不是持久队列。
只读 `GET /channels/executions?channelId=...` 支持 after/limit。记录关联请求 messageId、
receipt invocationId、Pet/session、发生时间、失败原因及输出/通知保存错误。生命周期
可能早于 receipt 到达，两者事务合并，不让迟到 queued receipt 覆盖终态。记录不会
进入模型 `readContext`，不复制 checkpoint 或新增审批权威状态。

Console 复用原 SSE 刷新领域快照，并在正在执行时显式补读；页面完整读取历史分页。
失败记录可在浏览器刷新和 Host 重启后查看。来自旧 service 实例的未结束记录标为
观测中断/状态未知，不能称仍在执行、自动重试或恢复；waiting 是发生过的审批通知，
需在原 Pet TUI 和原 session 检查当前真实状态。断线期间 Console 不允许提交执行。
completed 只表示该 invocation 结束，不表示目标完成；Channel 持久化错误单独显示，
磁盘完全不可写时仍只能由 live 通知/Host 日志报告。

本片不新增默认模板的自动协作、mention Trigger、审批恢复、持久 outbox、重放或
自动运行恢复。测试用原 HTTP Plugin、Channel SQLite、生产 resident Host/turn runner
与确定性 LangGraph 节点驱动真实浏览器；这些浏览器交互测试不宣称调用了真实模型。
