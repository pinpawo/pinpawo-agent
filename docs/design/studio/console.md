# Studio Console

状态：当前实现设计，2026-10-05。

Console 是独立纯前端，消费 HTTP Plugin 和领域 Plugin API，不是 Plugin，也不访问
Studio core、Agent、checkpoint、hook 或 SQLite。连接地址与 Bearer 是运行时输入。
固定页面没有动态前端 Plugin 系统；缺少某领域 Plugin 时该页显示 unavailable。

| 页面/操作 | API 与范围 |
|---|---|
| Channel（默认页） | `/channels/*`；消息与协作语义统一见 [Channel 设计](channel-addressing-and-execution.md)。 |
| 直接 Pet 请求 | `/pets`、`/dispatch`、`/dispatch/queues`；只对自身 HTTP 失败请求创建新的 retry dispatch。 |
| Scheduler | `/scheduler`、`/scheduler/events`；创建一次性计划与取消未触发计划。 |
| Notice | `/notices`；读取持久通知，不控制运行。 |
| Trigger | `/triggers`、`/triggers/events`；查看定义、交付历史与外部接收说明。 |
| Knowledge | Project Files 的 `/knowledge*` 只读 Markdown；显式刷新，不提供编辑或图索引。 |

## Channel 布局与交互

左侧 232px 列表、中间独立滚动消息与固定 composer、右侧可折叠 320px Activity。
低于 1101px 时 Activity 为 modal drawer，低于 701px 时列表也为 drawer。
抽屉和创建弹窗限制键盘焦点，Escape/背景关闭，关闭后恢复触发控件焦点。

正文完整显示；宽代码在块内滚动。普通连续笔记可视觉分组，执行请求、输出与引用
保留独立边界。每条消息保留稳定 ID，引用只展示一层摘要并定位原文；Activity 按
invocation 定位请求/输出。技术身份放在展开详情和复制操作。
登记 label 用于显示，同名选择器携带身份，移除作者标明历史身份。

Reply 预选、改选/清除、全局队列、失败与审批历史按 Channel 设计处理。
未发送草稿不派发；重复提交保护只防本次表单并发提交，不承诺网络重试恰好一次。
阅读旧消息时 SSE 不移动阅读位置；切换全局页保留位置，切换 Channel/Host 清除草稿、
引用与目标。拒绝提交保留草稿，不自动重试。

## 连接与观察

每个 Host/credential 只有一个 SSE 连接；刷新与 POST 不重建它。
先建立观察再允许提交，订阅后刷新领域 snapshot/history；瞬时失败有限退避重连，
鉴权失败要求更正凭证。token 保存在浏览器 session，不写入 URL。

SSE 是 live-only，断线后重读各领域自己的持久事实，不用事件流重建历史。
Channel 完整读取分页，执行时补读观察。未结束的旧 Host 记录、丢失的 live 观察显示
status unknown；已知终态保留。completed 不代表业务目标验收。
直接 dispatch 的 receipt 只表示接纳，不是可恢复 execution handle。

Console 不接管独占 TUI WebSocket，不读 checkpoint，也不提供审批、resume、cancel
或其他 Agent Session 控制。Channel Review 仅为历史通知，当前审批在原 Pet TUI/session。
Agent Session HTTP 工具是独立操作入口，见 [API](../../reference/api/studio.md#host-agent-session-http)。

## 验证与迁移

启动与验证命令集中在 [应用 README](../../../apps/studio-console/README.md)。
确定性浏览器覆盖长正文、默认 Reply、真实队列、失败/断线/重启与 1440/900/390/320px，
不替代真实模型验收；按 head 的运行记录见 [#904](https://github.com/pinpawo/pinpawo-agent/pull/904)。

Kanban 专属页/API/消费者已退役；迁移只按[配置步骤](../../studio/configuration.md#retired-kanban-workdirs)
手动操作，不清理用户数据。早期 Console 观察修复与阶段说明见[历史记录](../../history/studio/channel-evolution.md)。
