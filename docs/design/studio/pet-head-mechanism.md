# Pet Head：判断、派发与反馈

状态：设计草案。只调整 Head 的判断流程，不改变 Channel、Studio Dispatch 或 resident Pet Agent 的职责。

## 1. 总体结构

![Pet Head structure: committed Channel Timeline messages reach the Head through the Studio EventBus; Head requests execution through the Channel port and Studio Dispatch; resident lifecycle returns through the same bus; Head reads only its own bound Agent Session.](assets/pet-head-mechanism.svg)

- **Channel Timeline → Studio EventBus → Head。** Human 和 Pet 写入同一条 Timeline；Channel 只在消息提交后发布 `channel.message.created`。在线 Pet 实例由自己的 Head 订阅 `source=channel, topic=channelId`，过滤自己发的消息。Channel 不替 Head 选消费者；live bus 不向离线 Head 补投。
- **Head → Channel port → Studio Dispatch → resident Pet Agent。** Head 做判断；现有 Channel port 校验成员和原消息、绑定 Session、传递附件和去重键；Studio 和 resident Pet 负责接纳、排队、执行与审核。
- **resident Pet Agent → Studio EventBus → 本实例的 Head。** Studio 已发布以 Pet 实例为 topic 的 `dispatch.*` 生命周期；本草案给 Head 加一条只观察的订阅。另有独立的只读 Session 访问，不用事件负载代替 Session。

当前实现：[Timeline 写入](../../../plugins/channel/src/channelService.ts)、[Channel port 与输出桥接](../../../plugins/channel/src/channelPlugin.ts)、[Head 与执行器](../../../packages/studio/src/host/petHead.ts)、[Studio 装配](../../../packages/studio/src/host/buildStudio.ts)、[EventBus](../../../packages/studio/src/studioEventBus.ts)、[Studio Dispatch 与 Session 入口](../../../packages/studio/src/createStudio.ts)、[Resident Pet Dispatch](../../../services/host/src/host/residentPetDispatch.ts)。

## 2. 每条 Timeline 消息先判断该不该接

Head 的第一次判断只用原消息、Channel 上下文和 Pet 职责，不预读 Session。输出用互斥分支表达，避免再用 `ignore` 表示「不派发」：

| 第一次判断 | Head 下一步 |
| --- | --- |
| 不接 | 结束。不回复、不读 Session、不派发。 |
| 接，只需答复 | 需要开口才写 Timeline。不调用 Dispatch。 |
| 接，需要查证进度 | 定位本 Channel 的具体执行，按需只读查证，再决定如何答复。不为回答进度伪造派发意图。 |
| 接，需要派发 | 产出一个可校验的原始意图，并区分「可独立执行」与「依赖当前执行的补充或更正」。再由宿主检查 Studio 接纳状态。可选回复不是派发回执。 |

「该我接」是必须经过的判断，不是额外的模型调用。不接与回复互斥；接了但暂时没有可靠结果，可以不回复。模型只表达意图，不能指定读取目标、选择 Session、修改队列或中断执行。

## 3. 需要派发，且已有执行时怎么办

1. **没有冲突**：独立任务通过原 Channel port 请求 Studio 接纳，Studio 决定开始或排队。依赖旧任务的补充或更正不因当前空闲就变成独立任务。
2. **有冲突，且能定位本 Channel 的具体执行**：宿主读取一次受限 Session 快照，再把事实和原消息交给同一个 Head 做一次追加判断。队列说明「有没有接纳上的冲突」；Session 帮助判断「是新任务、已有结果，还是对当前任务的更正」。
3. **Pet 忙，但无法定位本 Channel 内的执行**：不读别的 Session，也不把「看不到」当作空闲。独立任务仍由现有 Studio 接纳；依赖当前执行的更正不盲目排队，必要时明确说明尚未应用。

追加判断之后：

| 情况 | 第一版行为 |
| --- | --- |
| 独立的新任务 | 使用原消息的现有去重键，经原 Channel port 入队。不新增 Head 队列。 |
| 已被满足 | 有可核实的、已提交且可在本 Channel 使用的结果，明确覆盖这次要求，才不再派发。相同源消息的重送由原有去重处理，不和不同消息的语义相似混用。 |
| 还在做，看起来会覆盖 | 不把预期当成已满足。独立请求仍走正常接纳；不跟随一个未完成的执行来静默吞掉新请求。 |
| 补充或更正 | 能明确整理成独立后续任务才排队；必须修改正在执行的内容时，第一版不自动打断、不盲目重跑，并说明尚未应用。 |

**提交前重新校验。** 用已验证的 Pet 实例、Channel scope、Session 和 `invocationId`（Dispatch 侧的 `dispatchId`）关联本次观察；若证据只属于某一具体运行尝试，还需要能核实其运行身份。Session 相同不等于执行相同。若 A 已失败、停止、换成 B，或状态不可验证，不能拿 A 的快照来操作 B，也不能据此说新请求已覆盖。即便 A 在复核时仍在跑，也可能随后失败；单个 `completed` 事件不是结果覆盖证据。没有可核实的结果时，独立请求回到原接纳路径，依赖旧执行的更正则不自动应用。

## 4. Session 查证和调用预算

- **宿主按条件决定是否读，模型读完再判断。** 复用 Studio 的 `petSessions.snapshot`，不把通用 Session 查询绑定成始终可用的 LLM tool，不把读操作藏进最终决策的 handler。第一版不需要通用 ReAct loop；JSON-only 模型也可以做同样的两段结构化判断。
- **范围由宿主决定。** 读取前后核验实例仍在线、Channel 绑定与权限没变。仅返回这次执行的精确关联、采样时间、有限的可公开消息或已交接内容，以及能证明属于本轮且可公开的计划。旧 checkpoint 的计划、未交接的子 Agent 内容、TUI 私聊、工具入参和内部结果不作进度证据。缺失、截断、权限变化或超时显式标记，不猜进度。
- **每条消息最多两次 Head 模型适配器调用、一次 Session 读取。** 两次是实际的 Head 层调用上限，不是每阶段各自的重试额度。优先按已验证的模型能力选输出模式；若允许格式 fallback，它也占同一额度，不能另开重试循环。
- **共用一个判断截止时间。** 初判、回退、读取和复判共享同一预算。在预算内为最终校验与安全降级留出时间。模型或读取超过剩余预算就结束等待，拒绝迟到结果，不能让同一 Head 的下一条消息一直卡着；不改变 EventBus 的订阅顺序。初判无有效意图则不派发；有已校验的独立意图而查证不成，可退回正常接纳。依赖当前执行的更正不能用这个降级。实例下线或绑定失效则不再提交。已交给 Studio 的操作按真实回执解释，不把 Head 超时当成撤回。

现有入口：[队列与 Session 接口](../../../packages/studio/src/studioContract.ts)、[精确 Session 适配器](../../../services/host/src/host/residentPetSessions.ts)、[snapshot 投影](../../../services/host/src/conversation/agentSessionSnapshot.ts)、[Head 判断适配器](../../../packages/studio/src/host/petHead.ts)、[EventBus FIFO](../../../packages/studio/src/studioEventBus.ts)。图中的 `read_session` 表示这条宿主只读路径，不代表向模型开放的通用工具。

## 5. 反馈分别走现有链路

- **接纳与执行变化**：Studio 接纳回执回答是否接纳；已有 `dispatch.*` 经同一个 EventBus 到本实例的 Head。Head 只保存少量可关联的观察。事件可以帮助查证，不能覆写实时快照，不因为收到状态事件就直接回复。主动长时提醒和失败恢复另做，不在这版引入调度机制。
- **用户追问进度**：它是新的 Timeline 消息，先过同一个职责判断。定位到执行后，Head 可按需读 Session，明确区分「还在跑」「等待输入」「已停止」「失败」和「目前查不到」。若用户同时追加或更正工作，仍按派发冲突的规则判断；同一消息复用读取结果，不再读第二次。
- **执行的公开回复**：继续走 resident `dispatch.message` → 已有 Channel 桥接 → Timeline。Head 不从完成事件再发同一结果，不转发未公开的中间内容。派发接纳、执行完成、结果发表是三件事。

## 6. 第一版验收

- 忙时收到不归本 Pet 的消息：零 Session 读取、零回复、零派发；普通直接答复不读 Session。
- 独立请求正常派发；跨 Channel 的忙碌不允许读外部 Session。明确的进度问题可走只读，不产生新运行。
- 命中当前执行才查证；确认覆盖与仅有相似计划分别验证；A 在复判前失败、复判后才失败、或同一 Session 已切到 B，都不会因旧证据静默吞掉独立的新请求，也不会操作 B。
- 当前更正不能独立执行时不自动打断、不夸称已修改；晚到的事件不能覆盖实时观察，执行的公开回复不重复写入。
- 格式 fallback 不突破两次调用；用脚本模型模拟慢调用、慢快照、实例下线及绑定变化。验证同一 Head 的下一条消息按时推进，且晚到结果不会提交回复或派发；其他订阅者不受阻。

非目标：新增调度器、Head 队列或第二套总线；替换 Studio Dispatch；让 Pet Agent 反向依赖 Head；修改 resident Agent 的执行、审批和中断接口。
