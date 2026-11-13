# Channel Timeline 队列

> 状态：队列基础；Head 尚未接入。更新：2026-11-12

Channel 保存一份共享的公开消息 Timeline。追加在事务提交之后通知本进程订阅者；通知是 best effort，既不跨进程可靠投递，也不代替启动时补读。相同 Channel 的追加在事务内持 Channel 行锁：PostgreSQL 序列分配的先后并不保证提交先后，锁防止消费者先看到较大序号并越过迟提交的较小序号。不同 Channel 可独立追加。直接使用底层 store 追加时也必须在同一事务中持有该 Channel 锁。

## 消费契约

可信的内部消费者通过 `subscribe` 订阅变更提示，通过 `queueHead(channelId)` 捕获上界，再用 `queueRead(channelId, { after, through, limit })` 自行读取 Timeline。读取范围按序号升序分页；消费者应先确定本批上界，再在整个批次中沿用该上界，处理期间追加的消息属于后续批次。消费者不应仅依赖通知：启动时先订阅，再从持久游标补读，运行中也要有自己的漏通知恢复办法。

`queueCursor(channelId, consumerKey, initialAfterSequence)` 以 Channel 和不透明 consumer key 标识持久进度；不同 key 独立。首次创建必须显式指定起点，已有游标不会因重新初始化而改变。消费者处理成功后调用 `advanceQueueCursor(expected, throughSequence)`，以旧位置比较并交换（CAS）推进到已处理的批次末尾；读取、处理失败或取消时不推进。消费者自行决定首次起点、正常重启和关闭再打开的 backlog 策略，以及何时确认。不得用大于实际处理范围的位置确认，否则会跳过消息。游标持久化用于重启后恢复：只存在内存时，从头恢复会重放，从当前末尾恢复会遗漏。游标不是工作完成或 Host 接纳的证明。CAS 也不是 exactly-once：处理产生副作用后、确认前崩溃会重放，消费者须处理重复和并发协调。同一个 key 的活跃处理必须由消费者自行协调；CAS 不阻止两个处理者在确认前重复产生副作用，也不是取消或生命周期栅栏。

队列不枚举消费者，也不管理其生命周期、定时器或执行任务。通知本身不查询游标；消费者按自己的批次读取。旧实现是每次新消息唤醒并枚举成员，每批读取进度、消息、再次校验进度，再在处理成功后 CAS，并非每条通知直接查询游标。

## 与 Head 和 Host 的边界

后续 #1080 的实例侧 Head 可订阅并判断公开消息，只有需要执行时才使用既有 dispatch；之后仍由 Host 原有准入队列处理。Timeline 是公开消息日志，Host 队列是执行准入，两者前后衔接而不重复 dispatch。Head 需要自行设计实例生命周期的取消、恢复和防重复效果；取消不能撤销已经发生的副作用。#1079 不改变现有 @ 或 Router 路径。

原 #1079 head `7920149a510a896c3cf1f8a28a787249f0d51453` 保留了移出的 `ChannelTimelineConsumer`、instance enrollment 和 lifecycle 测试，可作为 #1080 迁移参考，不能直接恢复其 Channel 内逐实例调度。#1080 应先合并本队列提交，再将消费逻辑放入 Pet Instance 所带 Head，处理 instance 说明、模型调用导出位置及关闭/重开策略；在替换旧 Router 前不得同时启用两条派发路径。

真实 PostgreSQL 多连接测试需独立测试数据库和 `PINPAWO_TEST_POSTGRES_URL`；PGlite 单连接不能证明跨连接的提交顺序。

## 旧版开发数据库

曾运行原 #1079 的数据库已记录 `0003_channel_consumption`，新版本的迁移名称不同，不能直接原地启动。需要另行制定保留原始数据和消费者身份映射的迁移；不要重置数据库或删除旧表以绕过此问题。main 的既有数据库和新建数据库不含该旧迁移。
