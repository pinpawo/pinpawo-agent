# Channel Timeline 消费基础

> 状态：消费基础已实现；Channel Plugin 在启用 Pet Head 时接入，见 [Head 实现边界](channel-pet-head.md)。
> 更新：2026-11-09

本阶段落实 [#1078](https://github.com/pinpawo/pinpawo-agent/issues/1078) 的后端消费基础，
供[目标设计](https://github.com/pinpawo/pinpawo-agent/pull/1077)中的 Pet Head 后续接入。
显式 @ 的即时交付不变。启用 Head 时由每 Pet 判断替代旧 Router；不同时运行两条自动派发路径。
本篇说明基础调度器，运行中的 Head 策略和切换语义见上述实现边界。

## 已实现的范围

- `channel_consumptions` 以 `(channel_id, pet_id)` 保存公开消息消费进度，与执行 session 分开。
- 每次 Pet 加入都有独立的 `membership_id`。创建 Channel 时进度为零；新加入或退出后重入，
  从加入事务看到的已提交 Timeline 末尾开始。重复添加当前成员不会重置进度。
- 迁移只为现有当前 Pet 成员建立当前 Timeline 末尾的基线，不自动重放旧消息，也不改写消息。
- `ChannelTimelineConsumer` 需要显式创建并 `start()`。启动先订阅 Channel 事件，再分页发现
  持久进度和积压；不依赖 Console 在线。Channel Plugin 仅在 Head 启用时创建这个消费者。
- 同一实例内，同一 Channel/Pet 串行处理，不同 Pet 独立推进。固定窗口默认 300 ms，
  允许 0–60000 ms；新消息不会重置等待期限。每批默认 50 条，上限 200 条，逐页处理。
  这些是基础类参数，不是已发布的 Studio 配置或最终 Head 产品默认值。
- callback 收到原始消息、作者、引用、附件、顺序及本批起止进度。消息不被合并改写。
  本基础层不判断相关性；Plugin 提供 Head 策略及可信来源过滤，不可直接把 callback 当作执行入口。
- callback 成功后，只用 compare-and-set 推进到读取时冻结的批次末尾。
  处理期间的新消息或 callback 发出的公开回复属于后续批次，不会随着旧批次一起确认。
- 同 Channel 的消息追加、成员变动与确认复用现有 Channel 行锁。PostgreSQL 的 sequence 分配
  不代表事务提交顺序，因此追加必须串行，防止低序号消息稍后提交却已被消费进度越过。

## 错误与退出

callback 抛错不推进进度，不自动重试；下一次新唤醒或新消费者启动可以再尝试。
一个 Pet 失败不阻塞其他 Pet。读取失败和进度写入失败采用相同的保留进度策略。
没有轮询、异常队列或分布式租约；通知是提交后的 best effort，遗漏通知可能需要后续唤醒或重启。

成员退出或消费者停止会 abort 当前 callback 的 signal。callback 必须在产生外部效果前尊重取消，
消费者无法撤销 callback 已产生的效果。旧 membership 不能确认重入后的新进度。
`stop()` 等待在途 callback 结束；callback 若忽略 signal 且一直不结束，停止也会一直等待。
已停止的实例不能重新启动，应新建消费者。Head 关闭后重开从当时尾部开始，正常启用状态重启保留进度。

## 保证与未完成范围

消费进度表示 callback 已处理公开消息，不表示 Host 已接纳或 Pet 已完成。
单实例串行和持久 cursor 不保证跨进程或崩溃后 callback 效果恰好一次。
效果已经产生、但进度尚未落库时崩溃，重启仍可能再次处理同一批。
本阶段不承诺可靠自动重放执行任务，不新增 Host 上下文接口，也不读取或创建 Pet session。

每 Pet Head、可信来源标记、直接回应和可选先回应后 dispatch 已接入。
执行退出事件关联与更强故障窗口保证仍未完成。

测试覆盖 SQLite 和 PGlite PostgreSQL 方言、真实 SQLite 文件关闭重开、并发唤醒、失败隔离、
批次期间新消息、分页、重复输入和成员重入。可选的真实 PostgreSQL 多连接测试需要
`PINPAWO_TEST_POSTGRES_URL`；PGlite 单连接测试不能替代它。
