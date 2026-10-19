# Agent Session timeline 窗口

状态：前三步已合并（#985 协议 + Host、#986 TUI、#987 PetSessionView 和 studio-http）；第四步（Channel）实现中。

## 问题

所有读 Agent Session 的地方都一次拿全量 timeline：

- TUI 在启动、重连、`/refresh` 时，以及每次 `message.completed` / `run.interrupted` / `error` 之后，都会发一次 `session.snapshot.get`。
- Console PetSessionView 在 SSE 每次连接时，第一条消息都是一份完整的快照。

timeline 是 Host 从 LangGraph checkpoint 实时投影出来的视图，本身不单独存储。长会话里 toolCalls 的参数和结果会让快照越来越大。

## 三层数据

1. checkpoint：`state.messages`，是模型的上下文，压缩时会被整体改写。
2. timeline：Host 的投影（`readTuiCheckpointMessages` → `timelineFromCheckpointMessages`），TUI 和 PetSessionView 看到的都是这一层。
3. Channel：独立的表，和这里无关，后面单独改。

## 协议

- `session.snapshot.get` 和 `session.resume` 增加可选的 `timelineLimit`（1..`AGENT_TIMELINE_LIMIT_MAX`=500）。不传时行为与现在完全一样。
- 只要快照里的 timeline 只是尾部，`AgentSession.timelineWindow = { omitted }` 就会给出前面被省略的条数；没有省略时不带这个字段。
- 窗口不会切进正在进行的 run：当存在 `activeRun` 或 `pendingInterrupt` 时，窗口至少从最新一条用户消息开始。
- 只截 timeline；其他字段（`activeRun`、`pendingInterrupt`、`currentPlan`、`runtime`、token 用量）始终完整返回。
- 想看更早的条目，就用更大的 `timelineLimit` 再拉一次快照；超过上限时不带 limit，拿全量。

没有单独的翻页消息或游标。Host 无论如何都要读出整个 checkpoint 再投影（messages 存在同一个 blob 里），所以翻页并不比再拉一次快照便宜。只保留一条读取路径，客户端只有一种合并方式，也就不存在“游标被压缩删掉了”这种错误。代价是重传客户端已有的条目，但这只在用户主动往上翻时才发生。游标分页留给真正按段存储的 Channel。

窗口节省的是序列化、传输和客户端的处理。

## 步骤（每步一个 PR）

1. agent-session 协议和 Host 实现。
2. TUI：
   - 启动、重连、对账、`/refresh` 和 resume 都带 `timelineLimit`（默认 100）。
   - `applySessionSnapshot` 收到窗口快照时，从窗口的第一条开始替换，本地在它之前已有的条目保留；本地缺的条数仍以本地的 `timelineWindow` 为准。窗口的第一条在本地找不到（不同 session，或本地是空的）时，直接按窗口原样使用。
   - 每轮结束的对账需要一条共有的条目来对齐。窗口和本地没有任何共有条目时（单个 run 超过窗口长度，而本轮的 live id 还没换成 checkpoint id），改为读一次全量快照，不硬对齐。
   - scrollback 首次渲染窗口时，在顶部写一行“N earlier entries · PageUp for the full transcript”。
   - PageUp transcript 和 `/export` 会读一次全量快照，把本地没有的前段补上后展示；读到的全量不保留在内存里。Host 无法响应时退回本地内容，并在头部注明缺了多少条。
3. PetSessionView 和 studio-http：
   - `/pet-sessions/snapshot` 和 `/pet-sessions/events` 接受可选的 `timelineLimit` 查询参数（正整数，否则 400），经 `PetSessionPort.snapshot/observe` 传给 Host；上限由 Host 校验。
   - Console 默认带 100。SSE 每次（重新）连接发来的窗口快照按 TUI 同样的方式拼接，已加载的更早条目保留。
   - 有省略时，记录顶部显示“Load earlier entries”按钮：用“已有条数 + 100”的 limit 再拉一次快照，超过 500 时不带 limit 拿全量；加载后保持滚动位置。
4. Channel（本步）：
   - `/channels/context` 和 `channel_read_context` 默认返回最近的一页；`before=nextBefore` 往前读（`hasEarlier`），`after=nextAfter` 往后读（`hasMore`）。两种方向返回的消息都按 sequence 升序，`after` 和 `before` 不能同时给。
   - Console 打开 Channel 时只读最近 100 条，顶部有“Load earlier messages”按钮，每次往前读一页。之后的刷新（Channel 事件、发送后、client key 的轮询）只用 `after=` 已有的最新 sequence 读增量，按 sequence 合并去重。“Refresh persisted history”按钮仍然重新读最近一页。
   - `channel.message.created` 事件本来就带完整消息（含 sequence），事件格式不变；Console 收到事件后按 `after` 拉增量，client key 没有事件流，也走同一条路径。
   - CLI `channels read` 增加 `--before`。
