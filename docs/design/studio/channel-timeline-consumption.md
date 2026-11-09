# Channel Timeline 消费基础

> 状态：消费基础已实现，尚未接入运行中的 Channel Plugin；Pet Head 未实现。
> 更新：2026-11-09

本阶段落实 [#1078](https://github.com/pinpawo/pinpawo-agent/issues/1078) 的后端消费基础，
供[目标设计](https://github.com/pinpawo/pinpawo-agent/pull/1077)中的 Pet Head 后续接入。
当前 @ 与旧 Router 的行为不变。本阶段没有新增可启用 Head 的配置，不改变 @ 的 cooldown，
也没有移除现有 Router 的 session 状态采样；切换将在 Head 接入时一起完成，不能并行重复派发。

## 已实现的范围

- `channel_consumptions` 以 `(channel_id, pet_id)` 保存公开消息消费进度，与执行 session 分开。
- 每次 Pet 加入都有独立的 `membership_id`。创建 Channel 时进度为零；新加入或退出后重入，
  从加入事务看到的已提交 Timeline 末尾开始。重复添加当前成员不会重置进度。
- 迁移只为现有当前 Pet 成员建立当前 Timeline 末尾的基线，不自动重放旧消息，也不改写消息。
- `ChannelTimelineConsumer` 需要显式创建并 `start()`。启动先订阅 Channel 事件，再分页发现
  持久进度和积压；不依赖 Console 在线。Channel Plugin 暂不创建这个消费者。
- 同一实例内，同一 Channel/Pet 串行处理，不同 Pet 独立推进。固定窗口默认 300 ms，
  允许 0–60000 ms；新消息不会重置等待期限。每批默认 50 条，上限 200 条，逐页处理。
  这些是基础类参数，不是已发布的 Studio 配置或最终 Head 产品默认值。
- callback 收到原始消息、作者、引用、附件、顺序及本批起止进度。消息不被合并改写。
  本层尚不实现相关性、@、自输出或 Head 消息过滤策略，不可直接把 callback 当作执行入口。
- callback 成功后，只用 compare-and-set 推进到读取时冻结的批次末尾。
  处理期间的新消息或 callback 发出的公开回复属于后续批次，不会随着旧批次一起确认。
- 同 Channel 的消息追加、成员变动与确认复用现有 Channel 行锁。PostgreSQL 的 sequence 分配
  不代表事务提交顺序，因此追加必须串行，防止低序号消息稍后提交却已被消费进度越过。

## 单实例调度状态

调度保留在 Channel 自己的代码中，借鉴 workqueue 的 dirty/processing 模型，
不引入 p-queue、MQ 或全局并发队列。每个 Channel/Pet 只有一份状态：

- 唤醒设置 `dirty`；同一固定窗口内重复唤醒不新增定时器，也不延长窗口。
- 窗口到期取走这次唤醒并清除 `dirty`，`processing` 持有真实处理 Promise 和取消信号。
- 处理期间的新唤醒只重新标记 `dirty`，不并行处理同一个 key。
- 成功处理后，如果又有唤醒或还有下一页，真实 Promise 结束才启动一个后续固定窗口。
- 失败清除本次处理期间累积的唤醒，保留 cursor；失败后的新唤醒才允许再试。
  旧 membership 已取消时，不清除重入新 membership 产生的唤醒。

`processing` 的结束以真实 Promise 完成为准，abort 不提前释放同一个 key。
不同 Channel/Pet 不共享全局排队或并发上限。

## 错误与退出

callback 抛错不推进进度，不自动重试；下一次新唤醒或新消费者启动可以再尝试。
一个 Pet 失败不阻塞其他 Pet。读取失败和进度写入失败采用相同的保留进度策略。
没有轮询、异常队列或分布式租约；通知是提交后的 best effort，遗漏通知可能需要后续唤醒或重启。

成员退出或消费者停止会清除等待窗口，并 abort 在途处理的 signal。
消费者在末次 membership 读取后再次检查取消，已取消时不再开始 callback。
callback 已开始后，仍必须在产生外部效果前尊重取消，
消费者无法撤销 callback 已产生的效果。旧 membership 不能确认重入后的新进度。
`stop()` 等待在途 callback 结束；callback 若忽略 signal 且一直不结束，停止也会一直等待。
已停止的实例不能重新启动，应新建消费者。配置关闭/重开时的起点留待真正的 Head 配置接入决定。

## 保证与未完成范围

消费进度表示 callback 已处理公开消息，不表示 Host 已接纳或 Pet 已完成。
单实例串行和持久 cursor 不保证跨进程或崩溃后 callback 效果恰好一次。
效果已经产生、但进度尚未落库时崩溃，重启仍可能再次处理同一批。
本阶段不承诺可靠自动重放执行任务，不新增 Host 上下文接口，也不读取或创建 Pet session。

下一阶段实现每 Pet 的轻量 Head、可信来源标记和防确认循环，并在启用新路径时替换旧 Router。
直接回应、先回应后 dispatch、执行事件关联与故障窗口验收仍未完成。

测试覆盖 SQLite 和 PGlite PostgreSQL 方言、真实 SQLite 文件关闭重开、并发唤醒、失败隔离、
批次期间新消息、分页、重复输入和成员重入；还覆盖运行中 100 次合并唤醒、失败期间唤醒、
忽略 abort 的真实占用、末次 membership 读取时取消和停止清除等待窗口。
可选的真实 PostgreSQL 多连接测试需要
`PINPAWO_TEST_POSTGRES_URL`；PGlite 单连接测试不能替代它。
