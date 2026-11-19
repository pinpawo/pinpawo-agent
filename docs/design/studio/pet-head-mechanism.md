# Pet Head：Judgment / Execution / Feedback

状态：设计草案。当前 PR 只讨论接口和边界，不改变运行时。

## 1. 总体结构

![Pet Head structure: committed Channel Timeline messages reach the Head through the Studio EventBus; Head requests execution through the Channel port and Studio Dispatch; resident lifecycle returns through the same bus; Head reads only its own bound Agent Session.](assets/pet-head-mechanism.svg)

- **Channel Timeline → Studio EventBus → Head。** Human 和 Pet 写入同一条 Timeline；Channel 只在消息提交后发布 `channel.message.created`。在线 Pet 实例由自己的 Head 订阅 `source=channel, topic=channelId`，过滤自己发的消息。Channel 不替 Head 选消费者；live bus 不向离线 Head 补投。
- **Head → Channel port → Studio Dispatch → resident Pet Agent。** Head 做判断；现有 Channel port 校验成员和原消息、绑定 Session、传递附件和去重键；Studio 和 resident Pet 负责接纳、排队、执行与审核。
- **resident Pet Agent → Studio EventBus → 本实例的 Head。** Studio 已发布以 Pet 实例为 topic 的 `dispatch.*` 生命周期；本草案给 Head 加一条只观察的订阅。另有独立的只读 Session 访问，不用事件负载代替 Session。

当前实现：[Timeline 写入](../../../plugins/channel/src/channelService.ts)、[Channel port 与输出桥接](../../../plugins/channel/src/channelPlugin.ts)、[Head 与执行器](../../../packages/studio/src/host/petHead.ts)、[Studio 装配](../../../packages/studio/src/host/buildStudio.ts)、[EventBus](../../../packages/studio/src/studioEventBus.ts)、[Studio Dispatch 与 Session 入口](../../../packages/studio/src/createStudio.ts)、[Resident Pet Dispatch](../../../services/host/src/host/residentPetDispatch.ts)。

## 2. Judgment：一个 Head，两种 LLM tool 语义

现在的 Head 先做一次结构化判断。`jsonSchema` / `jsonMode` 路径拒绝 tool call；`bindTools` 路径只绑定 `pet_head_decision`，它是输出声明，不执行读取。仅在 TypeScript 层预读 Session 再套一条进度回复，不能让 Head 自己决定何时找证据。

| LLM tool | 宿主行为 | 后续 |
| --- | --- | --- |
| `read_session({})` | 执行一次只读查询。参数严格为空；模型不能传 Pet、Channel、Session、文件或动态查询参数。 | 以匹配调用 ID 的 tool result 返回投影，Head 继续判断。 |
| `pet_head_decision({ action, reply, intent, timing })` | 校验并接收最终声明。不执行工具，不产生派发回执，不回填 tool result。 | 结束判断；把已校验的声明交给现有确定性执行器。 |

1. 每条合规 Timeline 消息既可以直接得出决定，也可以先读 Session。初始输入仍用 Channel 上下文、同 Channel 的受信队列引用，以及匹配的有限生命周期观察。不预读 Session，不增加“问进度”关键词或强制读取分支。
2. 工具模式下，每次模型响应只允许一个已知 tool call。若第 1 次调用 `read_session`，执行后保留原 assistant tool call 和同 ID 的 tool result，再做第 2 次模型调用；第 2 次只接受 `pet_head_decision`。首版每条消息最多 2 次模型调用、1 次读取，不并行，不递归；只在预算和生命周期信号允许时继续。缺失调用 ID、重复读取、混合调用、拒绝、截断或无效声明，不执行副作用。
3. **兼容按模型能力，不按用户措辞。** 对验证过支持调用和回填的 endpoint，Head 走 `bindTools` 及原生 tool-result 消息，不和 JSON response format 混用。先支持已验证的 `functionCalling` 配置；`bindTools` 方法存在、或者模型支持 `jsonMode` / `jsonSchema`，都不单独证明两个 tool 可用。对尚未验证、仅支持 JSON，或读取前明确拒绝 tool 参数的 endpoint，保留现有严格 JSON 决策路径；标记本轮无 Session 证据，不偷读且不假装已读。已进入工具往返后遇到协议错误，安全结束，不用丢掉结果的盲重试代替判断。

### 只读 Session 的范围和结果

- 在 Host 装配时给 Head 注入受限读取函数。由既有 Channel 绑定逻辑验证在线实例与成员权限，查当前已确认的 `(channelId, petId) → sessionId`，通过现有 Studio [`petSessions.snapshot`](../../../packages/studio/src/studioContract.ts) 读取该精确 Session。读取不创建、切换或缓存 Session；不回退到活跃 TUI Session、其他实例或其他 Channel。Head 不获得 `observe` / `review`、checkpoint 或 Capability 访问权。
- 绑定只证明读的是正确 Session，不证明其中每一项都可对该 Channel 公开。首版允许近期 `user` / `assistant` 消息中有可信 Channel 来源或公开记录的内容（角色、可公开文本、可用的 ID / 时间），例如与已回写 Timeline 的 `externalRef` 匹配的 Session 回复；同一 Session 的 TUI 私聊、合成派发提示均不自动纳入。只有 Session 接口给出 `currentPlan` 且宿主能证明其 Channel 可见性时，才另附任务和状态；缺少来源或可见性就省略相应内容。先筛选再截窗。原始 snapshot 只留在宿主：不传 tool 参数/结果、私有审批数据、子 Agent 内部记录、运行配置或路径，不从 checkpoint 补齐。
- 可公开的阶段性交接只在已提交为 Session 消息后读取，以稳定消息 ID 只保留一次。已经在本轮 Channel 上下文出现的同一条消息，用可信引用做去重；没有可靠身份或可见性就不补入。不重播流式片段或从内部 briefing 拼一条公开消息。
- 区分 `ok`、`empty`（没有符合范围的消息或计划）、`unbound`、`stale`（读取期间绑定或权限变化）与 `unavailable`（超时或读取失败）。无效结果不带 snapshot 内容或底层错误。宿主固定读取窗口、输出体积和截止时间；标明采样时间与是否截断。开始读取前核验绑定，返回前复核绑定和实例生命周期；即使底层 snapshot 无法取消，也丢弃迟到结果。
- `currentPlan` 是 Session 保存的计划事实，不是某条 dispatch 的进度。若队列、生命周期与 Session 没有可验证的关联，或者观察已过期，Head 可以说“Session 里记录了什么”，不能据此说“这次执行已做到哪一步”、已完成或估算百分比。

Session 侧的基线是 [Host 精确会话适配器](../../../services/host/src/host/residentPetSessions.ts)、[snapshot 投影](../../../services/host/src/conversation/agentSessionSnapshot.ts)、[会话消息投影](../../../services/host/src/conversation/transcriptProjection.ts)和[计划投影](../../../services/host/src/conversation/currentPlanProjection.ts)。本草案不将通用 snapshot 直接暴露给 Head。

## 3. Execution：声明不是执行权限

沿用现有 `HeadDecision`：`action` 是 `ignore | dispatch`；`reply` 是独立轴。空回复 + ignore 是不动作；非空回复 + ignore 是只回复；dispatch 必须有真实非空 `intent`，可同时回复。校验通过并检查未取消后，现有执行器经 Channel port 写回复和请求派发。两者独立记成功或失败：先写的回复只能是回应或下一步，不能宣称已经接纳或完成。Channel 继续用原消息去重和现有 peer 回复限制。

`timing=interrupt` 只是建议。沿用当前的安全降级（排队），不赋予 Head 取消、继续、审批或切 Session 的权限；生命周期里的 waiting 也不是授权。

## 4. Feedback：不要把三条反馈混为一条

| 反馈 | 经过哪里 | 说明 |
| --- | --- | --- |
| **LLM tool result** | 只读适配器 → 本轮 Head 判断 | 唯一直接回到同一轮模型上下文的结果；含授权投影或显式不可用。 |
| **接纳与生命周期** | Studio 接纳回执；resident `dispatch.*` → 同一个 Studio EventBus → Head | 回执只证明接纳。Head 只消费匹配 Pet 实例、Channel scope、已绑定 Session 的生命周期事实，以 invocation ID 关联；保存有限的临时观察，不把原始事件负载给模型。生命周期事件不启动一次新的 Head 判断，不产生自动回复，不当作 tool result。 |
| **执行的公开答复** | resident `dispatch.message` → 已有 Channel 回写桥接 → 提交 Timeline | 保留现有来源校验与去重。`completed` 不是新的公开回复；不得从完成事件复制一份文本，也不得通过 Head 提前发布内部结果。 |

新订阅与 Timeline 订阅共用 Pet 实例激活边界；关闭时取消并清理。两个 topic 不保证跨订阅的处理顺序；不会用事件缓存覆盖实时队列或授权查询，也不会补投或持久化缓存。缺失或不一致就保留未知状态。

## 5. 两个例子

- **普通请求**：“先回我一声，再把这两份表的口径核一遍。” Head 可以直接声明简短回复 + dispatch，不读 Session。Channel 提交回复并向 Studio 请求接纳；resident 后续产生公开结果时，走原来的 Channel 回写路线。
- **执行中追加**：“旧表先别用，最新那份你已经核到哪儿了？” Head 可先调用 `read_session({})`，再结合原消息、关联的生命周期事实与 Session 投影决定：能证实的工作状态可以回复；仅有旧计划就说目前能确认的边界。是否同时派发更正取决于消息本身，不靠关键词；若建议中断，仍按既有规则排队。

## 6. 实现时的最小验收

- 脚本模型验证两次调用确实往返：第 1 次发 `read_session`，第 2 次收到匹配调用 ID 的结果后才声明决定。验证普通请求能一次决定且不读取，最终声明不是可执行 handler。
- 用选定的原生/兼容模型 adapter 验证两个声明与 tool-result 往返；JSON-only、明确的不支持以及超时、非法/重复/混合调用不绕过验证。诊断只记录有限结果码和关联 ID。
- 验证精确 Session、权限变化、无绑定、旧计划及阶段性交接去重。对错 Pet、错 Channel、错 Session、原始 tool 字段和子 Agent 内容做反例验证，确认都不会进入 Model 输入或公开回复。
- 验证正常的 reply-only / dispatch-only / both / neither，回复与接纳失败相互独立；在运行中观察到生命周期不必另起判断，不重复公开答复。Pet 关闭后，迟到的读取不能导致回复或 dispatch。

非目标：新增进度专题路由、调度器、第二套事件总线、复刻 Session 状态、替换 Studio Dispatch、改 resident Agent 执行循环或扩充 Head 权限。
