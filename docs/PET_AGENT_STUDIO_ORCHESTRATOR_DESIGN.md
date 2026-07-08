# Pet Agent Studio Orchestrator Design

> Status: legacy design. The Studio runtime is being redesigned without compatibility requirements; use `docs/STUDIO_RUN_CONTROLLER_DESIGN.md` as the canonical design and `docs/STUDIO_RUN_CONTROLLER_ITERATION_PLAN.md` as the iteration plan.

## Goal

`packages/pet-agent` 需要支持一个 Studio 内并行存在多个 pet agent runtime。每个 pet agent 有自己的身份、角色、capability 集合和运行状态。`StudioOrchestrator` 是流水线的 show-runner,职责是编排撰稿、维护共享知识、决定路由与终止。

架构整体心智模型见 `docs/PET_AGENT_STUDIO_ARCHITECTURE_OVERVIEW.md`。核心立场:

- `StudioOrchestrator` 承担编排:planner 调用、request/task queue 推进、worker 派发、wiki 维护(把 pet 产出整理为可共享的知识库)、终止标定。
- `PetAgentRuntime` 承担数据加工:每次 dispatch 接收 Studio 撰写的 brief,自主访问 Studio Whiteboard(文件系统形态的 wiki)获取所需上下文,在自己的 capability 集合内完成本棒加工,产出 pet 返回结果。
- **Studio Whiteboard** 是 per-conversation 持久的文件系统目录,curator 节点负责维护内容,pet 通过 wiki_read toolkit 自主检索。
- **Capability Artifact Store** 是 per-conversation durable 产物层,capability 完成时 sink 产物,Studio / UI / 后续 pet 通过 artifact refs 读取。
- 终止时,Studio 输出 `finish` 标定 `finalDispatchId`,UI 把对应 pet 的 pet 返回结果 渲染为用户最终答复。

Studio↔pet 的接口契约(invoke 签名、wiki middleware、HITL 边界等)见 `docs/PET_AGENT_STUDIO_INTERFACES.md`。Capability artifacts 的 durable store 见 `docs/PET_AGENT_CAPABILITY_ARTIFACT_STORE_DESIGN.md`。

目标结构：

```text
local-agent
  -> load user studio config
  -> create multiple PetAgentRuntime instances
  -> run startup capability availability checks
  -> register standby runtimes in StudioOrchestrator
  -> wait for user turns

StudioOrchestrator (PetRegistry + WorkQueue/Runner + WikiCurator)
  -> enqueue(userRequest) → request item 入队 → accepted/runId

  -> runner consumes request item:
       caller 显式传入 plan → 直接使用
       否则 → invoke 配置的 plannerPetId 对应的 pet,
              临时注入 `studio_plan` capability,
              planner 自己理解需求 / 必要时 HITL 提问 / 产出 plan
              若 planner 未提交 plan → run 标记 stopped
       plan.tasks 展开为 task items 入队

  -> execute state machine(deterministic,非 LLM):
       look up 下一个 pending task → dispatch
                                        → pet.invoke({ brief, wikiRoot, artifactRefs, signal })
                                        → 收到 pet 返回文本 + artifact refs
                                        → wiki_curator 整理本棒 raw source
                                        → 写回 taskStates[taskIndex].status
                                        → 回到 execute
       所有 task satisfied         → finish(finalDispatchId = 末棒 dispatch)
       否则(有 failed / 上限)    → stop
```

关键:

- **planner 是 agent,不是 graph 节点**——它是一个普通 pet runtime,通过 `studio_plan` capability(以 tool 形式)提交 plan。其内部 reasoning、HITL 提问全部通过该 pet 自己的 UI 通道完成,Studio 不感知。
- **runner 是确定性规则**,不是 LLM 节点。"queue head → request/task handler / 全部 satisfied → finish / 否则 stop"是固定规则。
- **MVP 严格 FIFO dispatch**:每次 runner 消费一个 task item,等 pet 返回 + curator 整理完再进入下一项。
- **方向不再回炉**:plan 一旦确定就执行到底,不在 turn 内自我修正。遇到不能推进的情况选 `finish`(若有可作交付)或 `stop`,把方向决策留给下一 turn。

## UI Role Boundary

UI 主显示是 **pet agent 面板**。Studio 呈现为**控制面状态显示**——状态栏、徽章、进度环或侧栏小图标,告知用户当前 turn 在哪一棒、plan 进度,但不是另一个 chat 面板。

具体含义:

- 用户的全部交互都发生在 pet agent 面板:收到任务、pet 工作过程、HITL 审批、得到结果。
- Studio 的 planner agent 调用、dispatch 决策、wiki_curator 的执行过程进 trace,在 UI 上以状态信号呈现(进度、当前棒次、wiki 更新、turn 是否结束)。
- HITL 完全在 pet runtime 与 UI 之间完成(INTERFACES 文档的 Boundary 2/3),Studio 不感知 pet 内部的中断与恢复。planner 本身也是 pet runtime,它的 HITL 走同一条路径。
- 流水线结束时,Studio 推送 `turn_finished { finalDispatchId }`,UI 把对应 pet 的 pet 返回结果 渲染到主对话面板(方案 B)。

## Runtime Boundary

### PetAgentRuntime

单个 pet agent 的执行单元，复用现有 single-pet orchestrator graph。

它拥有：

- `actor`: pet 身份和 persona。
- `capabilities`: 该 pet 绑定的技能。
- `tools`: 该 pet 可用的通用工具。
- `startupMode`: `standby`、`lazy` 或 `disabled`。
- `status`: `standby`、`active`、`degraded`、`unavailable` 等运行状态。
- `capabilityAvailability`: local-agent 启动检查得到的 capability snapshot。

`PetAgentRuntime` 被创建后不主动调用模型；只有 `StudioOrchestrator` 派发任务时才执行。

`PetAgentRuntime` 不感知 Studio 拓扑：

- 不接收 `StudioContext`。
- 不知道是否有其它 pet agent。
- 不知道跨 agent 协作链路。
- 只消费本次 dispatch 的 task、context summary、artifact refs 和自身 capability/tool 配置。

注意:`capabilityAvailability` 是 runtime 内部决定能否执行 / 是否 degrade 的信号,**不会注入到 pet 的模型上下文**。pet 模型只看到本次任务相关的输入。

### StudioOrchestrator

Studio 级 **run controller**。当前实现是 in-process 编排函数(无独立 LangGraph 图层),由三件事拼成:

- **planner agent 调用**(`obtainPlan`):在 turn 起始向配置的 `plannerPetId` pet 派一棒,临时注入 `studio_plan` capability。planner 自己理解需求、必要时 HITL 提问,通过 capability tool 提交 plan。
- **WorkQueue / runner**:user request 与 plan task 都作为 FIFO queue item 推进。request item 调 planner;task item 调 worker。runner 负责 retry、cancel、terminal 判断,整体逻辑确定(不再过 LLM)。
- **wiki_curator 节点**:每次 pet 返回结果后运行,把 raw source 整理进 Studio Whiteboard。可注入(默认 skeleton curator,production 用 LLM curator)。

orchestrator 同时:

- 维护 pet agent registry。
- 派发任务以函数调用形式进行:`PetAgentRuntime.invoke({ brief, wikiRoot, artifactRefs, signal })`,接口契约见 INTERFACES 文档。
- 调用 `PetAgentRuntime`,按 `studio thread -> pet -> dispatch` 为每个 pet agent 分配独立 checkpoint namespace。
- 推送 **turn state stream**(驱动控制面状态显示)。
- turn 终止时标定 `finalDispatchId`,UI 把对应 pet 返回结果 渲染到主对话面板。

设计立场:**Studio 不在 turn 内自我修正大方向**。runner 只负责排队、派发、重试和收尾——遇到无法直接推进的情况,优先 finish(把当前可作交付的输出标定)或 stop(异常退出),而不是回到 planner 重判。方向决策由用户在下一 turn 通过 follow-up 给出(per-conversation wiki 保留全部上下文,跨 turn 衔接自然)。

边界:capability、tool、底层 API 由 pet 承担;capability artifacts 由 capability/pet runtime sink 到 artifact store;wiki 内容由 curator 节点编辑;用户最终答复由末位 pet 的 pet 返回结果 提供,Studio 在终止时标定 `finalDispatchId`。

当前 MVP 严格 FIFO 顺序 dispatch,Promise.all 并行作为 Phase 后续。

## StudioOrchestrator Runtime

orchestrator 的 turn 执行由 **request queue item + task queue items + wiki_curator** 拼成。其中只有 planner agent 和 wiki_curator 是 LLM 调用,queue runner 是确定性规则。

### Routing

```text
enqueue(userRequest) → request item 入队 → accepted/runId

runner 消费 request item:
  caller 显式 plan       → 用之
  否则 invoke plannerPet → planner 通过 studio_plan capability 提交 plan
                            若未提交 → END(turn_finished, outcome: stopped)
  plan.tasks 展开为 task items 入队

runner 消费 task item:
  task pending 且 pet 可派发 → invoke pet 并传入 brief + wikiRoot
                              → 收到 pet 返回文本
                              → wiki_curator 整理 raw source
                              → 写回 task runtime state
  worker throw 且未达 retry  → 同 task item 重新入队
  全部 satisfied             → finish → END(turn_finished, finalDispatchId)
  否则(failed / 上限)      → stop  → END(turn_finished, outcome: stopped)
```

观察:

- **request item 只规划一次**。planner 自身可能多次 LLM 调用 + HITL 提问,但对 Studio 是一次原子的 `pet.invoke`。
- **runner 是常驻循环**,大多数 iter 走 task item,逻辑确定,无 LLM 推理。
- **runner 不回到 request item 重新规划**;若 plan 不再合理,选 `finish`(交付现有产出)或 `stop`。
- wiki_curator 与 execute 顺序衔接,职责完全正交。

### 三个执行单元的职责

| 单元 | 类型 | 关心什么 | 主要输入 |
|---|---|---|---|
| planner agent | pet runtime invoke | 理解需求、必要时 HITL、产出 plan | userRequest + 注入的 `studio_plan` capability(`list_pets` / `submit_plan`) |
| queue runner | 确定性规则 | 推进 plan、决定收尾 | queue head、task 状态与 dispatch 历史 |
| wiki_curator | LLM 节点(可注入) | 把新 raw source 整理进 wiki | 新 pet 返回结果 + 现有 wiki 文件状态 + 用户可维护的 curator prompt |

只有 planner agent 与 wiki_curator 走 LLM(各自一段独立 trace);queue runner 不耗 LLM 调用。

循环在 request item 规划失败 / runner 输出 `finish` / `stop` / 达到 `maxIterationCount` 时结束。

### Runtime Inputs

进入 runtime 时，local-agent 已经把当前 Studio 的 pet agent 基本注册完成：

- 每个 pet agent 的 `actor`、`role`、`serviceSummary`。
- 每个 pet agent 的 capability summary。
- 每个 capability 的 startup availability snapshot。
- 每个 pet agent 的 `startupMode` 和 `status`。
- 当前用户会话的近期上下文。
- 当前 Studio turn 的 dispatch 历史(interaction log)和 dispatch state。

这些信息先由 `StudioOrchestrator` 持有。普通 worker invoke 不透传整份 Studio context;planner 也不预先接收派生出的 planning snapshot。planner 需要了解 Studio pets 时,通过 `studio_plan` capability 内部的 `list_pets` 工具按需读取。

### Turn State

`StudioOrchestrator` 在每个 turn 中维护:

```ts
// CapabilityArtifactRef 定义见 PET_AGENT_CAPABILITY_ARTIFACT_STORE_DESIGN.md
type StudioTurnState = {
  turnId: string;
  conversationId: string;        // wiki 目录命名空间
  userRequest: string;
  plan: StudioTaskPlan | null;
  taskStates: StudioTaskRuntimeState[];
  dispatches: StudioDispatchState[];
  wikiRoot: string;              // 当前 conversation 的 wiki 目录绝对路径
  artifactRoot: string;          // 当前 conversation 的 artifact store 根目录或 store scope
  iterationCount: number;
};

type StudioTaskPlan = {
  tasks: StudioTask[];           // 顺序即调用计划;数组下标即 task 身份
};

type StudioTask = {
  petId: string;
  goal: string;
  acceptanceCriteria: string[];
};

type StudioTaskRuntimeState = {
  status: 'pending' | 'satisfied' | 'failed';
  retryCount: number;
};

type StudioDispatchState = {
  id: string;
  taskIndex: number;             // 对应 plan.tasks 中的下标
  petId: string;
  status: 'running' | 'finished' | 'cancelled';
  resultText?: string;           // finished 时 pet 的返回文本
  artifacts?: CapabilityArtifactRef[]; // 本 dispatch 产出的 durable artifact refs
  errorMessage?: string;         // 失败时的错误描述
  startedAt: string;
  finishedAt?: string;
};
```

设计要点:

- 没有 `envelopes` 字段——pet 输出文本直接落在对应 `StudioDispatchState.resultText`,interaction log 派生自 dispatches。
- 没有 `requirementState`——是否需要澄清由 planner agent 在自己的 reasoning 中判断,必要时通过 HITL 直接向用户提问。
- 没有 `awaiting_input` 状态——pet 内部的 HITL 不穿透到 Studio,Studio 视角下 dispatch 就是 `running` 直到 result 返回。
- `dispatches` 主要用于 trace / UI 状态显示;判断 task 是否完成看 `taskStates[taskIndex].status`。
- `artifacts` 只保存 refs,artifact 本体在 capability artifact store。dispatch state 不复制大型产物内容。
- `plan` 是调用计划,不承载运行状态;`status/retryCount` 属于 `taskStates`。
### Planner Agent

Planner 不是 graph 节点,而是 **一个普通的 pet agent**,由 `StudioOrchestratorConfig.plannerPetId` 指定。turn 起始(且 caller 未显式给出 plan)时,Studio 把它当成第一棒调用:

```text
StudioOrchestrator.obtainPlan(userRequest):
  let plan = null
  pet.invoke({
    brief: userRequest,           // 用户原始请求作为 planner 的 brief
    extraCapabilities: [createPlanCapability({
      onSubmit: (submitted) => { plan = submitted },
      listPets: () => listAgents(),
    })],
  })
  return plan          // tool 调用通过闭包写回;若 planner 没调 → plan 为 null,turn stopped
```

`studio_plan` capability 给 planner 两个窄工具:

- `list_pets()`:读取当前 Studio pets 的 `petId` / `role` / `serviceSummary` / `status` 等可规划信息。
- `submit_plan(tasks: StudioTask[])`:提交本次 run 的有序 task 列表。

planner 自己:

- 理解用户需求,必要时拉 wiki 看历史。
- 需要选择 worker 时调 `list_pets`,读取 Studio 当前 pet 职责与状态。
- 优先把 task 分派给职责匹配且状态可派发的 worker pet。
- 缺信息时通过 pet 自己的 HITL 桥(`humanReviewer`)向用户提问 —— 走 INTERFACES 文档的 Boundary 3,Studio 不感知。
- 信息齐备后调 `submit_plan`,把任务列表(顺序即执行顺序)提交。
- 若该请求超出 Studio 范畴,planner 自行选择不调用 `submit_plan` 并以自然语言解释 —— Studio 收到空 plan,turn 标记 stopped。

这种"planner-as-agent"模式的好处:

- planner 与其它 pet 共用同一套 capability/tool 基础设施,不需要单独的 LLM 节点 + 独立 prompt 维护。
- planner 的 HITL 与普通 pet 同构,不需要 Studio 引入 ask_user 状态机。
- planner 可以被替换:不同的 Studio 可以指定不同 plannerPetId,获得不同的 planning 行为。

边界上要保持清楚:planner 不是 Studio 的执行 orchestrator。它只根据用户意图和 `list_pets` 读到的当前 pet 视图提交一份调用计划;计划提交后,排队、派发、重试、收尾都属于 Studio 的确定性运行层。

### Queue Runner

queue runner 是一个确定性规则,不走 LLM。当前实现用 request item 和 task item 作为推进单位:

```ts
type StudioQueueItem =
  | { kind: 'request'; runId: string; conversationId: string; userRequest: string }
  | { kind: 'task'; runId: string; conversationId: string; taskIndex: number; petId: string; goal: string };
```

task 的身份是 `plan.tasks` 数组下标。这是天然唯一、由数据结构保证的——planner 不需要(也不应)生成 task id;task queue item 直接带 `taskIndex`,runner 用 `state.plan.tasks[taskIndex]` 直接拿到对应任务,没有 lookup-by-id 的歧义空间。

brief 第一版直接使用 task `goal`。如果后续需要更丰富的 brief,仍应由 runner 用确定性模板按 `goal` / `acceptanceCriteria` + wiki 事实组合,**不过 LLM**;不回到 planner 二次规划。

queue runner 关心"按 plan 推进到底"——**不自我修正大方向**。若发现 plan 不再合理,选 `finish`(交付当前可用产出)或 `stop`(若无可交付),把方向决策留给用户在 follow-up turn 解决。

### Internal ExecuteAction

`ExecuteAction` 保留为内部状态机文档类型,表达 task item handler 的三类动作:

```ts
type ExecuteAction =
  | { type: 'dispatch'; taskIndex: number; brief: string }
  | { type: 'finish';   finalDispatchId: string }
  | { type: 'stop';     reason: string };
```

执行细节:

- `dispatch`:dispatcher 据 brief + 当前 wikiRoot + 需要的 artifact refs 调用 `PetAgentRuntime.invoke(...)`(签名见 INTERFACES 文档),等待 invoke Promise resolve 拿到 pet 返回文本与产物 refs,然后由 wiki_curator 整理。完成后回到 execute。pet 内部的 HITL `interrupt()` 对 Studio 不可见——Studio 视角下 dispatch 一直处于 `running`,直到 invoke Promise 完成。
- `finish`:turn 终止信号,标定 `finalDispatchId`,UI 渲染对应 dispatch 的 pet 返回文本到主对话面板。
- `stop`:无法继续(retry 耗尽 / pet 不可用 / plan 有 failed task 且无可交付),turn_finished outcome 为 stopped。

planner 不输出 ExecuteAction,planner 通过 `studio_plan` capability 的 tool 直接提交 `StudioTaskPlan`(见上一节)。

### 验收的判断方式

某棒 result 是否可作为末位交付,**隐式发生在 queue runner 的固定规则中**:

- 把 dispatch 完成后写回 `taskStates[taskIndex]`:成功(pet 正常返回文本)→ satisfied;失败且达 `maxRetryPerTask` → failed;失败但未达上限 → 仍 pending,runner 会把同一 task item 重新入队(retryCount 由 dispatcher 自动 ++)。
- 全部 task 都 satisfied → `finish { finalDispatchId }`(末棒 dispatch)。
- 有 task failed 且无可作交付的 result → `stop`。

设计上没有独立的 `evaluate` / `mark_satisfied` action,也没有 `TaskEvaluation` 结构——验收逻辑是固定规则,基于 task status 与 dispatch 历史推导。

数据本身的质量把关由 pet 自身承担(包括"本棒输出是否满足 acceptanceCriteria"——pet 在 brief 中读到 acceptanceCriteria 后自行判断,不达标可通过 HITL 反馈或在文本中标记)。Studio 编排层只关心:plan 是否还有 pending task,以及末棒是否可交付。

### Dispatch Brief

task item 在 dispatch 时携带 brief。它是一段**自然语言任务说明**(string),包含本棒任务目标(取自 `task.goal` / `task.acceptanceCriteria`)以及关键约束。MVP 直接使用 task goal,后续如需补充上游概况,也应由 runner 用模板拼装,不过 LLM。

dispatcher 收到 brief 后,把 brief + wikiRoot + artifact refs + signal 传给 `PetAgentRuntime.invoke(...)`。wiki middleware 在 invoke 时自动读取 `{wikiRoot}/index.md` 并粘进 system prompt(详见 INTERFACES 文档)。pet 视角下,每次 dispatch 收到的输入形态一致:一段任务文本 + 一份 wiki 索引(自然语言形式)+ 必要产物引用。

brief 撰写要点:

- **不指明 pet 该读哪些 wiki 文件**——检索由 pet 自主决定,Studio 不喂路径。
- **不暴露上游来自哪个 pet 的元信息**——pet 视角与单 agent 模式一致。
- **整合需求(若有)写进 brief**——例如"本棒承担整合输出",末棒 pet 据此自行整合。

示例:

```text
本棒是流水线第 2 棒。前面已完成脚本结构,相关内容已纳入 wiki。
本棒目标:补足尾音频策略与口播节奏,并整合为可交付的完整说明。
约束:无需重写脚本正文。
若发现信息缺口,在末尾以缺口标记列出。
```

pet 收到 brief 后:

- 可以先 `wiki_read.cat('index.md')` 看 wiki 全貌。
- 也可以 `wiki_read.grep('受众')` 搜关键词。
- 也可以 `wiki_read.ls('topics/')` 列主题。
- 检索路径由 pet 自主决定,Studio 不指定具体文件。

这种设计让 pet 保持完整的数据加工自主权,Studio 只承担"情境 + 任务"的撰稿。后续开发也不会误以为"Studio 必须给 file 列表"。

### Execution Loop

obtainPlan 在 turn 起始触发一次;execute 是确定性循环;wiki_curator 在每次 pet 返回后同步运行。典型一个 turn:

```text
turn 起始
  → obtainPlan
      invoke plannerPet(userRequest)
        planner 自己理解 + 必要时 HITL(走 humanReviewer 桥) + submit_plan
      若 plan 未提交 → END(turn_finished, outcome: stopped)
      否则 → state.plan 写入 → 转 execute

execute(plan 存在)
  → 下一个 pending task → dispatch(task1, brief)
      调用 PetAgentRuntime.invoke({ brief, wikiRoot, artifactRefs, signal })
      等待 Promise resolve,拿到 pet:A 的返回文本 + artifact refs
      (过程中 pet 内部 HITL 对 Studio 不可见)
      wiki_curator 读返回文本 + artifact refs,整理进 wiki
      写回 taskStates[taskIndex].status = satisfied / failed
  → 回到 execute

execute 下一轮
  → 下一个 pending task → dispatch(task2, brief)
      → pet:B 读 wiki 自主检索,必要时按 ref 读 artifact → 返回文本 + artifact refs → wiki_curator
  → 回到 execute

execute 末轮
  → 全部 satisfied → finish { finalDispatchId }
      turn state stream 推送 turn_finished
      UI 渲染该 dispatch 的返回文本到主对话面板
```

要点:

- **planner 与普通 pet 同构**:同样是 `pet.invoke()` 一次原子调用;planner 内部多轮 LLM、HITL 提问对 Studio 不可见。
- **execute 是常驻确定性循环**:没有 LLM 推理,逻辑稳定可预期。它不主动回到 obtainPlan——遇到无法推进的情况,选择 `finish`(交付当前可作产出)或 `stop`(异常退出)。
- pet 内部的 HITL(planner 与普通 pet 都一样)通过 pet runtime 自己的 UI 通道(INTERFACES Boundary 2/3)处理,Studio 视角下 invoke Promise 一直 pending 直到 pet 返回文本。
- MVP 严格顺序:execute 每轮输出一个 dispatch,等 invoke 完成 + curator 整理完后再进入下一轮 execute。

#### Queue-Oriented Runner

当前实现把 `plan.tasks` 视为 queue 的输入,而不是直接等同于运行状态:

- planner 仍只提交有序 task 列表;不生成 task runtime 状态,也不决定 worker 调用细节。
- Studio 接收 plan 后把 task 入队。queue head 是"下一步做什么"的唯一来源,不另设 cursor。
- Studio 请求可以非阻塞:`enqueue()` 创建 run 并放入 request item 后返回 accepted/runId;后台 runner 继续消费 request/task queue。
- worker 前的一层只做具体运行控制:该排队就排队,该执行就执行,按完成情况推进下一项。
- worker invocation 仍保持简单抽象:`PetAgentRuntime.invoke({ brief, wikiRoot, signal, ... })`;队列层不关心 worker 内部如何完成任务。
- `invoke()` 保留为同步兼容入口,内部等价于 `enqueue()` + `waitForRun()`。

### Finalization

流水线结束时,queue runner 输出 `finish` action,标定 `finalDispatchId`——指明哪个 dispatch 的 pet 返回文本作为用户答复来源:

```text
execute → finish { finalDispatchId, reason }
  -> turn state stream 推送 turn_finished(带 finalDispatchId)
  -> UI 读取该 dispatch 的 resultText
  -> 渲染该文本与该 dispatch 的 artifact refs 到主对话面板
```

设计立场:

- 用户最终答复直接取自末位 pet 的返回文本。
- 如果产品场景需要"多个 pet 输出合体呈现",由末位 pet 在自己的返回文本中完成整合——它从 Studio 撰写的 brief 中获得上游说明并通过 wiki 自主检索,具备整合能力。Studio 把这种整合需求写进末棒 brief,而不是在末端再起一个聚合节点。
- 中间 pet 的输出留存在它们各自的 pet 面板与 dispatches 历史中,供用户回看或 trace 审计使用。

最终答复呈现在用户发起 turn 的主对话面板(方案 B)。UI 默认渲染返回文本与对应 artifact refs,dispatch id、内部工具日志按需在调试视图中提供。

### HITL Boundary

HITL 完全发生在 pet runtime 与 UI 之间(INTERFACES 文档的 Boundary 2 / 3),**对 Studio 透明**:

- pet 内部 tool review 由 toolkit `policy.toolReview` 在调用前决定，tool wrapper materialize canonical review payload 后触发 interrupt；pending review 控制态由 LangGraph interrupt/checkpoint 持有。
- pet runtime 接到 LangGraph 暂停信号 → 调构造时注入的 `humanReviewer` 桥 → 该桥内部把 request 送到 pet 自己的 UI session(ws/SSE/进程内),拿回 canonical `ReviewResponse`。
- pet runtime 用 `Command({ resume })` 续跑 graph;若仍有 interrupt 则继续循环,直到 graph 给出最终文本。
- 最终 pet runtime invoke Promise resolve,Studio 才收到信号(整个 HITL 过程对 Studio 来说就是"invoke 一直 pending,然后正常 resolve")。

Studio 视角下不引入 `awaiting_input` 状态、不路由 question 答复、不参与审批决策。控制面状态显示也只看 dispatch 的 `running` / `finished` / `cancelled` 三态。

`requiresApproval` 与 `riskTags` 是 capability/tool 的静态元数据,决定该工具调用前是否 interrupt——审批触发由元数据驱动,确定且可预期。详见 INTERFACES 文档。

### Guardrails

MVP 限制(两个独立 budget):

- `maxIterationCount`:单个 turn 内 dispatch 数累计上限(避免循环或膨胀)。
- `maxRetryPerTask`:单个 task 的 retry 次数上限。execute 对同一 taskIndex 再次 `dispatch` 时由 dispatcher 自动 `retryCount++`,达到上限后再失败则 task 标记 failed,execute 据此走 `finish`(若有可交付)或 `stop`。

其他规则:

- dispatch 由 `StudioOrchestrator` 创建,pet 通过 `invoke(brief, wiki, artifactRefs, signal)` 接收任务(详见 INTERFACES 文档)。
- pet agent 在自己的 dispatch 上下文内运作,Studio registry 由 orchestrator 维护。
- dispatcher 执行 `StudioOrchestrator` 输出的 action,action 经 zod 校验。
- 审批由用户在 pet 面板内裁决,Studio 不参与;后续可加规则驱动的 policy 层。

## Studio Whiteboard(Filesystem-backed Wiki)

Studio Whiteboard 是一个**文件系统目录**形态的共享知识库,由 wiki_curator 节点维护,pet 通过 wiki_read toolkit 自主检索。它本质上是把 Claude Code "工作目录 + 文件操作" 心智搬到 Studio 内部的协作上下文。

### Directory Layout

```text
{AGENT_HOME}/studio/{studioId}/conv/{conversationId}/wiki/
  ├─ index.md              # 目录索引(curator 维护)
  ├─ topics/               # 主题化条目
  │   ├─ script-structure.md
  │   └─ audio-strategy.md
  ├─ sources/              # 原始素材(curator 从 pet 返回文本摘录)
  │   └─ {dispatchId}-{petId}.md
  └─ notes/                # 跨主题笔记 / 决策记录
```

### Lifecycle

- **per-conversation 持久**:同一会话内的多个 turn 共享一份 wiki,新内容累积到既有目录。
- **不自动清理**:会话结束、新会话开始,旧 wiki 保留在文件系统中。
- **清理需显式触发**:由用户通过明确指令、命令或维护操作清理。curator 自身仅做归整(更新 index、合并主题),不做删除。
- conversation 切换时,新 conversation 对应新的 `{conversationId}` 目录,wiki 与之前独立。

### Wiki Curator 节点

curator 是独立的 LLM 节点(实现可注入),执行时机为**每次 pet 返回 pet 返回结果 之后**、回到 queue runner 之前:

```text
trigger:    pet 产出 pet 返回结果 后
inputs:     新 pet 返回结果 内容 + 当前 wiki 目录状态 + 用户可维护的 curator prompt
tools:      Read / Write / Edit / Bash(全权限,作用在 wiki 目录内)
behavior:   决定:
            - 是否新增 topics/xxx.md
            - 是否合并到已有 topic
            - 是否更新 index.md
            - 是否把 raw 摘录写到 sources/{dispatchId}-{petId}.md
outputs:    wiki 目录的文件更新
```

curator prompt 通过 `promptProvider` 注入到 `createLLMWikiCurator({ models, promptProvider })`,默认 `defaultPromptProvider()` 用内置 `DEFAULT_CURATOR_PROMPT`(Karpathy 风格)。

预设 provider:

- `defaultPromptProvider()` —— 内置默认 prompt
- `fileReadPromptProvider(absPath)` —— startup 时读一次文件并缓存

`StudioLocalConfig.curator.promptPath`(本地 yaml 配置)指向一个相对配置文件目录的 prompt 文件;启动时 local-agent 解析为绝对路径并装入 `fileReadPromptProvider`。

需要"每次重读 / 动态拼装 / 远程拉取"等场景,在代码侧传任意 `() => string | Promise<string>` 自定义 provider 即可。

**wiki 的管理范式由用户自行通过 prompt 定义**——curator 不预设固定流程,完全由 prompt 指导(例如何时新增 topic、如何归并、如何写 index、如何标注 source)。这给了 Studio 配置者充分的自由度去定制知识库形态。一个有启发性的参考是 Karpathy 整理个人笔记的方式:<https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f>。

### Pet 端 wiki_read Toolkit

pet 在 Studio 模式下默认装备 `wiki_read` toolkit,根目录锁定到本 conversation 的 wiki/ 目录:

```ts
const wikiReadToolkit = {
  ls:    (path?: string) => string;     // ls / tree, 相对 wikiRoot
  cat:   (path: string)  => string;     // 读文件全文
  grep:  (pattern: string, path?: string) => string;   // 正则全文搜索
  find:  (filter: { name?: string; ext?: string }) => string;  // 查找文件
  head:  (path: string, n?: number) => string;
  tail:  (path: string, n?: number) => string;
};
```

实现层面是对 bash toolkit 的受限封装:

- 根目录锁在 brief 注入的 `wikiRoot`(即 `{AGENT_HOME}/.../conv/{conversationId}/wiki/`)。
- 命令白名单:`ls / cat / grep / find / head / tail`。
- 不开放路径越界、cd、写命令。

pet 自主决定检索路径——Studio 不在 brief 中指明具体文件,只提供 wikiRoot 与情境叙述。

### 与 dispatch / pet 返回的关系

- pet 返回文本作为 dispatch 的输出,保存在 `StudioDispatchState.resultText`,供 curator 与 trace 使用。
- capability 产物作为 artifact refs 保存在 `StudioDispatchState.artifacts`,产物本体由 capability artifact store 持有。
- wiki 是 curator 派生出的**独立知识层**,文件内容由 curator 写。
- wiki 中 `sources/{dispatchId}-{petId}.md` 是 curator 从 pet 返回文本与 artifact refs 摘录的副本,便于 pet 读取摘要和发现产物。
- pet 不读 dispatches 历史,只通过 wiki_read toolkit 读 wiki。

### 多媒体资产

pet 输出文本中可包含对 artifact ref 或文件路径的引用(详见 INTERFACES 文档的 Multimedia Outputs 一节)。推荐由 capability 先 sink 到 artifact store,pet 返回 refs。curator 负责:

- 解析 pet 返回文本和 `dispatch.artifacts` 里的 artifact refs。
- 在对应 topic markdown 中以**自然语言**描述资产(用途、类型、尺寸、风格、来源 dispatch、artifactId 等)。
- 对 legacy 文件路径,可以把文件搬到 artifact store 后再写入 ref;wiki 不作为大型产物的权威存储。

下一棒 pet 通过 wiki_read 读到 topic markdown,从描述中自然理解该资产是什么、在哪。需要多模态输入时,pet 装备 wiki_read 的 `attach(path)` 扩展即可。

## Capability Artifact Store

Capability Artifact Store 是与 Studio Whiteboard 并列的 durable 产物层。Whiteboard 负责“让后续 pet 可检索地理解产物”,Artifact Store 负责“保存产物本体或外部引用”。

建议目录形态:

```text
{AGENT_HOME}/studio/{studioId}/conv/{conversationId}/artifacts/
  ├─ index.jsonl
  └─ {artifactId}/
      ├─ artifact.json
      └─ content
```

运行时规则:

- capability/subagent 完成时把需要保留的产物 sink 到 store,拿回 `CapabilityArtifactRef`。
- pet invoke 返回 `{ reply, artifacts }`,Studio dispatch state 保存 refs。
- completed lane messages 可以删除,因为 artifact store 才是产物权威来源。
- wiki_curator 在 pet 返回后把 refs 整理进 wiki,但不复制大型本体。
- 后续 pet 通过 wiki 发现 refs,必要时通过 artifact read tool/API 读取内容。

`ToolMessage.artifact` 仅是 capability 内部临时回执桥,不是 durable store。详细 contract 见 `docs/PET_AGENT_CAPABILITY_ARTIFACT_STORE_DESIGN.md`。

### 调试与审计

文件化形态带来直接的可观察性:

- 用户/开发者可以直接 `ls` / `cat` 看 curator 写了什么。
- 发现 curator 写错可以手工编辑 markdown 修正,下一棒 pet 看到的就是修正后的版本。
- wiki 目录可以纳入 git diff / 归档,便于复盘与跨会话对比。

## Run API And Turn State Stream

orchestrator 对外提供 run-level API:

```ts
orchestrator.enqueue(input)       // accepted/runId
orchestrator.getRun(runId)        // snapshot
orchestrator.waitForRun(runId)    // terminal StudioTurnResult
orchestrator.subscribeEvents(fn)  // run-level event stream
orchestrator.invoke(input)        // enqueue + waitForRun compatibility wrapper
```

orchestrator 同时推送一条 **turn state stream**,供控制面状态显示订阅。Caller 可以在 `enqueue()` / `invoke()` input 里传入 `onTurnEvent`,也可以用 `subscribeEvents()` 订阅 `{ runId, conversationId, event }` 形态的 run-level wrapper。Studio 在编排关键节点同步触发事件:

```ts
type StudioTurnEvent =
  | { type: 'turn_started';        turnId: string; userRequest: string }
  | { type: 'plan_set';            plan: StudioTaskPlan }
  | { type: 'task_status_changed'; taskIndex: number; status: StudioTaskRuntimeState['status'] }
  | { type: 'dispatch_started';    dispatchId: string; taskIndex: number; petId: string }
  | { type: 'dispatch_finished';   dispatchId: string;
                                   status: 'finished' | 'cancelled';
                                   resultText?: string;
                                   artifacts?: CapabilityArtifactRef[];
                                   errorMessage?: string }
  | { type: 'wiki_updated';        changedPaths: string[] }
  | { type: 'turn_finished';       outcome: 'done' | 'stopped';
                                   finalDispatchId?: string };

type StudioTurnEventHandler = (event: StudioTurnEvent) => void | Promise<void>;
```

设计与运行时约定:

- **粒度低、频率低**:每棒大约 3–4 个事件(`dispatch_started` / `task_status_changed` / 可选 `wiki_updated` / `dispatch_finished`),整 turn 起止两端各 1 个。控制面据此渲染状态栏、徽章、当前棒次、wiki 最近更新。
- **dispatch_finished 携带 resultText + artifact refs**:控制面需要"末棒最终文本"和产物卡片做"点击展开"等场景,所以这个事件带上 pet 的返回文本与 refs(冗余但便利;`turn_finished` 不重复携带)。
- **handler 不阻塞编排**:Studio 不 await handler 的返回 promise,即便 handler 抛错或 promise reject,主流程也不受影响——控制面挂掉不应该让 turn 跟着挂。
- **跟 pet 工具事件流是两条独立通道**:`onTurnEvent` 来自 Studio 自己(跨 pet、全局、低频),pet runtime 内部 tool/runtime 事件来自 root `streamEvents(v3)` adapter(单 pet 内部、高频)。一条供"控制面状态信号",一条供"pet 面板对话内容",各自独立订阅,UI 不需要做合流过滤。详见 INTERFACES 文档的 Boundary 2。

## Local Agent Wiring (Phase 2)

Phase 2 在 `services/local-agent/` 落地 Studio。配置层、运行时层、协议层的具体形态如下。

### 配置文件分布

```
~/.pinpawo/
├── config.json                  # 进程级总配置(鉴权 / LLM / chat 模式 actor_id)
│                                  Studio 不读 actor_id;LLM 字段共享
├── studio.json                  # Studio 编排定义(StudioLocalConfig)
├── studio-curator.md            # (可选)curator prompt 文件
└── pets/
    ├── <petId>.json             # 每个本地 pet 一份(PetLocalConfig)
    └── ...
```

`config.json` 跟 `studio.json` + `pets/*.json` 是**两套并存的配置**:

- `config.json#actor_id` 是 **chat 模式**(直接对话)绑定的服务端 pet。Phase 2 期间这条路径完全不动。
- `studio.json` + `pets/*.json` 是 **Studio 模式**(`/studio` 命令)用的纯本地配置。
- 两者互不读取。统一是 Phase 3+ 工作。

具体示例文件:`docs/examples/studio.json.example` + `docs/examples/pets/*.json.example`。

### 运行时装配(`buildStudioForTurn`)

`services/local-agent/src/studio/studioRuntime.ts` 的 `buildStudioForTurn(input)` 是装配函数:

1. 加载 `~/.pinpawo/studio.json` + `~/.pinpawo/pets/*.json`
2. 通过 `resolveStudio()` 做结构一致性校验(plannerPetId 必须在 agents 中、agents 必须存在等)
3. 全局 `models = buildLocalAgentModels(llmConfig)`(curator 用此)
4. 对每个 pet config:
   - capabilities 按名筛选自全局 capability 池
   - 若 pet config 有 `model` 字段 → 该 pet 用 `buildLocalAgentModels({...llmConfig, model: petConfig.model})`,否则用全局 models
   - 用 `createPetAgentRuntime({ models, actor, role, serviceSummary, capabilities, tools, humanReviewer })` 装配,humanReviewer 由 `createWsHumanReviewer` 桥到当前 ws
5. 装 curator:`createLLMWikiCurator({ models, promptProvider })`(promptProvider 来自 `fileReadPromptProvider(promptPath)` 或 `defaultPromptProvider()`)
6. 装 StudioOrchestrator,返回

**Lazy 构造**:每次 `/studio` turn 触发一次,**不 cache**——配置改动即生效;pet runtime 构造很轻,无性能问题。

### ws 协议

Studio 客户端消息保持 `studio_request` 起手；server 端 agent run activity 统一走 `LocalAgentEventMessage { type: 'event', requestId, event }`。Studio 编排进度使用 `event.type: 'studio.progress'`，pet HITL 使用 `event.type: 'human_review.requested'`。

| 消息 | 方向 | 用途 |
|------|------|------|
| `studio_request { requestId, userRequest, runId?, conversationId? }` | client → server | turn 起手；`runId` 与 `conversationId` 可显式指定以便外部 scheduler 幂等、并发控制 |
| `event { requestId, event: { type: 'studio.progress', ... } }` | server → client | Studio 编排进度(turn_started / plan_set / dispatch_started 等) |
| `event { requestId, event: { type: 'human_review.requested', ... } }` | server → client | Studio 内 pet HITL |
| `studio_response { requestId, outcome, reply, finalDispatchId?, reason?, runId?, conversationId?, idempotencyKey?, workdir? }` | server → client | turn 终态 + 最终 reply；新增字段用于 scheduler 幂等链路和 workspace trace 归属 |
| `studio_error { requestId, message }` | server → client | turn 失败 |

### humanReviewer 桥(local-agent 内部 wiring)

`services/local-agent/src/studio/studioBridge.ts`:

```ts
// 1. 每个 ws 连接持有一个 PendingReviewSlot
const slot: PendingReviewSlot = { current: null };

// 2. 构造 pet runtime 时,humanReviewer 绑到 ws + slot
const humanReviewer = createWsHumanReviewer({
  send, requestId, petId, slot,
});
// → pet 内部 HITL 触发时:
//   - 通过 send 推 `human_review.requested` event
//   - 把 promise resolver 寄存在 slot

// 3. chat_request handler 加 additive 分支:
//   收到 chat_request 时,若 slot 有 pending review → resolveReview(slot, decision)
//   这样 pet HITL 的答复就经由现有 chat_request.resume 机制回到 pet runtime
```

Studio 内 pet HITL 跟单 pet chat HITL 用同一条答复链路。local-agent 对外只发送 `LocalAgentEvent`；`pinpawo-app` app/API 需要在 app 仓库消费该 envelope。

### TUI 集成

`services/local-agent/src/commands/tui.tsx` 加 `/studio <文本>` 命令:

- 输入 `/studio xxx` → 发 `studio_request`
- 收 `studio.progress` event → 渲染到 system 行(`[studio] dispatch[#0] → pet:script-writer`)
- 收 `human_review.requested` event(由 Studio 内 pet 触发)→ 走现有 HITL 渲染逻辑
- 收 `studio_response` → 显示最终 reply(`assistant` 行)
- 收 `studio_error` → 显示错误

操作示例:

```
> /studio 帮我做一支讲秋日食材的短视频
[studio] plan 设定:2 棒
[studio] dispatch[#0] → pet:script-writer
[wiki_read] cat index.md → ...
[studio] task[#0] → satisfied
[studio] wiki 更新 2 项
[studio] dispatch[#1] → pet:editor
...
最终答复: ...
```

## Capability Boundary

capability 在 pet 内部运作;跨 capability 与跨 pet 的衔接由 `StudioOrchestrator` 编排。

当某个 capability 完成本职后发现需要其它能力补足,在 result.summary 中以缺口说明的形式标出,Studio 在 reason 阶段读取后决定是否派发下一棒 pet 并撰写新的 brief。

### 幂等约定（跨进程可共享）

`runId`/`conversationId` 与 `idempotencyKey` 的派生约定由 `@pinpawo/pet-agent` 的
`buildStudioRunIdentity({ runId, conversationId? })` 提供：

- `conversationId = request.conversationId ?? runId`
- `idempotencyKey = studio:{conversationId}:run:{runId}`

`local-agent` 的 `StudioRunService` 与将来的 App/API scheduler 都应直接复用该函数，避免约定漂移。

视频脚本场景示例:

```text
obtainPlan
  invoke planner pet(userRequest = "做一支讲秋日食材的短视频")
  planner 通过 studio_plan capability 提交(顺序即执行顺序,数组下标即 task 身份):
    [ { petId: trend_video_script, goal: "搭脚本结构",        ... },   # taskIndex = 0
      { petId: video_tail_audio,   goal: "补尾音频 + 整合",   ... } ]  # taskIndex = 1

execute → dispatch(taskIndex=0, brief)
  trend_video_script pet
    返回脚本结构文本 + scriptOutline artifact ref
  wiki_curator: 把 scriptOutline ref 与摘要整理进 topics/script-structure.md
  taskStates[0].status = satisfied

execute → dispatch(taskIndex=1, brief)
  video_tail_audio pet
    收到 Studio 撰写的 brief(含整合职责说明)
    自主 wiki_read.cat('topics/script-structure.md') 拉详情
    必要时按 artifact ref 读取 scriptOutline 本体
    加工并整合,产出含音频建议的完整 pet 返回结果 + finalDeliverable artifact ref
  wiki_curator: 把 audio 产出整理进 topics/audio-strategy.md, 更新 index
  taskStates[1].status = satisfied

execute → 全部 satisfied → finish { finalDispatchId = taskIndex=1 的 dispatch }
  UI 渲染 audio pet 的 pet 返回结果 到主对话面板
```

整合逻辑由末棒 pet 在自己 result 中完成——Studio 在 brief 里写明这一棒承担整合职责,末棒 pet 在加工时自然形成完整产出。

## Trace Shape

建议 trace 结构:

```text
studio turn run
  → obtainPlan
      → pet agent run: planner pet
          → capability run: studio_plan(submit_plan tool call)
  → execute step          (ExecuteAction: dispatch + brief)  // 确定性,无 LLM
  → pet agent run: script pet
      → capability run: trend_video_script
  → wiki_curator run      (整理 raw source → wiki 文件更新)
  → execute step          (ExecuteAction: dispatch + brief)
  → pet agent run: audio pet
      → capability run: video_tail_audio
      → wiki_read tool calls(pet 自主检索 wiki)
  → wiki_curator run
  → execute step          (ExecuteAction: finish)
  → finish(标定 finalDispatchId)
```

LLM 调用集中在两处:**planner pet agent run** 和 **wiki_curator run**(每棒一次)。queue runner 本身不耗 LLM,只产出 action 决定下一步。这种结构让 trace 清晰、planner 行为可单独 eval、curator 提示词可独立 tune。turn 结束时由 `finish` 的 `finalDispatchId` 指明用户答复来源。

这样可以避免多 pet 协作时 task/route/search 和具体执行日志混在一起。

## Phasing

### Phase 1

- 增加 `StudioContext`、`PetAgentRuntime`、`StudioOrchestrator` 类型和 skeleton。
- 实现 `PetAgentRuntime.invoke({ brief, wiki, artifactRefs, signal })` 签名与 wiki middleware(详见 INTERFACES 文档)。
- 实现 wiki middleware:读 `{wikiRoot}/index.md` → 粘进 system prompt + 绑定 wiki_read toolkit。
- 实现 obtainPlan(planner agent + studio_plan capability)+ queue runner + wiki_curator,执行单元拼成一个 turn 编排函数。`ExecuteAction` 由 zod 校验。
- 实现 Studio Whiteboard 文件目录与 wiki_curator 节点(curator prompt 用默认值)。
- 实现 wiki_read toolkit,在 Studio 模式下由 wiki middleware 装备到 pet。
- pet runtime 不透传工具 callback；工具/runtime 事件走 root stream Boundary 2,HITL 通过构造时注入的 `humanReviewer` 桥(Boundary 3)消化(详见 INTERFACES 文档)。
- 支持显式 plan 顺序派发多个 standby pet agent。
- dispatch 结果保存在 `StudioDispatchState.resultText`,artifact refs 保存在 `StudioDispatchState.artifacts`。
- 默认路径仍派发给 `defaultPetId`。
- turn state stream 接口与控制面状态显示的基础订阅。

### Phase 2

- local-agent 接入用户级 Studio 配置。
- 启动时按 pet agent 执行 capability availability check。
- 对外暴露 standby/degraded/unavailable 状态。

### Phase 3

- 增强 planner agent 的能力(更好的 plan prompt、更丰富的 plan schema、多 pet 路由判断)。
- 支持 Promise.all 并行 dispatch:无依赖 task 同轮派发,Studio 在 fan-in 处等待全部 result 与 curator 整理完成后继续 execute。
- task retry 与 follow-up dispatch 各自独立 budget。
- 支持 curator prompt 的 per-Studio 自定义。
- 探索 execute → re-plan 回流路径(目前 MVP 不支持,遇到无法推进直接 finish / stop)。

整合需求由末棒 pet 承担:Studio 在末棒 brief 中写明整合要求,末棒 pet 在加工时形成完整产出。

### Phase 4

- 接入 Studio interaction record、points、Service Feed 来源上下文。
- 支持 pet 与 pet 的协作记录对用户可见。
- 引入 `ApprovalPolicy` 模块(规则驱动,非 LLM 驱动),支持预算预检与 auto-approve。
