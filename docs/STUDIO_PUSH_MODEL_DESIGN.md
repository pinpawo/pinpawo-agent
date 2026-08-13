# Studio 契约:插板与推模型

Tracking issue: #561
契约代码: [`packages/studio/src/studioContract.ts`](../packages/studio/src/studioContract.ts)
配置目标形态: [`STUDIO_CONFIG_TARGET_EXAMPLE.md`](STUDIO_CONFIG_TARGET_EXAMPLE.md)

**总原则:一切的目标是简单。** 下面每一条取舍,判据都是"哪个更简单",
而不是"哪个更完备"。

---

## 1. Studio 是一块插板

Studio 是**抽象的多 pet 管理器**:它提供两个方向的通道,不提供任何管理策略。

```text
plugin ──event────> studio ──dispatch──> pet
```

三层关系:**插件是管理的上层,studio 是中间的契约层,pet 是下层。**

Studio **不包含职责,但需要形成契约**。它不决定什么时候派、派给谁、任务
怎么排 —— 那些是插件的职责;它只定义这些交互长什么样。

---

## 2. 两个方向

### 2.1 出:`dispatch`

**所有派活必经 studio。** 插件不能绕过它直接碰 pet —— 否则 pet registry、
身份与可派发性判断会在每个插件里重复一遍。

```ts
dispatch({ petId, request, correlationId? }) => { threadId }
```

`request` 是自然语言 —— studio 不定义任务结构。

**dispatch 是点对点的。** 它只到达目标 pet:不上 event 总线(那会让每个
插件都看见谁给谁派了活,凭空制造插件间的耦合),也不进 `pet.invoke` ——
pet 不需要知道是谁派的。

studio 记录**谁派的**:插件派活时是插件名(由 studio 从它的 context 补,
插件填不了也不用填 —— 自报的来源迟早会撒谎),外部输入则是 `studio`。
目前**只做记录**,不限流、不去重、不据此路由。

`request` 之外不带装配细节。曾经有 `extraCapabilities` / `toolkits` 两个字段
让调用方临时给 pet 塞能力 —— 那是越界:pet 该有什么能力是 pet 配置的事
(`pets/*.json`),插件不该参与 pet 的构造。两个字段都无人使用,已删。

#### 每个 pet 一条队列

**studio 收下所有 dispatch,pet 空了就发 —— 插件完全不用关心 pet 忙不忙。**

这才是"所有派活必经 studio"真正解决的问题:多个插件(kanban、scheduler、
http…)会并发给同一个 pet 派活。此前第二个会撞上 `status === 'active'` 被
拒,派活凭空丢掉 —— 而 §4.2「失败留着等人」说的是**任务失败**,不是"插板忙,
请稍后",两者不该混成同一个错误。

排队**不是业务**:它不决定派给谁(那是插件的事),只保证已经收下的派活不会
因为撞车而丢。与 `notify` 保证每个订阅者都收到是同一类事 —— 通道自身的完整性。

dispatch 依然立即返回 `{ threadId }`。只有 `disabled` 的 pet 会被拒,"正忙"
不是错误。

**返回值只表示"已经发出去了",不表示任务完成。** 没有 reply、没有成功失败
判定。pet 干完之后自己经由 toolkit → 插件 → event 汇报。

### 2.2 入:`event`

插件发给 studio 的通知,studio 广播给其他插件。它是**插件之间的共享总线**
—— 让互不认识的插件能交换信息。

```ts
type StudioEvent = {
  type: string;          // 插件自行命名，studio 不认识任何具体类型
  source: string;        // 哪个插件发的
  correlationId?: string;
  payload?: unknown;     // 不解释、不校验
  occurredAt: string;
};
```

**studio 不解释 event 内容,也不持有由 event 推导出的状态。**

事件是"发生了什么"(一次性、单向),不是"当前是什么样"(可查询、有生命
周期)。这个区别决定了 studio 不需要存储、不需要一致性、不需要处理并发写。

### 2.3 两个方向互不配对

**这是最容易丢失的一条不变量,写在这里防止反复重新推导。**

`dispatch` 和 `event` 是**两条独立的单向通道**,不是一次请求的两半:

- studio **不**记录"这次 dispatch 对应哪个 event";
- studio **不**等待、不超时、不判定某次 dispatch 是否"有回应";
- 一次 dispatch 可能引发零个、一个或很多个 event,也可能永远没有;
- 一个 event 可能与任何一次 dispatch 都无关(定时触发、外部 webhook)。

`correlationId` 是**插件自己的关联凭据**,studio 原样透传、从不解释,
也从不用它做匹配。kanban 往里放 `taskId`,别的插件放什么是它自己的事。

### 2.4 外部输入没有专属入口

曾经有个 `submitRequest(goal)`,等价于 `dispatch(entryPetId, goal)`。**它是
多余的** —— 两个方法做同一件事,却让 entry pet 在 API 上有了专属地位。按插板
的逻辑,entry pet 只是配置里的一个 pet。

现在 studio 暴露 `entryPetId`,宿主自己 `dispatch({ petId: entryPetId, ... })`。
外部输入与插件委托走同一条通道、同一个契约,只是 `source` 不同。

---

## 3. 插件就是 toolkit 加一个切面

```ts
type StudioPlugin = AgentToolkit & {
  studio?: {
    start: (context: StudioPluginContext) => Promise<void> | void;
    stop?: () => Promise<void> | void;
  };
};
```

现有 toolkit 变成插件只需补一个字段,不必重写:

```ts
const plugin: StudioPlugin = {
  ...existingToolkit,                  // 原样复用
  studio: { start: (ctx) => { ... } },  // 只补这一段
};
```

> 一度设计成独立的 `{ name, start, stop, toolkit? }`。**那是错的** ——
> `AgentToolkit` 已经有 `runtime.start` / `runtime.stop`,并排放第二套
> 生命周期只会让两者不同步。

### 3.1 两副面孔

| 身份 | 插在哪 | 做什么 |
| --- | --- | --- |
| toolkit | pet | 让 pet 读写它的领域数据 |
| 插件 | studio | 委托 dispatch、发 event |

两者都可选:`studio` 省略时它是普通 toolkit;`tools` 为空时它是纯驱动方。

**闭环由这两副面孔自然形成:**

```text
pet ──调用──> toolkit ──> 插件内部状态 ──event──> studio ──> 其他插件
```

pet 只跟 toolkit 打交道,**从不直接与 studio 通信**。整条链没有一处需要
studio 理解内容。

**产出的归宿是插件,不是 studio。** pet 干完活调的是插件给它的 toolkit
(kanban 给的是 `kanban_task_*`),数据落在插件自己的状态里;要不要再发
event、发什么形状,由插件决定。所以:

- **怎么往回写,是插件的事。** studio 不提供"汇报"接口,只提供 `notify`
  这一个入口;插件不发,studio 就什么都不知道 —— 这是设计,不是缺陷。
- **存不存、存在哪,是插件的事。** studio 不持久化任何东西(它本来就不持
  有由 event 推导出的状态),插件的领域状态由插件自己落盘。
- **pet 卡住了怎么表达,是插件的事。** studio 不认识 review、不认识"等待",
  要让"在等人"可见,得由插件把它变成一个 event。

判断归属的口诀:**问题若涉及具体领域(任务、进度、排期、评审、落盘),
答案一定在插件侧;studio 只负责通道的形状。**

---

## 4. 推模型:Studio 派完就不管

此前的隐含假设是**拉模型** —— studio 派活后盯着等结果:

```text
studio ──派活──> pet
   ↑              │
   └─── 等结果 ────┘        ← studio 必须知道 pet 在干什么
```

这带来一连串问题:pet 等人时算不算"在执行"、谁判定超时、结果怎么送回来。

**推模型把方向反过来。** 由此:

- studio **不需要知道** pet 在跑模型、在等工具、还是在等人;
- "谁把结果送回 studio"这个问题**不存在** —— 没有人在等。

### 4.1 HITL 对 Studio 透明

Studio 不需要知道 review 概念。等人只是**执行的一种形态**,与"在跑模型"
没有区别。

一度担心:pet 被框架打断去做 review 时没机会主动汇报,是否需要框架兜底?

**这个顾虑本身是错的。** review 是 pet 与人之间的事 —— 人已经在跟 pet 打
交道了,再让 studio 知道一遍是多余的一层。

> 类比:企业管理中,如果每个细节都要闭环上报,管理成本会压垮组织。
> 不是所有闭环都需要汇总 —— 需要汇总时 pet 主动报,或者从插件的领域数据里
> 去发现。

### 4.2 卡住不需要检测

推模型下没人在等,pet 崩了怎么办?

**不需要超时判定。** 进度停滞在插件的领域视图里是**自明的** —— 不需要系统
去"检测"再盖一个 FAILED 的章。这与执行拓扑无关:并行是多条进度线,串行是
一条,哪条不动都同样一眼可见。

**推论:自动重试退役。** 失败就留着,由人决定要不要重来 —— 自动重试是在替
人做判断,而失败原因往往需要看一眼才知道该不该重试。

### 4.3 `waitForRun` 退役,提交即返回

`waitForRun()` 让 studio 必须知道 run 何时结束 —— 而 run 是插件的概念。

```text
之前:提交 → 阻塞等待 → 返回最终结果
现在:提交 → 立即返回 → 客户端之后自己看插件的视图
```

这是本次唯一的**对外协议行为变化**,需在 PR 中显著标注。

---

## 5. Studio 的边界

**属于 studio**

- pet registry、pet 身份与可派发性
- `dispatch` 契约(唯一出口)+ 每 pet 的派活队列
- `event` 总线(唯一入口 + 广播)
- 插件配置:这个 studio 装哪些插件

**不属于 studio**

- 任务怎么拆(planner 是 pet,不是 studio 的一部分)
- 任务队列、依赖、进度呈现
- 什么时候派谁
- run 何时结束 —— studio 甚至不需要知道 "run" 这个词
- **传输与界面** —— 见下

### 5.1 `subscribe` 是插件间的总线,不是对外的出口

契约里只有两个方向,`subscribe` 不是第三个:

```text
plugin ──notify──> studio ──broadcast──> 其他 plugin
                                   ↑
                            插件间共享总线
```

**studio 自己从不 subscribe 任何东西。** 它经 `notify` 接收、向订阅者广播,
仅此而已。`subscribe` 是 `StudioPluginContext` 给**插件**用的 —— 让互不认识
的插件交换信息(kanban 发 `task.done`,scheduler 听见了决定要不要排下一次)。

### 5.2 与 local-agent 只有一个接触点

**dispatch 需要一个能真正跑起来的 pet —— 仅此而已。**

```ts
createStudio({ studioId, pets: PetAgentRuntime[], entryPetId, plugins })
```

`pets` 是接口。谁实现它、跑在哪台机器上、怎么连模型,studio 一概不知。
local-agent 把实现注进来,方向是**单向**的:studio 从不反过来向 local-agent
要任何东西。

所以 studio 不认识 ws、peer、TUI、requestId、session —— 不是"暂时没用到",
而是**没有任何理由用到**。`@pinpawo/studio` 的 dependencies 里只有
`@pinpawo/pet-agent`,包内搜不到 tui / ws / peer / requestId 任何一个词。
这是这条边界的检验方式。

推论:**凡是需要在 studio 里增加一个概念来配合宿主的想法,都是错的。**
先回到这一节确认接触点是不是真的多了一个 —— 通常没有。

---

## 6. 缩减结果

已落地。旧的 `createStudioOrchestrator.ts`(1070 行)整体删除,取而代之的是
`createStudio.ts`(157 行)—— 它只做转发,没有任何管理策略。

| 随推模型消失 | 去向 |
| --- | --- |
| `runDispatch` 等结果、判定 satisfied/failed | 删除:pet 自己汇报 |
| `dispatchQueuedTask` 完成回调链 | 删除:同上 |
| `activePets` 单槽、重试计数、结果聚合 | 删除:并发与重试由插件决定 |
| `StudioRun` / `StudioTask` / 依赖模型 / 进度状态机 | 迁往 `@pinpawo-toolkit/studio-kanban` 的 `KanbanBoard` |
| `dueRun*` / `runQueuePort` / `localStudioDueRunScheduler` | 删除,见 §8.1 |
| 私有 HITL `while(true)` 循环 | 删除:§4.1 |
| wiki curator / skeleton 钩子 | 删除:写知识库是插件的事,studio 不在回路上 |

`@pinpawo/studio` 现约 800 行(含契约、配置解析、wiki 只读 port),不碰文件系统。

---

## 7. 本次转变推翻了什么

诚实记录,避免后续从错误前提出发:

| 此前结论 | 现状 |
| --- | --- |
| HITL bridge 应迁到 invocation scope(#229) | ❌ 应删除,不是迁移 |
| `invoke()` 返回 `waiting_review`(#618) | ❌ Studio 不该认识 review |
| 需要"resume 完成后回调 studio" | ❌ 伪需求;推模型下无人在等 |
| 需要超时机制判定卡住 | ❌ 插件视图上自明 |
| 重试预算需持久化(#606) | ❌ 自动重试整体退役 |
| studio 需要可插拔的"驱动器插槽" | ❌ 插件本身就是驱动器 |
| 插件是独立于 toolkit 的新概念 | ❌ 就是 toolkit 加一个切面 |
| `submitRequest` 需要路由给某个插件 | ❌ 它就是一次 dispatch,方法本身已删 |

`checkpointer`(#613)**不受影响** —— pet 执行进度仍需落盘,与谁驱动无关。

---

## 8. 插件路线图

契约与具体插件无关。以下只是**将要实现的第一批**,不构成对 studio 的约束。

| 插件 | 依据 | 状态 |
| --- | --- | --- |
| kanban | 任务依赖 + 进度 | ✅ 本次落地 |
| scheduler | 时间(cron) | ⏸ 见 §8.1 |
| trigger | 外部事件(webhook / 文件变化) | 未开始 |

### 8.1 scheduler:为什么先删掉,以及怎么回来

原 `localStudioDueRunScheduler` 是 scheduler 的雏形,但它是**按拉模型写的**:
轮询 `dueRun` 存储、构造 `StudioRun`、调用 orchestrator 并等结果。这三件事在
推模型下全部不成立,没有一行可以直接复用。留着它只会让人以为 scheduler 还在工作。
所以本次连同 `dueRunContract` / `runQueuePort` / `fileDueRunStore` 一并删除,
而不是改造。

回来的时候,它应该是一个**和 kanban 平级的普通插件**,形态由契约直接决定:

1. **`AgentToolkit` 面** —— 给 pet 一组工具排期,例如
   `schedule_add({ cron, request, petId })` / `schedule_list` / `schedule_cancel`。
   与 kanban 同理,`bindTools` 已带 `execution.threadId`,pet 不需要转抄任何 ID。
2. **`studio.start(context)` 面** —— 起自己的定时器。到点直接
   `context.dispatch({ petId, request })`,派完即忘;不等结果,不判定成败。
3. **自己的存储** —— 排期表是插件私有状态,和 `KanbanBoard` 一样由插件持有并落盘。
   studio 不知道"排期"这个词。
4. **经 `notify` 汇报** —— 触发、跳过、取消都作为 event 发回 studio,由订阅方
   (UI、kanban)自行解释。

前置条件只有一个:插件持久化的落盘位置需要与 kanban 统一(§9.1)。
其余部分不依赖 studio 再做任何改动 —— 这正是插板契约要达到的效果。

---

## 9. 待定项

1. **插件状态的落盘约定**。`KanbanBoard` 目前自己管持久化,scheduler 回来时会
   面对同一个问题。需要一个统一位置(大概是 `.pinpawo/studio/<plugin-id>/`),
   但这属于宿主约定,不进契约。
2. 各插件的领域模型与生命周期形态(属于插件自身,不进本契约)。
3. event 是否需要"至少一次"投递保证。目前是纯内存同步扇出,进程重启即丢。
   在插件自己持久化状态的前提下,这可能一直够用。**但插件之间若靠 event
   推进状态(如 scheduler 听 `task.done` 决定下次排期),丢一条就是丢一次
   排期** —— 需要明确"event 只做通知,不承载状态推进",还是补投递保证。
4. 插件的 `start` 顺序即配置顺序,`stop` 逆序。若先启动的插件在 `start` 里
   立刻 dispatch,后启动的插件还没 subscribe,会漏掉那批 event。插件之间
   确实可能有依赖,所以顺序需要保留 —— 但"start 里不要立刻干活"这条纪律
   目前只是约定,没有写进契约。
