# Channel Timeline 消费基础

> 状态：消费存储与实例 activation 基础已实现，尚未接入运行中的 Channel Plugin；Pet Head 未实现。
> 更新：2026-11-10

本阶段落实 [#1078](https://github.com/pinpawo/pinpawo-agent/issues/1078) 的后端消费基础，
并对齐 Channel-owned Pet instance，供后续 Pet Head 接入。
当前 @ 与旧 Router 的行为不变。Channel Plugin 不创建或启动 `ChannelTimelineConsumer`，
没有新增 Head 配置、Reopen 自动唤醒或 Reopen cutoff 策略；新路径接入时必须替换旧 Router，不能重复派发。

## 实例进度与 activation

- `channel_consumptions` 以 `(channel_id, pet_id)` 保存一个稳定实例的公开消息消费进度，与执行 session 分开。
  一个实例只有一个不可变 owner Channel；definition 可复用，Pet id 不可回收。
- 当前成员与消费权限来自 registry 的 live owner 投影，不来自 raw Pet membership rows。
  迁移只建立消费表，不把旧 Pet membership 当作实例权威，不删除历史成员或改写消息。
- registry 在 create、restore、Reopen 的 runtime assembly/live 可见之前调用 Channel 的窄准备接口。
  Channel 持追加消息使用的同一行锁，只为缺失进度读取已提交 Timeline 末尾并建立基线；空 Channel 为 0。
  已有 `after_sequence` 原样保留，普通进程重启不把它移到当前 tail。
- `activation_id` 是一次开放期的独立 fence，不是实例 identity 或可重入 membership。
  每次准备和 Close/Remove 开始均更换 token，不移动 cursor；旧 batch 的 CAS 不能确认新 activation。
  重复添加当前 Pet 成员投影不创建、重置或激活进度。
- 消息追加、enrollment/fence、ack 和人类成员管理复用 Channel 行锁。PostgreSQL sequence 分配
  不代表事务提交顺序，因此同 Channel 追加必须串行，防止低序号消息稍后提交却被 cursor 越过。
  Host 停止不在 Channel 数据库事务中执行；Channel 准备也不反向在事务内查询 registry 数据库。

保存旧 cursor 只是基础存储能力，**不表示已经决定生产 Reopen 消费策略**。
Reopen 后补读全部未消费消息、跳至恢复时 cutoff，或区分关闭前积压与关闭期间消息，
仍需在生产 Head 可触发前确定。当前没有永久 inactive/policy 状态，也没有新增产品恢复操作。
准备发生在 live 之前，不发成员加入事件来假装完成 activation wake；assembly 期间的积压何时唤醒
属于后续生产接入。基础消费者的显式 `wake()`/`start()` 不能直接当作已定义的 Reopen 产品行为。

## 单个 consumer 对象内的调度

消费者需要显式创建并 `start()`。启动先订阅 Channel 事件和内部 activation 取消，再分页发现当前
live 实例及进度；不依赖 Console 在线。固定窗口默认 300 ms，允许 0–60000 ms；每批默认 50 条，
上限 200 条。这些是基础类参数，不是已发布的 Head 产品默认值。

调度保留在 Channel 内，不引入 MQ、持久任务或全局并发队列。每个 Channel/Pet 只有一份状态：

- 唤醒设置 `dirty`；同一固定窗口内重复唤醒不新增定时器，也不延长窗口。
- 窗口到期清除这次 `dirty`，`processing` 持有真实处理 Promise 和取消信号。
- 处理期间的新唤醒只重新标记 `dirty`，同一个 key 不并行处理，不同实例独立推进。
- 成功后如果有新唤醒或下一页，真实 Promise 结束才启动一个后续固定窗口。
- 失败清除本次处理期间累积的唤醒，保留 cursor；后续显式唤醒才能再试。
  旧 activation 已取消时，不清除后续有效 activation 的显式唤醒。

callback 收到原始消息、作者、引用、附件及冻结的批次末尾，消息不被合并或改写。
末次 awaited 读取之后，开始 callback 前再次同步核实 live owner 和 exact activation。
成功后只以 CAS 推进到冻结末尾；处理期间的新消息或 callback 发出的公开回复属于后续批次。
callback 不是执行入口：本层尚无相关性、@、自输出或可信来源过滤，不可直接 dispatch。

## 取消、停止与失败

Close/Remove 的 admission fence 开始后，Channel 内部同步清除等待窗口、abort 在途 signal，
随后更换持久 activation token。它不等待最终 `pet.closed`/`pet.removed` 或 `channel.member.left` 事件，
也不把临时 Close 冒充永久 Remove。Host stop 与短存储 fence 均须 settled 成功，才能写最终 marker；
任一失败或结果未知不能报告关闭/移除成功。

registry 不等待任意 consumer callback，仍由既有 Host runtime close 证明停止。
callback 必须在每个外部 effect 前核实取消及 exact activation；abort 无法撤销已经产生的效果。
即使 callback 忽略 abort，也不会提前释放同一个 processing key，或让旧 batch 确认新 activation。
独立的 `consumer.stop()` 会等待真实 callback Promise；callback 一直不结束时，这个 stop 也一直等待。
已 stop 的 consumer 对象不能重新 start；Pet 临时 Close 可以 Reopen，永久 Remove 不可复用。

callback、读取或 ack 失败均保留 cursor，不自动重试。一个实例失败不阻塞其他实例。
通知是提交后的 best effort，遗漏通知可能需要后续显式唤醒或重启。本层不提供分布式 worker lease。

## 保证与后续边界

消费进度表示 callback 已处理公开消息，不表示 Host 已接纳或 Pet 已完成。
单对象串行和持久 cursor 不保证跨进程或崩溃后的 exactly-once：effect 产生但 ack 尚未落库时崩溃，
重启仍可能处理同一批。本层不新增 Host 上下文接口，不读取或创建 Pet session。

当前生产路径可以保留 inactive 实例已接纳工作的最终输出为历史，但消费者没有持久的 history-only
资格标记。后续 Head 必须先解决可信来源、防确认循环和每次 effect 的 exact activation admission，
确保历史输出不会重新触发交接，再安装消费者。本轮不为未来策略扩展 message schema。

测试覆盖 SQLite、PGlite PostgreSQL 方言、真实 SQLite 文件重启、before-live cutoff、raw owner 隔离、
稳定 cursor、旧 activation CAS、取消、固定窗口、失败隔离、冻结批次、分页和并发唤醒。
真实 PostgreSQL 多连接 commit-order 测试需 `PINPAWO_TEST_POSTGRES_URL`；PGlite 单连接不能替代它。
