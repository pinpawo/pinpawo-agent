# local-agent 模块边界（2026-09-10 draft）

跟踪 issue：#790。取代 #337，收编 #434。
实现核对基线：`09b8dc5e`。本文为待实施设计；目标行为不代表当前实现已完成。

## 目标

**让 wire 变薄，让 agent 统一负责执行，让消费者只拿所需依赖。**

删死代码、移动目录是达成它的步骤，不是目标本身。`run/` 是否存在、顶层剩几个
文件、公开方法是不是恰好两个，都不适合作为验收标准。

## 问题与范围

当前执行编排、会话操作和协议应答混在 handler 中，多个消费者接收完整 ServerDeps，
即使实际只需要其中少数字段。配置被展开后沿调用链传递，模块间缺少明确的依赖方向。
改名和移动目录只能改善可读性；本次重构同时收窄依赖契约、集中执行职责，并删除
被替换的旧路径。

范围包括 local-agent 的装配、执行、协议和会话边界，以及 #434 的 git toolkit
目录整理。interrupt/resume 的领域语义继续由 pet-agent 拥有；不新增运行状态体系。

## 一、目标结构

```
wire/           协议解析、连接鉴权、请求路由、事件发送
agent/          装配、执行协调、流事件转换、取消与收尾
conversation/   对话记录、列表、恢复
config/         配置读取、校验、默认值
toolkits/ commands/ capabilities/   ✅ 已存在
```

调用链（接口示意，不要求立即引入新类）：

```
wire → agent.execute(request, { signal, emit }) → pet-agent
```

- **wire** 把客户端消息变成执行请求，把事件发回客户端
- **agent** 统一管理一次执行的生命周期，内部保留装配、图适配等实现文件
- **pet-agent** 决定 interrupt / resume / abort 后是否还有任务可继续等运行语义

### 不设独立的 `run/`

装配和一次 invoke 的编排共同完成执行，生命周期差异用模块内部的函数和参数表达。
**保留 `run` 作为一次执行的概念**；出现独立消费者或稳定契约后，再考虑拆模块。

### Handler 按职责拆分

chatSessionAdapter、agentChannel、agentGraphService 当前不依赖 ServerPeer。
其中 turn 编排通过事件回调输出；迁移后继续保持执行代码不感知具体传输。

serverChatHandler 同时包含协议应答和执行生命周期管理，需要拆分：

- 协议应答、事件发送归 wire。
- 排队、取消、收尾、过期判断归 agent。

serverHandlers 同样按操作职责拆分：

| 职责 | 归属 |
|---|---|
| 消息解析、分发、响应编码 | wire |
| 对话记录、列表、当前会话及所选模型的持久化 | conversation |
| 模型配置读取、校验、策略持久化 | config |
| 模型切换、会话切换、compact 的执行准入与互斥 | agent |
| compact 调用模型并更新 checkpoint | agent，压缩算法继续由 pet-agent 提供 |

模型切换不是单纯读取配置：当前实现检查活跃执行、会话、checkpoint 和模型兼容性，
再更新会话记录。策略更新也包含“何时对执行生效”的规则，不能全部塞进 config。
见 [serverHandlers.ts](../../../services/local-agent/src/serverHandlers.ts)。

### 执行协调的范围与所有者

当前协调分散在三处；迁移时必须逐项确定去向，不能新增 execute 包装后保留全部旧控制：

| 当前机制 | 负责的范围 | 目标处理 |
|---|---|---|
| serverHandlers 的 activeChatOperations / sessionTransition | 执行与会话切换、模型切换、compact 的互斥 | 收入 agent 的操作准入；conversation/config 不各建一把锁 |
| ThreadInvocationCoordinator | 同 thread 替换请求，取消前驱并等待实际收尾 | 保留其语义，作为 agent 内部执行协调实现 |
| residentPetHost 接入的 coordinator / activeHostRuns | resident dispatch 与对话的准入、活跃执行、Host 关闭 | 保留 resident 调度策略，接入同一执行与收尾入口；不再复制一套执行生命周期 |

不同范围可以保留不同协调器，不强行合成一个全局队列。同一范围的准入和终结只能
有一个权威所有者；避免内外层重复入队、互相等待或双重发布终结事件。

#### 已核对的现状（实施前的事实基线）

- **准入判据只有一个信号。** 四处操作（模型切换、建会话、恢复会话、compact）
  现在都只看 `activeChatOperations`。它在 `afterSessionCommands` 里*包裹整轮对话*
  地加减，已经覆盖该轮内部注册的所有 inflight run，因此
  `|| inflightRequests.hasActiveRequest()` 是恒假的冗余项，已随本次核对删除
  （`hasActiveRequest()` 一并移除，它没有其他生产调用者）。收敛准入时不要
  重新引入第二个信号。
- **`InflightRequestController` 看不到 resident dispatch。** residentPetHost 直接
  用 `createInflightOperationRun`，从不注册进该 controller。判断“是否有活跃执行”
  时不能只问它。
- **待处理：串行保证是 per-peer 的，且 HTTP 绕过它。** `ServerSessionCommandQueue`
  按 peer 存 tail，只保证单 peer 内串行；而 HTTP 入口的 `resumeSession`
  （[httpHandlers.ts](../../../services/local-agent/src/httpHandlers.ts)）完全不经过
  `sessionCommands`，只受 `activeChatOperations` / `sessionTransition` 约束。
  跨 peer 以及 HTTP 与 WebSocket 并发时的准入归属，是本节收敛时要明确的真实边界。

核对这一节时发现，本节反复用到的「范围」从未被定义，6 个协调器各自隐含了不同的
scope（peer / 进程 / thread / Pet），这才是本节难以收敛的根因。更进一步，代码里连「一次执行」
与「一个会话」都还没分开（`buildChatSetup` 挂在 session 服务上却在装配执行，
`ServerDeps` 平铺了身份/配置源/长期服务/存储适配器），所以先要定 domain，
scope 是它的推论。

- domain 定义与证据：[local-agent domain 定义](./domains.md)
- 现状核对与 scope 草案：[准入分层](./admission-scopes.md)

本节的收敛以这两篇定稿为前提。

wire 保留连接与请求的路由关系，把断连转换成取消对应执行的调用；agent 只接收
不透明的请求/所有者标识或 AbortSignal，不读取 ServerPeer。Host 关闭时停止接收
新工作、取消活跃执行、等待收尾，再释放资源。普通对话与 resident dispatch 都要
覆盖；仅把 serverChatHandler 搬走不算完成。

来源：[ThreadInvocationCoordinator](../../../services/local-agent/src/threadInvocationCoordinator.ts)、
[residentPetHost](../../../services/local-agent/src/residentPetHost.ts)。

### 其他两处归属

- `localServerTransportApi.ts` 是 re-export 包出口，与 `hostRuntime.ts` 并列在顶层。
  已落地为 `wire/index.ts`；tsup entry key 保持不变，`pinpawo/local-server-transport`
  子路径与产物文件名不受影响。
- `residentPetAgentSessionTransport.ts` 名字里有 transport，实际解析
  `/agent-session/pets/<id>` 路由 → `wire/`。已落地为 `wire/agentSessionRoute.ts`。
- 迁入 `wire/` 时一并去掉历史 `local` 前缀（`localAgentProtocol` → `protocol`、
  `localServerPeer` → `peer` 等）。`toolkits/local/` 的 `local` 是「本机工具」的
  真实语义，不在此列，保留。导出符号名（`sendLocalServerPeerEvent` 等）是跨包
  公开 API，单独处理。

---

## 二、依赖契约

目录切分不会自动缩小字段变更影响面。**长期持有对象不意味着它的内容不变**：

| 类别 | 例子 | 所有权与更新规则 |
|---|---|---|
| Host 持有的服务及配置来源 | capabilityCatalog、toolkitInventory、artifactStore、toolkitRuntimeManager、petDocument | 服务长期持有；catalog/inventory 可提供更新后的内容；petDocument 当前由 Host 加载，不属于会话记录 |
| 会话数据 | threadId、modelProfileId、会话创建时间 | threadId 标识会话；modelProfileId 可以经准入检查在同一会话中更新 |
| 本次执行输入与配置快照 | 消息或 resume、AbortSignal、解析后的模型/能力/策略配置 | 执行获得准入后确定；同次执行及其收尾使用同一份配置 |

现状依据：
[toolkitInventory](../../../services/local-agent/src/toolkits/toolkitInventory.ts) 有 replace/updateAvailability；
[hostCapabilityCatalog](../../../services/local-agent/src/hostCapabilityCatalog.ts) 的 getSnapshot 读取当前配置；
[serverTuiSessions](../../../services/local-agent/src/serverTuiSessions.ts) 支持同会话模型切换；
[ServerDeps](../../../services/local-agent/src/serverTypes.ts) 持有 petDocument 和可更新的 review policy。

### 配置生效规则（目标）

- 排队中的请求在获得执行准入后解析配置，避免使用排队前已经过时的模型或策略。
- 配置更新成功后影响下一次获准执行；不回写正在执行的配置快照。resume 是一次新的
  执行，但仍须遵守 Runtime 对 pending interrupt 的恢复约束和已有模型兼容性限制。
- abort 收尾沿用被取消执行的配置，并移除已中止的 signal；不得重读最新配置，导致
  前一次执行用一套工具、收尾却使用另一套。
- 快照固定的是配置选择，不是复制服务内部状态。工具实时可用性和资源有效性仍由
  对应 runtime 检查；这一步不引入 PET.md 热重载或新的配置版本系统。

调用方只提交请求及必要的会话/取消/事件上下文，agent 内部解析并持有装配依赖。
消费者声明自身需要的字段或能力接口；优先复用已有类型，不为每个函数新增一层服务。
Host 的完整组装类型留在组合入口，业务模块不反向依赖它。

### Graph 复用

**先集中执行所有权，再在该所有者内复用构建配置一致的 compiled graph；构建依赖
变化时替换实例。** 默认只持有当前构建配置对应的一份实例，不引入全局缓存、
多版本缓存或通用失效框架。若调用场景确实需要多份实例，再明确最小持有范围。

以下实现事实决定复用边界：

| 当前实现 | 复用规则 |
|---|---|
| compactContext、runSupervisor、answer、capability 节点创建时捕获 config；compile 绑定 checkpointer | 明确捕获的构建依赖；模型、context window、checkpointer 等变化时替换 graph，或显式改为调用时注入 |
| registry 装配加入绑定 threadId 的 artifact discovery toolkit | registry 的会话绑定独立处理，不能因复用 graph 而复用错误 thread 的工具 |
| runTermination 的 pendingErrors Map 由 onNodeError 写入、throwRunFailure 删除 | 验证并处理取消/中断跳过删除的路径，保证长期复用时的清理和执行隔离 |

来源：[graph.ts](../../../packages/pet-agent/src/agent/orchestrator/runtime/graph.ts)、
[agentRegistryPreparation.ts](../../../services/local-agent/src/agentRegistryPreparation.ts)、
[runTermination.ts](../../../packages/pet-agent/src/agent/orchestrator/runtime/runTermination.ts)。

每次获准执行先取得配置快照，再选择或创建匹配的 graph。消息、resume、signal 等
仍按调用传入。执行及其 abort 收尾持有原实例；替换只影响后续执行，不修改活跃实例。
旧实例在不再被执行引用后释放，Host 持有的共享服务按 Host 生命周期管理。

复用需要明确的实例替换条件和状态清理规则，不必预设缓存系统。若实施证明复用需要
复杂缓存或大幅改写节点，可暂时保留每次构建，并在本文记录具体阻碍与采用的方案。
以实现简单、配置正确和状态隔离为准，不以 compile 次数作为验收指标。

---

## 三、agentGraphService 的入口

基线实现见 [agentGraphService.ts](../../../services/local-agent/src/agentGraphService.ts)。

| 方法 | 处理 |
|---|---|
| run() | 删除无人使用的结果包装 |
| invokeState() | 保留 abort settlement 使用的 invoke 能力；可收为 private |
| updateState() | abort settlement 和 compact 都在使用；保留必要能力 |
| getRawState() | 保持内部方法，供读取和 settlement 使用 |
| streamEvents() / readThreadState() | 保留执行与查询能力 |
| settleAbortedRun() | 移除 graph service 的公开包装；agent 执行入口在取消收尾时内部调用 pet-agent 的结算能力，返回 PendingInterrupt 或 null |
| buildResumeCommand() | 删除公开方法；执行入口接收 { interruptId, value }，在内部的 LangGraph 适配边界转换成 Command |

pet-agent 内部保留 settleAbortedRun 名称，表示取消后的结算；上述两个方法都不再
作为 graph service 的公开入口。统一的是对外数据契约与执行入口，不合并取消结算
和用户回复这两个不同动作，详见第四节。

公开接口按消费者需求收窄。删除 run() 不会自动消除重复装配：streamEvents 当前也
接收完整 setup 并创建 graph；装配与复用由第二节的依赖契约解决。

---

## 四、interrupt 契约与 checkpoint 适配

### 对外统一数据契约

目标是复用 pet-agent 已有的 interrupt domain，收窄 Host 需要理解的概念。
取消执行与回复 interrupt 是不同阶段的动作，不合并成一个操作，也不新增统一控制器。

用户回复在 Host 内保持结构化，到执行入口的 LangGraph 适配边界才转为 Command：

```ts
type InterruptResume = {
  interruptId: string;
  value: unknown;
};

// 执行入口内部的框架适配；不是 handler 的输入格式。
new Command({ resume: { [input.interruptId]: input.value } });
```

这个类型表达已有协议中的 id/value，不另造协议；优先复用已有合适的契约类型。
requestId、session 身份仍由外层请求携带，Host 保留 session/id 校验及过期请求处理。
review 与 pause 都经同一入口传递，Host 不解读 value；具体回复解析由 pet-agent
的 AgentInterrupt.resume(value) 负责。删除 handler 提前构造 id→value map、
turn 请求中把整个 resume 声明为 unknown、再调用公开 buildResumeCommand 的中间链。

### 取消结算复用 PendingInterrupt

当前 pet-agent 的 AbortSettlement 使用 paused / finished 两种状态。其中 paused
也可能携带已存在的 human_review，finished 仅表示没有待处理 interrupt，不能表示
任务成功完成。目标将这个窄接口收敛为：

```ts
settleAbortedRun(graph): Promise<PendingInterrupt | null>
```

- 返回 PendingInterrupt：已有或新产生的 interrupt，agent 统一报告 waiting，并沿
  interrupt.requested 链路发布；不区分 review 来源还是 abort 来源。
- 返回 null：取消收尾后没有 pending interrupt，被取消的执行报告 interrupted。
- 收尾失败：抛错，进入执行入口的失败处理；不能捕获后伪装成 null 或正常 interrupted。

该返回值只属于取消结算接口，不替代一般执行的 completed / waiting / interrupted /
failed 结果。正常执行读到 interrupt 也使用同一 PendingInterrupt 结构：

```text
正常执行 ───────────────────→ PendingInterrupt → waiting
取消执行 → Runtime 收尾 ────→ PendingInterrupt → waiting
                        └──→ null             → interrupted
用户回复 → { interruptId, value } → Runtime 恢复执行
```

取消信号发出后先等待原执行停止和流结算，再用其原配置及原 graph 完成收尾；收尾不
继承已中止的 signal，也不抢先启动后继执行。若取消到达前已产生 interrupt，保留
它的 id 和 payload，不擅自 resolve 或另造 pause。

### 区分用户 resume 与内部 checkpoint 推进

AbortSettlementGraph 当前的 resume() 回调实际调用 invoke(null)，用于推进到暂停
边界，不是用户按 interruptId 回复。将该内部回调命名为 continueFromCheckpoint，
保留 Runtime 对 checkpoint 更新和挂起位置的控制；它不调用 AgentInterrupt.resume。

AgentInterrupt 继续只负责各 kind 的 interaction 与回复解析，不增加取消、排队或
checkpoint 存储职责。执行入口统一调用和发布结果，底层 settlement 与 Command
适配仍各自实现，不为统一命名再套一层服务。

本节是跨 pet-agent / local-agent 的小范围契约调整。落地时同步更新 Runtime 导出、
普通对话与 resident dispatch 消费者及测试，删除旧 AbortSettlement 状态分支和公开
buildResumeCommand，不保留兼容别名。相应更新
[interrupt 设计](../agent-runtime/interrupt.md)，使公共契约与本节一致。

来源：[settleAbortedRun.ts](../../../packages/pet-agent/src/agent/orchestrator/interrupt/settleAbortedRun.ts)、
[AgentInterrupt](../../../packages/pet-agent/src/agent/orchestrator/interrupt/agentInterrupt.ts)、
[chatSessionAdapter.ts](../../../services/local-agent/src/chatSessionAdapter.ts)。

### 已有语义与剩余适配

#772 是 interrupt domain 的相关设计，不代表所有运行结局与快照适配都已完成。
基线中应区分已迁移的语义、仍需判断归属的适配和死代码：

| 关注面 | 当前状态与目标 |
|---|---|
| interrupt 解码 | readThreadState 已调用 pet-agent 的 readPendingInterrupt；继续由 Runtime 拥有 |
| abort 是否产生 pause | 已由 pet-agent 的 settleAbortedRun 决定；Host 不重复推断 |
| readGraphInterrupt | agentGraphService 中未使用的残留函数，可删除 |
| acceptsResume | 仍在 Host 读取 next/tasks；只判断能否投递 resume，不能据此推断 interrupt 或执行结局 |
| messages/currentPlan 与界面事件 | Host 仍需快照/事件投影，不因 interrupt 解码迁移而全部删除 |
| checkpoint 读写协议 | LangGraph BaseCheckpointSaver |
| 文件存储、写锁、GC | local-agent FileSaver |

剩余 acceptsResume 等框架适配先收在 agent 内部，不泄漏到 wire；若要变成 Runtime 公共语义接口，需按 interrupt 设计
单独确认契约，不能靠搬目录或引用 #772 宣称已经解决。

---

## 五、实施顺序

本次计划一个 PR 落地，按下列顺序组织提交；每个范围完成替换时删除对应旧路径：

1. 明确操作准入、thread 执行、resident 调度的所有者，收窄依赖契约，确定配置生效时点。
2. 拆分 handler，将执行与收尾接入统一入口；同步落实第四节的 resume/settlement 契约，
   删除旧状态分支，保留不同协调范围的既有行为。
3. 在执行所有者内部落实 graph 实例替换与清理规则，再启用复用。
4. 完成目录移动与 import 更新，删除死方法/函数，同批完成 #434 的 git toolkit 目录整理。

目录迁移时，按 import 所在目录解析被引用文件的真实路径，再根据文件的新位置
重算相对路径。不能仅用 basename 建立映射：modelProfiles.ts、toolkitInventory.ts
和 index.ts 在不同目录存在同名文件，可能被错误替换为 testing 或其他模块的文件。
机械移动不扩展工具行为，源码引用链接随文件移动一并更新。

## 六、验收

结构与依赖：

- [ ] wire 只做协议解析、鉴权、路由、事件发送，不持有执行调度状态
- [ ] agent 对 ServerPeer 零依赖；依赖方向与调用接口一起检查，不只检查类型名
- [ ] 消费者按所需声明依赖，完整 Host 组装类型不成为模块公共总线
- [ ] Host 服务、会话数据、执行快照在契约上可区分；调用方不再传递完整装配结果
- [ ] 每个协调范围有明确所有者，旧的同范围排队/收尾实现随替换删除

行为（通过现有测试及必要的行为测试验证，不测试目录名或文档措辞）：

- [ ] 同 thread 替换请求先取消前驱，等待其实际收尾后再启动；过期执行不覆盖新结果
- [ ] 会话切换、模型切换、compact 与执行保持原有互斥及兼容性限制
- [ ] 更新配置影响下一次获准执行；活跃执行与 abort 收尾使用原配置
- [ ] 普通对话和 resident dispatch 都经过既定准入与执行路径，终结事件不重复发布
- [ ] 客户端断连只取消其拥有的执行；Host 关闭停止准入、取消并等待收尾后释放资源
- [ ] review/pause 的回复都以 id/value 进入执行入口，Host 不解读 value；错误 session/id 仍被拒绝
- [ ] 正常执行和取消结算产生的 PendingInterrupt 经同一通知链发布；取消前已有 interrupt 保持原 id
- [ ] 无待处理 interrupt 的取消报告 interrupted；settlement 抛错走失败路径，不被吞成 null
- [ ] 内部 checkpoint 推进不消耗用户 resume value，也不重新执行被取消的模型/工具工作
- [ ] 普通对话与 resident dispatch 同步删除旧 paused/finished 结算分支，interrupt 设计与实现契约一致
- [ ] 若复用 graph：模型/构建配置变化生效，跨 thread 不串消息或工具绑定，失败/取消后无残留执行状态
- [ ] 文档、类型检查及受影响的执行/会话/resident 行为测试通过

不以顶层文件数、独立 run 目录、公开方法数或 graph 编译次数作为验收标准。
