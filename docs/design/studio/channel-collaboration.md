# Channel 基础草案（#892 第一片）

状态：实现草案，2026-10-03。依据 [#892](https://github.com/pinpawo/pinpawo-agent/issues/892)
与[产品方向补充](https://github.com/pinpawo/pinpawo-agent/issues/892#issuecomment-5921068589)。

长期方向：人向 Bot 表达目标与授权范围，Bot 关注多个 Channel，Pet 执行当前一轮工作并
通过消息、文档、PR 交付。Channel 是及时共享依据，Wiki 是共同参考。交付不等于目标完成，
Pet 反馈不构成新的用户授权。本片不实现 Bot 产品、跨 Channel 协调、Trigger 派发、
Session/Supervisor 重构、UI 或模板切换。Kanban 历史原样保留，不迁移、不双写。

## 持久化与接口

`@pinpawo-plugin/channel` 拥有 SQLite 追加日志。每个 Channel 的首条 revision 保存长期
目标、当前 scope 和参考资料；后续修订完整保存旧内容、作者、时间、原因及可选 sourceMessageId。
最新 revision 是当前状态，使用 expectedRevision 检测并发覆盖，没有另一份状态事实。
消息保存独立 messageId、当时 revision、作者、body、replyTo、结构化 `mentions: [{petId}]`、
`artifacts: [{uri, label?, version?}]`。URI 是不执行的引用；本片不下载附件、不推断审查通过。
replyTo/sourceMessageId 必须在同一 Channel 中存在。历史以全局递增 sequence 分页，
包括修订与消息；listChannels 按稳定创建顺序分页。读取消息同时返回最新目标供执行核对。

公开 `ChannelService` 是供可信 Host/Bot adapter 使用的程序接口，author 参数属于该信任边界。
模型只有 `channel_send_message` 和 `channel_read_context`；模型输入不能设置作者或 Channel。
Plugin 验证 mentions 是已配置的 Pet，不解析正文 @，不强制下一位角色或动作枚举。

受 Studio Bearer 认证保护的接口：GET /channels、GET /channels/context?channelId=…、
POST /channels、POST /channels/revisions、POST /channels/messages。
读取可带 after/limit；POST schemas 与导出的领域 schemas 一致，修订和消息额外要求 channelId。
HTTP 作者固定为 Host 配置的 operatorId（默认 studio-operator），代表本地 bearer 权限，
不冒称可以识别不同自然人；body author 被拒绝。Bot 身份的认证 adapter 留给后续产品实现。
创建和发消息均不 dispatch，默认模板不加载本插件。安装后显式在 Pet capability 的 uses 中
选择 channel Toolkit；后续启动仍是独立、明确的标准 dispatch。

## 可信本轮上下文

现有 StudioDispatchRequest.metadata 只在 receipt 回显，未传入 Pet。本片保留其语义，
新增通用 `scope: {namespace, id}`，Studio 不解释领域内容。调用者与现有 dispatch 一样
须经 Host admission；Channel 执行使用 namespace=channel、id=实际 Channel ID。
Host 在入队时复制 scope，在运行时从 resident runtime 提供 petId/dispatchId，使用独立
AsyncLocalStorage 暴露只读调用上下文。Channel 工具不读取模型参数、正文、RunnableConfig
或 Session checkpoint 来确定身份；同一 Pet 不同 dispatch 的 scope 不共享，结束即失效。
未指明 scope 的 dispatch 不继承前轮 Channel。Channel ID 与 threadId 无关。

安全边界：这是可信 Host 扩展环境，不是隔离恶意 Node 插件的沙箱。HTTP bearer 权限拥有者
本来即可派发任意已配置 Pet；scope 不增加作者冒充权。缺少本轮上下文时工具失败关闭。
Host 在 scoped dispatch 实际进入 human_review 等待后保存原 invocation 与审批的关联，
校验依据包括 checkpointId、interruptId、原始 review 内容及所属 thread（thread 只做隔离
校验，不产生身份）。现有审批入口先校验当前审批与决定；恢复前再次核对关联并一次性消费，
以原 petId/dispatchId/scope 运行。若再次等待审批，绑定新的审批关联（interrupt 或
review 内容须变化；仅移动 checkpoint 不能重装已消费的相同审批）；完成、异常、
取消或 Host 关闭不保留可重放的关联。普通消息不能创建或接管关联。
关联目前仅在 resident Host 生命周期内保留，支持客户端断线重连；Host 进程重启后的
恢复及普通 continue 不从长期 Session 猜测身份，缺少关联时 Channel 工具仍会拒绝。
跨进程持久化恢复与 Trigger delivery 的契约后续评审，不把缺少上下文默认为用户授权。

## 事件边界与剩余工作

SQLite COMMIT 后才发布 channel.message.created / channel.revised，payload 含日志 sequence
及完整记录。通知失败不回滚已持久化消息，也不将已保存误报为未保存。历史读取可恢复事实，
本片没有自动通知重放、delivery 状态或可靠 outbox，不宣称消息已响应/已执行。

已核对 Trigger 动态 target 解析单一字符串，事件去重使用 source/type/sequence，Studio
bus 仅驻留内存。未来需选择逐接收者通知或通用 fan-out，按消息+接收者去重，并解决 commit
到通知/接收之间的故障窗口。不要直接用当前消息数组假装 Trigger 已支持多接收者。
公开历史可作为未来恢复依据，但当前不实现调度，也不自动恢复暂停的任务。

## 可复现验证

仓库构建后可分别运行 `npm test -w @pinpawo-plugin/channel`（SQLite 领域测试）、
`npm test -w @pinpawo-tests/studio-e2e`（真实 HTTP 与 resident 队列/工具调用）。
这些测试无需模型凭据；基础队列测试使用确定性执行回调，审批测试使用生产 turn runner
与确定性 LangGraph 节点。尚未验证真实模型自主交接。

显式启用时，在实验 Studio 配置的 plugins 数组加入
`{"id":"@pinpawo-plugin/channel"}`，并在试验 Pet capability 的 uses 中加入 channel。
先 POST /channels 保存目标；POST /channels/messages 只保存。
单独 POST /dispatch 输入例如：

```json
{
  "petId": "executor",
  "request": "先读取 channel_read_context，核对当前范围，再反馈调查结果。",
  "scope": {"namespace": "channel", "id": "<创建接口返回的 channelId>"}
}
```

不得以配置示例作为启动实际工作的授权。本次未改已有运行配置或启动 Studio。

审批验收使用真实 LangGraph interrupt、FileSaver checkpoint 和生产审批校验/turn runner，
覆盖连续两次审批、断线重连、错误决定、跨 Pet/Channel、取消及旧审批重放；图中执行节点
为确定性测试工作，不调用外部模型。
