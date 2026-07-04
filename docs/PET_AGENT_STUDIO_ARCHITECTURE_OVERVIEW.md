# Pet Agent Studio Architecture Overview

> Status: historical overview. The current Studio rewrite is defined by `docs/STUDIO_RUN_CONTROLLER_DESIGN.md`; this document is background context only and should not be used as the source of truth for Studio runtime internals.

本文档是 Studio → Agents → Subagents 三层架构的理念性总览,定位在两份具体设计文档之上,回答**为什么这个结构站得住脚、以什么为代价换来了什么**。

具体协议见:

- `docs/PET_AGENT_STUDIO_INTERFACES.md` —— Studio ↔ Agent 接口契约(invoke 签名、wiki middleware、HITL 边界等)。
- `docs/PET_AGENT_STUDIO_ORCHESTRATOR_DESIGN.md` —— StudioOrchestrator 运行时设计。
- `docs/PET_AGENT_CAPABILITY_ARTIFACT_STORE_DESIGN.md` —— capability artifacts 的持久化 store 设计。

## TL;DR

**核心心智模型:Studio 撰写,Pet 加工,Wiki 共享,末位 Pet 交付。**

```text
─────────────── 编排层(Studio:show-runner)───────────────────────
              Studio (StudioOrchestrator)
              ├ planner agent      : 调指定 pet,通过 studio_plan capability 提交 plan
              ├ execute state mach : 顺序遍历 plan,产出 dispatch / finish / stop(确定性)
              ├ wiki_curator       : 把 pet 产出整理进 Studio Whiteboard
              └ 终止时标定末位 pet,该 pet 的 返回文本 即为用户答复
                     │
                     │ 撰写好的 brief(情境 + 任务,不指明读哪些文件)
                     ▼
─────────────── 加工层(Pet:实际数据加工者)──────────────────────
   Pet A ──result──▶ curator ──▶ wiki ──▶ Pet B (自主检索) ──result──▶ ...
                                                                     │
                                                                     ▼
                                                                   User
                     (末棒 pet 的 返回文本 直接渲染给用户)

─────────────── 知识层(Studio Whiteboard:per-conversation wiki)──
   {AGENT_HOME}/studio/{sid}/conv/{cid}/wiki/
     ├ index.md
     ├ topics/{topic}.md          (curator 维护)
     ├ sources/{dispatchId}.md    (raw source 摘录)
     └ notes/                     (跨主题笔记)
   pet 通过 wiki_read toolkit(ls/cat/grep/find)自主检索。

─────────────── 产物层(Capability Artifact Store)───────────────
   {AGENT_HOME}/studio/{sid}/conv/{cid}/artifacts/
     └ {artifactId}/...           (capability 产物本体或外部引用)
   capability 完成时 sink,pet/Studio/UI 只传 ArtifactRef。

─────────────── 工人层(Capability / Subagent:pet 内部能力)──────
   每个 Pet 内部各自跑自己的 capability subgraph,具体执行工具调用。
```

**Studio 是 show-runner / 编剧统筹**:

- **planner agent** 像项目主编,turn 起始时被调一棒,自己理解需求、必要时向用户问,并通过 `studio_plan` capability 的 `list_pets` 工具查看 pet 职责与状态后产出 plan。它本身是一个普通 pet agent,通过同一个 capability 的 `submit_plan` 工具提交计划。
- **execute state machine** 像派单编辑,按 plan 顺序撰写 brief 派单,完成时收尾。是**确定性规则**,不耗 LLM。
- **wiki_curator** 像知识整理员,把每棒 pet 的产出整理进 wiki 文件,供后续 pet 检索。

planner 一个 turn 只跑一次(起始),execute 是常驻循环节点。execute 不自我修正大方向——遇到无法推进时,优先交付现有产出(`finish`)或异常停止(`stop`),让用户在 follow-up turn 决定方向。

类比:

- **影视摄制**:show-runner 统筹剧组,资料组(curator)整理资料库,每位创作者(pet)接到的是任务单 + 资料库访问权,具体内容自己查。成片是最后一棒的成品。
- **Claude Code 工作目录心智**:agent 拿到任务说明 + 工作区路径,自己用文件操作探索代码。这里把 wiki 当作工作区。

层与层之间的关系:

| 层 | 角色 | 实现形态 |
|---|---|---|
| Studio | 编排撰稿 + 路由调度 + wiki 维护 | **planner agent invoke + queue runner + wiki_curator** |
| Studio Whiteboard | 共享知识库 | 文件系统目录 + curator-managed wiki |
| Capability Artifact Store | durable 产物存储 | artifact refs + filesystem/backend store |
| Pet Agent | 数据加工者 | ReAct + LangGraph + wiki_read toolkit |
| Capability / Subagent | pet 内部能力 | ReAct + LangGraph |

三层共享同一套不变量:

1. 静态图 + 动态决策。
2. 边界处只通过 input/output 互动,内部状态私有。
3. 用 discriminated-union action(zod schema 校验)与相邻层通讯。
4. 单层失败止于该层与上层之间的 result/error 边界。

设计上**只描述一次模式,在三层上各应用一次**。新增 pet、新增 capability 都不引入新的架构概念。

两条硬约束:

- 用户最终答复来自末位 pet 的 返回文本,Studio 不在末端再生成内容。
- pet 之间的共享上下文由 wiki 承载,brief 只讲情境与任务,不指定 pet 该读哪些文件——pet 保留检索自主权。

## 三层各自是什么

### 第一层:Studio(StudioOrchestrator)—— 编排撰稿

- **是什么**:Studio 级 show-runner,由三件事拼成:planner agent invocation + execute state machine + wiki_curator 节点。
- **planner agent**:由 `plannerPetId` 指定的普通 pet runtime。turn 起始时 Studio 把它当成第一棒 invoke,临时注入 `studio_plan` capability。该 capability 暴露 `list_pets` / `submit_plan` 两个窄工具:planner 内部自由 reason、必要时 HITL 提问,按需读取 pet 列表,最终提交 task 列表。Studio 拿到 plan 后不再调用 planner。
- **execute state machine**:plan 存在后的确定性循环。规则固定:下一个 pending task → `dispatch`(撰写 brief);全部 satisfied → `finish`(标定末棒);否则 → `stop`。**不耗 LLM**。`ExecuteAction = dispatch | finish | stop`(3 个 type),zod 校验。
- **wiki_curator 节点**:每次 pet 返回 返回文本 后运行,把 raw source 整理进 wiki 文件(新增 topics、合并主题、更新 index)。实现可注入(默认 skeleton,production 用 LLM curator)。
- **可读取的范围**:pet registry、plan、turn state、wiki index 与按需的 wiki 文件、上一棒 result summary、artifact refs,必要时按 ref 读 artifact 内容。
- **边界**:capability、tool、底层 API 由 pet 调用;capability artifacts 由 capability/pet runtime sink 到 artifact store;wiki 文件写入由 curator 节点承担;用户最终答复由末位 pet 的 返回文本 提供。
- **设计立场**:execute 不自我修正大方向——若 plan 不再合理,优先 `finish`(交付当前可作产出)或 `stop`,把方向决策交还用户在 follow-up turn 解决。

`finish` action 标定 `finalDispatchId`,Studio 通过编排级事件流告知控制面；pet 内部工具时间线走 root stream:

- **`onTurnEvent`**(Studio→控制面):turn_started / plan_set / dispatch_started / dispatch_finished / wiki_updated / turn_finished 等编排级状态信号,低频、跨 pet 全局。控制面据此渲染状态栏、徽章、进度环。
- **root `streamEvents(v3)`**(pet/root→pet 面板):pet runtime 内部工具生命周期、runtime notice、subagent 消息等协议事件,由 adapter 投影成 UI 需要的事件。

两条消费路径互不重叠,UI 分别订阅各自的目标区域。详见 INTERFACES 文档的 root stream Boundary 与 ORCHESTRATOR_DESIGN 的 Turn State Stream 段(`onTurnEvent`)。

### 第二层:Pet Agent(PetAgentRuntime)—— 数据加工

- **是什么**:单 pet ReAct agent,复用现有 single-pet orchestrator graph。**实际加工产出的角色**。
- **角色定位**:每次 dispatch 接收 Studio 撰写的 brief 与 wikiRoot,自主访问 wiki 检索所需上下文,在自己的 capability 集合内完成加工,输出 返回文本。
- **输入**:Studio 撰写的 brief(自然语言任务说明字符串)+ wikiRoot + 必要 artifact refs + 自己绑定的 capability / tool 配置 + Studio 模式下默认装备的 `wiki_read` toolkit。
- **可用 action**:在 capability / tool 集合上 reason,通过 invoke 返回最终文本;工具事件通过 root stream 透出,撞到 HITL interrupt 时调构造时注入的 `humanReviewer` 桥拿决策(详见 INTERFACES 文档)。
- **检索自主权**:pet 自己决定怎么用 wiki(`ls` 看总览、`cat` 拉详情、`grep` 搜关键词),Studio 不指定具体文件。
- **隔离性**:pet 只感知本次 dispatch 收到的 brief 与 wiki 文件内容。是否存在其他 pet、自己是否在协作链中、是否是末棒——都由 Studio 编排,pet 视角下每次调用形态一致(brief + wikiRoot 永远是核心入口)。

### 第三层:Subagent / Capability(capability subgraph)—— 专项执行

- **是什么**:一个具体技能的子图,可以是单个工具,也可以是多步骤的 LLM + tool 组合。
- **角色定位**:pet 内部的专项工人,负责一项明确的技能。
- **输入**:本次 capability invocation 收到的输入、自己 declarative 声明的工具集。
- **输出**:结构化执行结果或缺口说明。
- **产物**:需要跨 lane / dispatch / UI 保留的结果 sink 到 capability artifact store,subagent lane messages 只保留运行现场。
- **隔离性**:只感知本次 invocation 的输入。所属 pet、所属 Studio、其它 capability 的运行情况均不在其视野内。

## 同一个循环骨架,不同的 reason 对象

三层都用同一个循环骨架(LangGraph + observe/reason/act),但每层关心的对象不同:

| 维度 | Studio | Pet | Capability |
|---|---|---|---|
| 节点构成 | planner agent invoke + queue runner + wiki_curator | 单 ReAct(可访问 wiki_read) | 单 ReAct |
| reason 关心什么 | (planner)计划生成 / (curator)知识整理;execute 不耗 LLM | 选 capability,组织本棒加工 | 选 tool,执行本步 |
| act 输出 | StudioTaskPlan / ExecuteAction / wiki 文件更新 | `capability_call` / `tool_call` / 工具事件 / 返回文本 / 错误 | `tool_call` |
| 终止条件 | execute 输出 finish/stop 或 planner 未提交 plan | task done 或正常 return | capability done 或 error |
| 上层看到的输出 | 末位 pet 的返回文本 | invoke 返回字符串 / question 事件 / error | capability result 对象 |
| 产出形态 | 编排决策 + 撰写好的 brief + wiki 文件 | 返回文本 + ArtifactRef[] | capability result + ArtifactRef[] |

上下文规模:

- Pet 与 Capability 的 reason 在自己的工作上下文里思考,通常加载完整工作记忆 + 选择性 wiki 内容。
- Studio 两个 LLM 调用各自上下文聚焦:planner 关心 userRequest + wiki index,并可通过 `list_pets` 按需读取 pet 职责与状态(决定 plan);curator 关心新 result + 现有 wiki(决定整理动作);queue runner 不耗 LLM。

第二层 ReAct 已经成立(single-pet orchestrator 在跑),第三层是同模式更细一层(capability 内部本来就这么做)。第一层是同骨架的编排:planner 本身就是一个第二层 pet(享受同样的 ReAct + capability/tool 基础设施),只是上面套了一个确定性 queue runner + curator——继承了 LangGraph supervisor pattern + show-runner 的职责切分 + Claude Code 工作目录的知识共享心智。

## 不变量(Invariants)

不变量是这个架构能否成立的脊梁。每层必须满足:

### I1. 静态结构 + 动态决策

每一层的图(节点 + 边)是**静态创建**的,不在运行时增删节点。变化的只有节点内 LLM 调用的输出和 act 的 routing 决定。

为什么重要:静态图可被 typecheck、可被 trace、可被 eval;动态图会让调试退化为"问 LLM 当时为什么这么走"。

### I2. 输入/输出隔离,无内外状态同步

每层只通过 input → output 与相邻层交互,**不维护对相邻层的影像**。

具体:

- pet 不维护"我知道有哪些 pet"的副本。
- capability 不维护"我属于哪个 pet"的副本。
- Studio 不维护"某 pet 内部 message history"的副本。

为什么重要:状态同步是分布式系统最大的复杂度来源。零同步 → 零一致性问题。

### I3. 单层失败 = 局部失败

任何一层的失败止于该层与上层之间的 result/error 边界。

- capability 失败 → pet 决定 retry / 改用别的 capability / 把 error 抛给 Studio。
- pet 失败 → Studio 决定 retry / 走 stop / 等下一 turn 由用户重新启动 planner。
- Studio 失败 → 用户层降级处理。

为什么重要:不需要全局事务、全局回滚。每层都有自己的本地决策空间。

### I4. Action 是 discriminated union + schema 校验

每层 reason → act 的 action 集合是穷举的、强类型的、zod 校验的。LLM 无法造词,非法 action 直接拒收。

为什么重要:LLM 唯一不可控的就是输出格式;把不可控压在 schema 边界,运行时就再无 LLM 漂移空间。

### I5. 上下文逐层收窄,wiki 作为共享知识层

```text
planner agent: userRequest + wiki index + studio_plan 工具(list_pets / submit_plan)
execute step : 不耗 LLM——纯规则,看 plan task 列表 + dispatch 历史
wiki_curator : 新 返回文本 + 现有 wiki 文件 + curator prompt
       ↓ 撰写好的 brief(自然语言任务说明,由模板拼装)+ wikiRoot 注入
Pet reason   : 本次 brief + 通过 wiki_read 自主拉取的 wiki 文件
       ↓
Capability reason: capability 自身输入
```

Studio 两个 LLM 调用上下文都是**选择性**的:

- planner 看 userRequest 与 wiki index,并按需调 `list_pets` 读取 pet 职责与状态(走 pet 自己的 reasoning 路径),不堆砌历史。
- curator 只读新 result + 现有 wiki,做增量整理。

queue runner 本身不维护 reasoning context,只看 task 列表与 dispatch 历史这两份结构化数据,撰写下一棒 brief 时按模板拼装(交给 wiki + pet 自主检索),不堆砌内容。

Pet 通过 wiki_read 自主拉取所需 wiki 文件,reason prompt 大小由 pet 自己控制(它知道要做什么、需要哪些资料)。

pet 返回文本和 ArtifactRef[] 保存在对应 dispatch state 中,作为 turn 内 dispatch 历史的一部分;wiki 是 curator 派生出的独立知识层,以文件形态存在;artifact store 是 durable 产物层。pet 主要通过 wiki 获取上下文,必要时按 artifact ref 读取产物内容,不读 dispatch 历史。

每层 prompt 都保持有限大小;Studio 两个 LLM 调用各自聚焦(planner 关心计划质量、curator 关心知识整理),queue runner 零 token,任一调用都比单一大 reason 更聚焦,token 成本由此可控。

## 为什么这套不变量能"组合成立" —— 概念性证明

不是每个不变量单独成立就够,关键是它们**互不冲突且互相加强**。

### 命题 1:协调复杂度从 O(N×M) 降到 O(N+M)

若 N 个 pet 可任意互相调用,协调复杂度是 O(N²)——每对 pet 都要约定接口、约定状态共享。

本架构强制所有 pet 只能与 Studio 通讯(I2):

```text
N 个 pet ↔ 1 个 Studio  +  Studio ↔ M 种调度策略
= O(N) + O(M)
= O(N + M)
```

新增一个 pet 不需要改其它任何 pet,也不需要改其它 capability,只需要 Studio 知道有这么个 pet。

### 命题 2:单 agent 模式 = 多 agent 模式的退化形式

由于 I2(pet 零环境感知),pet 在以下两种调用下**收到的输入形状一致**:

- Studio 模式:Studio 派一个 task。
- 单 agent 直对话模式:用户直接发消息。

两种模式下 pet 的代码路径**完全相同**,UI 渲染逻辑也可复用。

含义:**多 agent 不是新写一套系统,而是给已有的单 agent 套一层 orchestrator**。这等价于:如果今天的单 pet 已经能用,多 pet 几乎一定能用——只是上面加了一个同结构的 ReAct 层。

### 命题 3:同骨架不同职责 → 心智模型只学一次半

由于三层共享 LangGraph + discriminated action + 静态图 的骨架,工程实践(trace、eval、prompt 模式)跨层通用。差别只在 Studio 的 reason 对**路由**思考(轻),Pet/Capability 的 reason 对**数据**思考(重)。

含义:理解 Pet/Capability 的 ReAct 后,只需要额外理解"控制平面 vs 数据平面"这一点,就能理解 Studio——不是从头学新概念。

这是工程经济性的关键。每多一个抽象层通常意味着一倍的认知成本;而**骨架重复 + 职责分离**让认知成本是 ~1.5× 而不是 3×。

### 命题 4:动态行为有界,因为静态结构有界

由 I1(静态图)+ I4(action schema 穷举),每层在任何 turn 内可能走的状态机路径是**有限可枚举的**。这意味着:

- 可以为每层写完整的 eval 套件覆盖所有 action lane(参考 [[reference_pet_agent_evals]] 已经在单 pet 层做的)。
- 可以做完整的 trace shape 假设。
- 可以做 budget guardrail(maxIteration、maxRetry、maxFollowupDepth)的形式化推理。

LLM 在每层只在 reason 节点产生不确定性;**这种不确定性被 schema 与 budget 双重包围**,系统整体可证终止。

### 命题 5:递归终止有界

```text
maxIterationCount (Studio)  × 
maxToolCalls     (Pet)      × 
maxCapabilitySteps (Capability)
= 最大总步数,有限
```

不存在 pet→pet→pet 的无界递归(I2 禁止),不存在 capability 互调(也是 I2),因此整个 turn 在最坏情况下也是有限步终止。

## 实际跑通的链路示例

一次"帮我写小红书脚本"请求的全链路:

```text
User: 帮我开始写小红书短视频脚本

Studio.obtainPlan
  invoke planner pet, brief = "帮我开始写小红书短视频脚本"
    planner pet reason: 信息不足(主题方向、目标观众)
    planner pet 通过自己的 HITL 桥(humanReviewer)向用户提问:
      "脚本的主题方向?目标观众?"
  User(在 planner 对应的 pet 面板上回答): 美食探店,Z 世代
    planner 续跑,调 submit_plan tool:
      tasks: [                       # 顺序即执行顺序,数组下标即 task 身份
        { petId: script, goal: "写脚本结构",      ... },   # taskIndex = 0
        { petId: audio,  goal: "补尾音频 + 整合", ... },   # taskIndex = 1
      ]
  Studio 拿到 plan → 转 execute

execute → dispatch(taskIndex=0, brief = "流水线第 1 棒。写美食探店 Z 世代视频脚本结构。")
  Pet:script
    收到 brief
    wiki_read.ls()  # 此刻可能为空或仅 index
    reason: 应调 trend_video_script capability
    capability_call(trend_video_script, {...})
      Capability 内 ReAct 若干轮,产出 scriptOutline
    返回文本:
      summary: "已完成脚本结构,缺口标记:尾音频未定"
      artifacts: [{ artifactId: "...", title: "scriptOutline" }]

  wiki_curator
    新增 topics/script-structure.md
    写入 scriptOutline artifact ref 与摘要
    更新 index.md
    写 sources/{dispatchId}-script.md(原始素材摘录)
  task t1.status = satisfied

execute → dispatch(taskIndex=1, brief = "流水线第 2 棒。前面已完成脚本结构,相关内容已纳入 wiki。
                                 本棒目标:补足尾音频策略与口播节奏,并整合为可交付的完整说明。
                                 本棒承担整合输出。")
  Pet:audio
    收到 brief
    wiki_read.cat('index.md')                  # 看 wiki 概览
    wiki_read.cat('topics/script-structure.md') # 拉详情
    capability_call(video_tail_audio, {...})
    返回文本:
      summary: "已整合脚本结构,给出尾音频策略与口播节奏"
      artifacts: [{ artifactId: "...", title: "finalDeliverable" }]

  wiki_curator
    更新 topics/audio-strategy.md
    写入 finalDeliverable artifact ref 与摘要
    刷新 index.md
    写 sources/{dispatchId}-audio.md
  task t2.status = satisfied

execute → 全部 satisfied → finish { finalDispatchId = t2 的 dispatch }

UI: pet:audio 的 返回文本 渲染到主对话面板
```

验证点:

- **Studio 撰写 brief 时只讲情境与任务**——不指明 pet 该读哪些文件,检索由 pet 自主完成。
- **每棒 pet 的产出由 curator 整理进 wiki**——后续 pet 通过 wiki_read 直接访问,Studio 不在 brief 里重复打包内容。
- **末位 pet(audio)的 返回文本 = 用户最终答复**——UI 直接渲染。
- **pet:audio 与 pet:script 互相不感知**——但用户感受是一个连贯的协作,因为 wiki 把上游产出沉淀成可检索的知识。
- **planner agent 只在 turn 起始被调一次**——queue runner 是常驻循环节点;遇到无法推进时优先 `finish`(交付)或 `stop`(放弃),不自动回 planner。
- **HITL 完全在 pet 内部**——Studio 视角下 dispatch 一直处于 running 直到 result 抵达。
- **capability 出错局部消化**——pet 可 retry / 改用其它 capability / 通过 invoke 抛出 error。

## 这套架构换来了什么 / 付出了什么

### 换来

| 能力 | 来源不变量 |
|---|---|
| 新增 pet 不影响其它 pet | I2 |
| 新增 capability 不影响 pet 代码 | I2 |
| 单 agent 和多 agent 共用代码 | I2 + 命题 2 |
| 全链路可 trace、可 eval | I1 + I4 |
| 上下文窗口可控 | I5 |
| Turn 可证终止 | 命题 4 + 5 |
| 同一套工程实践覆盖三层 | 命题 3 |

### 付出

- **跨层 hop 的 latency**:每棒包含 pet 处理 + wiki_curator 一次 LLM;turn 起始还有 planner agent 一次完整 invoke。queue runner 本身不耗 LLM,但整体延迟仍比单体 agent 高(可被并发/缓存缓解)。
- **Studio prompt 工程**:planner agent 的 system prompt + `studio_plan` capability prompt + curator prompt 三处各自需要维护;curator prompt 还要支持用户自定义。
- **wiki 维护成本**:每棒 pet 完成后 curator 都要跑一次 LLM 整理;文件 IO 与目录管理。
- **eval 工作量分层**:planner eval 计划质量,curator eval 知识整理质量,pet eval 数据加工质量。queue runner 不需要 LLM eval,只需要状态机单元测试。

这些代价是**线性可预测的**,不是指数发散的。MVP 阶段聚焦 planner agent + queue runner + curator + Pet ReAct,capability 层复用现有 single-pet 实现。

值得指出的收益:

- **末位 pet 直接交付** 避免了末端再跑一次大上下文 LLM 聚合,token 成本与产出归属都更清晰。
- **wiki 共享知识** 避免了 brief 里反复打包上游内容造成的累积膨胀,长流水线协作可控。
- **文件化 wiki** 让 curator 行为可观察、可手工纠错、可归档复盘——调试与审计成本下降。

## 这不是凭空发明 —— 现有 Existence Proofs

同型结构已在以下系统中验证可行:

- **LangGraph supervisor pattern**:官方就支持 supervisor + worker agents,与本架构 Studio + Pet 同构。
- **AutoGen GroupChat / Magentic**:微软多 agent 框架,中央 manager + 专项 agent。
- **Claude Code / Devin 等 sub-agent 模式**:主 agent 派 sub-agent,sub-agent 不感知兄弟 sub-agent。
- **OS 进程监督树**(init / systemd / Erlang/OTP):监督者 + 工作进程 + 局部失败隔离,几十年验证。
- **HTN(Hierarchical Task Network)规划**:经典 AI 规划领域,任务分解为子任务,递归求解。
- **微服务 + orchestrator**:服务网格的标准做法。

我们没有引入任何这些系统里没有出现过的新概念。差别只在:**我们针对宠物 agent 的具体语义把每层的不变量写死,把 LLM 不可控点压在 schema 边界**。

## 何时这个架构会失效

诚实地说,以下情况这套设计会失灵,需要重新审视:

1. **真正需要 pet 之间双向连续对话**:比如两个 pet 实时 argue 一个判断。本架构禁止 pet→pet 直连,会强制把对话拆成 N 次 turn,体验下降。MVP 我们假设这不是必需场景。

2. **需要全局共享 working memory**:比如所有 pet 需要看同一份"项目档案"实时同步。I2 禁止状态同步,这种场景要外挂存储 + artifact 引用,变绕。

3. **延迟敏感场景**:三层各一次 LLM 调用,对秒级响应场景不友好。需要在 capability 层做缓存或预热。

4. **超长协作**:虽然命题 5 保证有界终止,但 turn 内 iteration 上限调高时 token 成本会非线性增长(每轮 observe 都要读 dispatch 历史和 wiki index)。需要 turn 间记忆压缩。

这些都是 **已知的、可识别的、可规避的** 失效模式,而不是"突然崩塌"。这正是本架构相对开放式多 agent 系统的优势:**失败模式有限可枚举**。

## 结语

Studio → Agents → Subagents 是**编排撰稿层 + 共享知识层 + 数据加工层**的递归组合:

- 加工层(Pet + Capability)沿用已验证的 ReAct 模式。
- 编排层(Studio)拼成三件事:planner agent invoke(planner 是普通 pet,通过 `studio_plan` capability 的 `list_pets` / `submit_plan` 工具读取 pet 视图并提交计划)+ 确定性 queue runner + wiki_curator 节点。
- 共享知识层(Studio Whiteboard)是文件系统目录,curator 维护、pet 自主检索。

可行性建立在已经存在的事实之上:

1. 单 pet ReAct 已经在跑(加工层的递归基础)。
2. LangGraph 的静态图 + checkpointer + interrupt 支持已经验证(I1、HITL)。
3. discriminated union + zod 校验 + LangSmith trace 套件已经在使用(I4 + eval)。
4. 文件操作 toolkit(bash)已在分支中存在,wiki_read 是其受限封装。

已经在 `packages/pet-agent/src/agent/studio/` 落地的部件:

- **composer**:`createStudioOrchestrator` 拼起 planner agent invoke + execute 状态机 + wiki_curator(详见 ORCHESTRATOR_DESIGN)。
- **接口契约**:`PetAgentRuntime.invoke({ brief, wikiRoot, signal, ... })` + wiki middleware + artifact refs + `humanReviewer` 桥；实时工具/运行时事件走 root stream adapter(详见 INTERFACES)。
- **Studio Whiteboard 文件目录**:`{AGENT_HOME}/studio/{sid}/conv/{cid}/wiki/`,curator 维护,pet 通过 `wiki_read` toolkit 访问。
- **两条独立消费路径**:`onTurnEvent`(Studio→控制面)与 root `streamEvents(v3)` adapter(pet→pet 面板),各自驱动各自的 UI 区域。

后续工作集中在 local-agent 接入(Phase 2)、能力增强与并行 dispatch(Phase 3+)。

关键洞察:

- **Studio 撰写 brief,不撰写最终答复**——末位 pet 的 返回文本 直接交付。
- **Studio 维护 wiki,不在 brief 里堆内容**——brief 只讲情境与任务,pet 通过 wiki 自主检索所需上下文。
- **wiki 是文件系统**——天然可观察、可手工纠错、可归档复盘。

这是工程,不是研究。planner-as-agent + 确定性 queue runner + 文件化 wiki 把成本、归属、调试心智都收敛到清晰的边界内。
