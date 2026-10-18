# Agent Session timeline 窗口与翻页

状态：第一步（协议 + Host）实现中；后续步骤待做。

## 问题

所有读 Agent Session 的地方都一次拿全量 timeline：

- TUI 在启动、重连、`/refresh` 时，以及每次 `message.completed` / `run.interrupted` / `error` 之后，都会发一次 `session.snapshot.get`。
- Console PetSessionView 在 SSE 每次连接时，第一条消息都是一份完整的快照。

timeline 是 Host 从 LangGraph checkpoint 实时投影出来的视图，本身不单独存储。长会话里 toolCalls 的参数和结果会让快照越来越大。

## 三层数据

1. checkpoint：`state.messages`，是模型的上下文，压缩时会被整体改写。
2. timeline：Host 的投影（`readTuiCheckpointMessages` → `timelineFromCheckpointMessages`），TUI 和 PetSessionView 看到的都是这一层。
3. Channel：独立的表，和这里无关，后面按同样的语义单独改。

## 协议

- `session.snapshot.get` 和 `session.resume` 增加可选的 `timelineLimit`（1..`AGENT_TIMELINE_LIMIT_MAX`=500）。不传时行为与现在完全一样。
- 只要快照里的 timeline 只是尾部，`AgentSession.timelineWindow = { omitted }` 就会给出前面被省略的条数；没有省略时不带这个字段。
- 窗口不会切进正在进行的 run：当存在 `activeRun` 或 `pendingInterrupt` 时，窗口至少从最新一条用户消息开始。
- `session.timeline.page { sessionId, before, limit }` 返回 `before` 之前的最多 `limit` 条，按正序排，并带上 `omitted`（`entries` 之前还剩多少条）。
- 游标就是条目 id。checkpoint 里的消息 id 由 `messagesStateReducer` 补齐，所以是稳定的。压缩之后旧 id 可能不存在了，这时返回 `session.error`（`operation: 'timeline'`），读者应当重新拉快照。
- 翻页和快照一样只是观察，不排队，run 进行中也不会被拒。
- 其他字段（`activeRun`、`pendingInterrupt`、`currentPlan`、`runtime`、token 用量）始终完整返回。

Host 仍然要读出整个 checkpoint 再切片，因为 messages 存在同一个 blob 里。窗口节省的是序列化、传输和客户端的处理。

## 步骤（每步一个 PR）

1. agent-session 协议和 Host 实现（本步）。
2. TUI：启动、重连和对账时带上 `timelineLimit`；合并逻辑从“整段替换”改为“用窗口替换尾部、保留前面已有的条目”；顶部显示“更早 N 条已省略”；在 PageUp transcript 里按需加载更早的条目。
3. PetSessionView 和 studio-http：`/pet-sessions/snapshot`、`/pet-sessions/events` 传入 limit；因为 SSE 是单向的，另加一个 GET 翻页接口；界面加“加载更早”按钮。
4. Channel：`/channels/context` 加 `before` 游标并只读最近一页，事件携带 sequence，用于 `after` 增量拉取。
