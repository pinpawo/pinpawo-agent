# 执行期间的新输入与 Studio system interrupt

状态：实现草稿，待 review；已完成本地行为验证及 Toolbox 首轮实机观察。

## 问题与目标

Pet 正在委派工作时，后续消息留在 Host 队列，当前 Supervisor 无法看到。
本次让普通新输入在 delegation 返回后接入，并提供立即中断当前执行的可信
Studio dispatch 选项。两条路径均复用现有 Abort、Entry 和 `continue`，保留计划与
真实执行记录，不另建子任务恢复状态。

## 接入与归属

Root 在 Capability ToolMessage 提交后的独立 `delegationBoundary` 节点调用可选的
`onDelegationComplete` invocation hook。pet-agent 不认识 Studio、Channel 或 Host 队列。
Host 检查相同 Pet、显式 session、完整 scope 的待处理 dispatch；只有匹配输入才
中断旧 turn。尚未消费的新输入仍由既有队列取出，进入正常的新 run。

新 run 的 Entry 读取新消息和保存的计划，由模型选择 `continue`、新规划或直接回答。
`continue` 把现有计划绑定到新 run，Supervisor 从 Boundary 接回。已返回的 delivery
按计划项身份保留，可以验收；未返回的执行不算完成，不自动重放产生副作用的工具。

```mermaid
sequenceDiagram
  participant C as 输入来源
  participant H as Host 队列
  participant P as pet-agent
  C->>H: 同 session/scope 的新 dispatch
  P->>P: delegation 返回并保存 ToolMessage
  P->>H: onDelegationComplete
  H->>P: 中断旧 turn
  H->>P: 正常取出新消息，启动新 run
  P->>P: Entry 选择 continue，Supervisor 结合新输入继续
```

Hook 不取出消息、不追加用户正文、不写 checkpoint，也不构造 `continue` 工具调用。
这样保留唯一的队列消费入口。原 invocation 结束为 interrupted；下一 invocation
拥有后续回复，避免一次公开消息被两个 invocation 重复发布。

## 立即中断

可信的 in-process Studio dispatch 可请求 `delivery: 'interrupt'`。Host 先接收新输入，
再匹配当前 session、scope 与 request ID，使用既有取消入口中断执行。待旧执行真正
结算后，队列正常继续。其他 Channel、session 和旧 request 不得被打断。

该控制不等于模型消息的 system role。新内容仍以原来源进入消息历史，不提升 Pet
发言的授权。公共 wire dispatch 不接受该可信控制和 session/scope 字段。

取消绑定当前实际 request ID，不保存供后续 turn 使用的中断标记。若实际运行尚未
建立，输入保持排队；不会预先取消尚未开始的 turn。

如果取消与原生人工审批相遇，真实 interrupt、原 dispatch 归属及公告快照继续保留。
新输入等待明确审批，不生成审批答案、不以普通输入调用原生 resume。

## Channel 的提示

Channel 记录对话并发布实时事件，不选择接收者。在线 Pet Instance 的 Head 精确订阅所属
Channel 的 topic，自行判断忽略、轻量回复或请求 Host dispatch；实例停用时取消订阅，
离线漏掉的事件不补发。Head 的派发保留原消息、引用及附件，经过既有的 Channel session
绑定和 Host admission。显式 Host dispatch，以及 schedule/trigger 的独立 `run()` 入口
仍可使用；旧 Channel decision LLM、`contextHint` 和模型 `focus` 不属于这条输入路径。

Channel 通过 scoped context provider 提供 invocation `hint`，提醒先委派显式配置的
`channel_context` Capability 读取最新相关消息，再判断本轮工作。没有该 Capability 时，
提示要求通过可用的 `channel_read_context` 工具补齐背景；缺少能力或读取失败时说明缺口。
固定读取提示来自 [Channel 插件代码](../../../plugins/channel/src/channelInvocationHint.ts)，
不代表消息作者的新授权，也不强制生成计划。公告仍使用原有 system context provider。
provider 兼容原来的 section 数组，也可返回公告与 hint；pet-agent 不解析 Channel
envelope。Studio dispatch 不增加 hint 参数。

Host 在 admission 前冻结本次 hint，通过 invocation runtime context 传递。Entry 的 goal
与外部 hint 分开，`plan_request`、`continue` 参数不变；Supervisor 在 request 旁读取准备
提示，可按已有 Capability 边界安排上下文分析，再根据返回证据推进或校准剩余工作。
Entry 不增加业务读取工具。没有 hint 时不新增提示段落，沿用原来行为。子任务继承原始
runtime hint，但不重复渲染整轮准备提示，避免业务子任务再次启动准备工作。

schedule/trigger 使用 `channel_task` 请求，指令不另存为 Channel 消息；显式派发通过
provider 获得 Channel 准备提示。hint 不写入 canonical 对话历史；原生审批等待状态
保存原 invocation hint，恢复时不查询新 provider 或采用新输入的提示。普通新输入
用自己的 hint，缺省时不沿用旧值。

消息寻址、live 事件、显式执行与公开回传的边界见
[Channel 寻址、执行与状态](../studio/channel-addressing-and-execution.md)。Pet 私有执行结果
不会作为 Channel 公开消息发布。

## 验证与限制

验证普通 delegation 返回后接入、立即取消、同目标连续输入、跨 session/scope 隔离、
原生审批竞态、公开回复归属，以及 continuation 后真实结果可验收、工具不重放。
跨包测试使用真实 Host、Channel provider、checkpoint 和 graph，只替换模型响应。
实现证据见 [Root 边界测试](../../../packages/pet-agent/src/agent/orchestrator/runtime/graph.test.ts)、
[Host 输入与审批竞态测试](../../../services/host/src/host/residentPetIncomingInput.test.ts)
和 [Channel 跨包测试](../../../tests/studio-e2e/src/channelIncomingInput.test.ts)。
Channel 跨包测试使用测试专属的合成消息 envelope 并显式调用 Studio dispatch；它验证
输入接续与公开回复归属，不证明 Channel 消息或 @ 会触发派发。

Host 队列仍是内存队列。本设计不承诺进程崩溃后恢复未执行的 dispatch，也不自动
合并内容相似的多条消息。delegation 结束之后才到达的普通输入仍可能等待下一边界；
需要立即干预时使用明确的 interrupt 控制。
