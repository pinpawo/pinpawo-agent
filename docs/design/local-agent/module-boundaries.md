# local-agent 模块边界（2026-09-09 draft）

跟踪 issue：#790。取代 #337，收编 #434。
基线：`c37a41a8`。

## 目标

**让 wire 变薄，让 agent 统一负责执行，让消费者只拿所需依赖。**

删死代码、移动目录是达成它的步骤，不是目标本身。`run/` 是否存在、顶层剩几个
文件、公开方法是不是恰好两个，都不适合作为验收标准。

## 问题

`services/local-agent` 有 113 个生产文件、21,366 行，其中 **75 个平铺在顶层**。
它们之间没有边界，可以自由互相 import，`serverTypes.ts` 被 11 个文件依赖，
事实上成了公共总线。这是"改一个字段要动一长串文件"的根因。

但**移动目录本身解决不了它**。真正要改的是依赖契约：现在每个消费者都声明需要
完整的 `ServerDeps`（28 处签名收全量，只有 2 处用 `Pick`，而实际读取的中位数
是 1–2 个字段），所以字段一变就波及全部 13 个消费文件。目录切分只是让这件事
看得见，不会自动缩小影响面。

## 为什么改名不够

最近六个 PR（#778 #779 #780 #782 #783 #784）净减 3,075 行，但 `ServerDeps`
**仍是 11 个字段，一个没少**。它们全是横向替换：

```
actor_id → petId → pet_id
PetLocalConfig → PetConfig
localServerHandlers → serverHandlers
```

更能说明问题的是 `runtime.ts:132`——刚把 `PetConfig` 读进来，转手就拍平成散
字段塞进 `ServerDeps`，于是下游 23 处读 `deps.petId`，只有 3 处读
`getPetConfig()`。等于当场把要修的问题又造了一遍。

---

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

### `ServerPeer` 是识别信号，不是归属判据

`chatSessionAdapter`（600 行）、`agentChannel`、`agentGraphService` 对
`ServerPeer` **零依赖** —— 它们只接受 `emitEvent` / `emitToolEvent` 回调，完全
不知道事件最终走 WebSocket、stdio 还是内存。**这个性质要保住**：它意味着同一套
执行编排可以给任何入口用。

但"引用了 peer"只能识别传输耦合，**不能直接决定整个文件的归属**。
`serverChatHandler` 就是反例：它有 29 处 peer/协议引用，却有 **43 处执行生命
周期引用**（inflight 排队、AbortController、`settleAbortedRun` 收尾、过期请求
判断、异常处理）。整体划进 `wire/` 会把更重的那半也带走，`agent/` 只收到一个
adapter，真正的 run 职责仍散在外面。

**这里要拆职责，不是整体搬迁**：
- 协议应答、事件发送 → `wire/`
- 排队、取消、收尾、过期判断 → `agent/`

### `serverHandlers.ts`（795 行）要拆

按操作职责拆分，不把整个协议 handler 搬进业务模块：

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

wire 保留连接与请求的路由关系，把断连转换成取消对应执行的调用；agent 只接收
不透明的请求/所有者标识或 AbortSignal，不读取 ServerPeer。Host 关闭时停止接收
新工作、取消活跃执行、等待收尾，再释放资源。普通对话与 resident dispatch 都要
覆盖；仅把 serverChatHandler 搬走不算完成。

来源：[ThreadInvocationCoordinator](../../../services/local-agent/src/threadInvocationCoordinator.ts)、
[residentPetHost](../../../services/local-agent/src/residentPetHost.ts)。

### 其他两处归属

- `localServerTransportApi.ts` 是 **52 行纯 re-export 的包出口**，不进任何模块，
  与 `hostRuntime.ts` 并列在顶层。
- `residentPetAgentSessionTransport.ts` 名字里有 transport，实际解析
  `/agent-session/pets/<id>` 路由 → `wire/`。

---

## 二、依赖契约（真正缩小影响面的那一步）

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

### Graph 复用：优先采用简单方案

优先尝试在同一 Host 内复用构建配置一致的 compiled graph，构建依赖变化时再创建。
先采用当前配置对应的单份实例，不预设全局缓存、多版本缓存或新的生命周期管理框架。
若实际需要同时持有不同构建配置，再根据调用场景决定最小持有范围。

实现前区分三个问题：

1. 节点闭包捕获的模型、context window、checkpointer 等属于构建依赖；变化后必须
   替换 graph，或明确改为调用时注入。不能只按 threadId 判定是否可复用。
2. registry 装配包含绑定 threadId 的 artifact discovery toolkit；graph 复用不能
   让 registry、消息、resume、signal 等调用数据跨会话串用。
3. graph 并非天然无可变数据：[runTermination](../../../packages/pet-agent/src/agent/orchestrator/runtime/runTermination.ts)
   的 pendingErrors Map 要验证失败、取消和关闭后的清理，以及不同执行之间的隔离。

正在运行的执行及其 abort 收尾继续持有原实例；配置更新后的新执行使用对应新实例。
若复用需要复杂的失效缓存或大幅改写节点，允许暂时保留每次构建并记录具体原因。
**判断依据是实现简单、配置正确、状态隔离，不以 compile 次数作为架构验收指标。**

三个问题都已核实成立，实现前必须逐一处理：

1. 闭包确实捕获构建依赖 —— `createCompactContextNode({ config })`、
   `createRunSupervisorNode(config)`、`createAnswerNode(config)`、
   `createCapabilityNode({ config })` 四处，加上 `checkpointer: config.checkpoint`。
   模型或 context window 一变就必须换实例。
2. registry 绑定 threadId 的 artifact discovery toolkit 仍在装配内。
3. `runTermination` 的 `pendingErrors` Map 由 `onNodeError` 写入、
   `throwRunFailure` 删除。取消或中断时后者可能不执行，条目就留在闭包里。
   每次构建时这无害；复用则会跨执行泄漏。

因此复用需要失效缓存加跨执行状态隔离验证。建议等执行所有权先集中——那时构建
依赖的变化点收敛了，失效条件才好定义。

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
| settleAbortedRun() | 保留，Runtime 决定结算语义，Host 负责调用和发布结果 |
| buildResumeCommand() | 保留必要的 LangGraph Command 适配，是否内联由调用边界决定 |

公开接口按消费者需求收窄。删除 run() 不会自动消除重复装配：streamEvents 当前也
接收完整 setup 并创建 graph；装配与复用由第二节的依赖契约解决。

---

## 四、interrupt 语义与 checkpoint 适配

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

hasPendingContinuation 已不是基线里的方法名。剩余 acceptsResume 等框架适配先收在
agent 内部，不泄漏到 wire；若要变成 Runtime 公共语义接口，需按 interrupt 设计
单独确认契约，不能靠搬目录或引用 #772 宣称已经解决。

---

### 目录切分的已知障碍

批量改写 import 时**不能按 basename 建立"文件 → 新目录"映射**：basename 在这个
包里不唯一。`modelProfiles.ts` 同时存在于 `src/` 和 `src/testing/`，
`toolkitInventory.ts` 同时存在于 `src/toolkits/` 和 `src/testing/`，`index.ts`
每个 capability 目录下都有一份。按 basename 匹配会把 `./modelProfiles` 解析成
`./testing/modelProfiles`。

正确做法是逐 import 解析：从该 import 语句**所在目录**出发解析出被引用文件的
真实路径，再按那个文件的新位置重算相对路径。

## 五、做法

按同一范围完成替换并删除旧入口，避免新旧协调或依赖表达长期并存。
本次计划一个 PR 落地；提交可按依赖契约、职责迁移、机械移动组织，便于审查。
同批处理 #434：gitTools 从 toolkits/local 拆出独立目录，不扩展其行为。

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
- [ ] interrupt 通知、按 id resume、abort 后 pause/interrupted 的既有语义保持
- [ ] 若复用 graph：模型/构建配置变化生效，跨 thread 不串消息或工具绑定，失败/取消后无残留执行状态
- [ ] 文档、类型检查及受影响的执行/会话/resident 行为测试通过

不以顶层文件数、独立 run 目录、公开方法数或 graph 编译次数作为验收标准。
