# Studio Independent Host Runtime

状态：当前实现边界，2026-10-05。本文维护进程、装配、资源和存储所有权。
Host / Agent / Capability / Toolkit 关系以[领域关系](../host-agent-capability-toolkit.md)为准，
resident 的端口契约以 [Resident Pet Host Ports](../agent-runtime/resident-pet-host-ports.md)为准。

## 进程与依赖

```text
Chat Host                         Studio Host process
  Chat/TUI session stack            resident Pet runtime(s)
          \                         /       │
             pinpawo/host-runtime           ├─ host Agent Session listener
                                            └─ Studio core + HTTP Plugin
                                                   dispatch/event/hook
```

Chat 与 Studio 可分别启动；共享 Capability、Toolkit、模型和 checkpointer 装配方式，
不共享 session、transport handler、进程内运行槽或 checkpoint writer root。
Studio 进程的 Agent Session listener 属于 Host interaction adapter，提供 HTTP/SSE 与
WebSocket/TUI；Studio control plane 由 HTTP Plugin 提供，不是 Chat mode。

```text
host 公共 surface ← @pinpawo/studio ← concrete Plugins
                          ↑ resolver 注入
                  application composition root
```

`host-runtime` 分开提供 resident 与 interaction builder，组合成 ResidentPetHost。
Studio Host 外层管理资源，Studio core 只持有 PetDispatchPort；不构造 Agent Session、
不读取 checkpoint、不构造 LangGraph command。TUI 连接 Host 的 Pet listener。

Plugin 按配置名由外部 StudioPluginResolver 解析；core 不 import、扫描或安装具体 Plugin。
Plugin 可提供 Toolkit definitions，Host 与其他来源合成 inventory，Capability 按 uses
选择工具。Resolver 不返回 Capability，Plugin 不注册或装配 Pet，不取得其私有 runtime 引用。
每 Pet 的能力目录及 PET.md 布局见[配置](../../studio/configuration.md)。

## 装配与生命周期

- 首次 init 一次性提供 Toolkit sources，随后新增 source 明确失败，不能静默复用半装配 inventory。
- 并发 init 共用初始化；shutdown 与 init 串行，开始关闭后不允许重新 init。
- 所有配置 Pet 在监听前 eager start，无 lazy/disabled 回退。任一 Pet/interaction 启动失败，
  关闭本轮已建资源；Pet 启停不定义次序，但等待所有 close settle。
- Plugin 按配置顺序 start；失败时包含失败者的已启动前缀逆序 stop。
- Studio core shutdown 停止接纳并逆序停止 Plugin、关闭总线，不取消已接纳的执行。
  StudioHost 随后 close 所有 resident，最后释放共享 Toolkit/lease；durable interrupt
  已结束当前 invocation，shutdown 不删除 checkpoint continuation。
- transport 断开只删除其连接路由，不关闭 resident；SIGINT/SIGTERM 关闭本 Host 并等待资源释放。

启动顺序是：取得 writer lease → 解析配置/已安装扩展 → 装配 inventory 和所有 resident →
启动 Pet Agent Session listener 与 HTTP Plugin。扩展加载前须已取得 lease，竞争失败的 Host
不能先执行 Plugin factory / Capability entry。独立 CLI 是包内的 pinpawo-studio。

## 持久化所有权

| 数据 | 所有者与限制 |
|---|---|
| Chat/TUI checkpoint root | Host，按 runtimeConfig 和 Chat adapter 定位。 |
| Studio checkpoint root | Host，`resolveHostCheckpointPath(runtimeConfig, 'studio')`；与 Chat 独立。 |
| Session 注册、活动 session、checkpoint | resident / Agent Session，不进入 Studio registry。 |
| Plugin 业务历史 | 各 Plugin 的独立存储，不借用其他 Plugin 数据库。 |
| 事件总线、队列投影、幂等接纳记录 | 当前进程，不能当作持久恢复来源。 |

Host 在 Capability assembly 前取得 checkpoint root 生命周期 writer lease。
存活 owner 存在时启动失败，dead-owner 恢复由独占 guard 串行。
FileSaver mutation lock 覆盖 checkpoint 发布、pending writes、thread delete 与 GC；
constructor 不执行删除型 GC，Host 取得 lease 后才在 mutation lock 内做启动 GC。
mutation lock 保证一次事务，不允许多个 Host 同时驱动同一 thread。

## dispatch、事件与审批

[Studio API](../../reference/api/studio.md) 定义 dispatch request/receipt：
可信进程内 Plugin 可指定保留的 session 与 domain scope，HTTP wire 不接受这两项。
未定向请求在获得执行权时读取活动 session；定向请求固定目标并在出队时校验。
receipt 只确认接纳，不能作为 completion/status/output/error、取消或 resume handle。
producer metadata 仅用于相关数据，不提供工具身份或 transport 路由。

每 resident Pet 只有一个运行槽；活动操作不抢占，空闲时 conversation 优先于 dispatch。
Studio registry/listPets 只含存活 Pet 的 id/name 与 dispatch port，不公开能力清单或活动 thread。
全局队列是 resident 的只读瞬时投影；Channel 的消费语义见[统一设计](channel-addressing-and-execution.md)。

Studio 事件总线按 subscriber 隔离 FIFO，并按 Plugin lifecycle owner 释放订阅。
异步 HTTP handler 不阻塞其他 subscriber；HTTP 是普通 subscriber，不建立第二条总线。
关联的 lifecycle 可以包含本轮 request、公开 reply、waiting 投影与失败，仍不等于完整
Agent conversation stream。领域 Plugin 对结果的持久保存负责，事件没有 durable replay。

Pet 保留 humanReview/sessionAuthorization。原生 interrupt 与 continuation 位于 checkpoint，
当前审批通过同一 Pet 的 Agent Session 投射/恢复；core 和 Plugin 不维护第二份审批状态。
Host listener 在连接阶段选择 Pet，复用原 AgentClientMessage / AgentServerMessage。
具体 transport 与安全边界见 [HTTP Plugin](http-plugin.md) 和
[Agent Session HTTP](agent-session-http.md)。Channel 的历史通知和 TUI 恢复回程限制见统一设计。

## 验证与未实现范围

生命周期 rollback、writer lease、FileSaver mutation、定向 session、TUI 优先级与事件隔离
由 Host / Studio 测试验证；Channel 的行为回归与按 head 验收记录见统一设计的验证入口。
本次文档整理不重新宣称全仓库测试通过。

durable event log/replay、跨重启执行保证、Plugin 自动安装/版本管理不在现有契约中。
时间与事件调度由[独立 Automation Plugins](automation-plugins.md)负责；不扩大 core。
Wiki 更新需要明确请求。仅合并代码不会迁移用户配置或更新任何正在运行的服务。
