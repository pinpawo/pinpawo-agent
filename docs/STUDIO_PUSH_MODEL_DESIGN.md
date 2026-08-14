# Studio 契约:插板与推模型

Tracking issue: #561
契约代码: [`studioContract.ts`](../packages/studio/src/studioContract.ts) ·
[`createStudio.ts`](../packages/studio/src/createStudio.ts)
配置: [`STUDIO_CONFIG_TARGET_EXAMPLE.md`](STUDIO_CONFIG_TARGET_EXAMPLE.md)

本文是 studio 的 canonical 设计。`docs/` 下其余 `*STUDIO*` 文档描述的是已经
不存在的实现,以本文为准(见附录)。

| 想知道 | 看 |
| --- | --- |
| studio 是什么、暴露什么 | §1 |
| 怎么把活派给 pet | §2 |
| 派出去之后会怎样 | §3 |
| 插件之间怎么交换信息 | §4 |
| 怎么写一个插件 | §5 |
| **能不能往 studio 里加个东西** | **§6** |

---

## 1. Studio 是一块插板

Studio 是**抽象的多 pet 管理器**:它提供两个方向的通道,不提供任何管理策略。

```text
plugin ──event────> studio ──dispatch──> pet
```

三层关系:**插件是管理的上层,studio 是中间的契约层,pet 是下层。**

Studio **不包含职责,但需要形成契约**。它不决定什么时候派、派给谁、任务
怎么排 —— 那些是插件的职责;它只定义这些交互长什么样。

### 1.1 契约全貌

一屏看完 studio 暴露的全部东西:

```ts
type Studio = {
  entryPetId: string;                    // 外部输入的默认目标,无特权
  dispatch: (input) => Promise<{ threadId }>;
  notify: (event) => void;
  subscribe: (handler) => () => void;
  listPets: () => PetAgentRuntimeDescriptor[];
  shutdown: () => Promise<void>;
};

// 插件拿到的那一份 —— 多一个回路,少一个 shutdown
type StudioPluginContext = {
  dispatch: (input) => Promise<{ threadId }>;   // source 由 studio 补
  onDispatchGate: (handler) => () => void;      // 只听自己派出去的
  notify: (event) => void;                      // source 由 studio 补
  subscribe: (handler) => () => void;
  listPets: () => PetAgentRuntimeDescriptor[];
};

// studio 对 runtime 的全部要求 —— 与宿主唯一的接触点
type PetAgentRuntime = {
  descriptor: () => PetAgentRuntimeDescriptor;
  invoke: (input) => Promise<{ reply }>;
  gate: () => PetGateState;                     // open / busy / waiting / blocked
  onGateChange: (listener) => () => void;
  shutdown?: () => Promise<void>;
};
```

没有别的了。凡是想往这里加东西的念头,先回 §6 确认它是不是通道的形状。

### 1.2 推模型:派完就不管

**派活是单向的。** studio 把请求交给 pet 之后不再持有它 —— 没有等待,没有
超时,没有成败判定。

```text
studio ──dispatch──> pet ──调 toolkit──> 插件状态 ──event──> studio
        (到此结束)                                    (另一条独立通道)
```

由此得到两条性质,它们是后面所有设计的前提:

- studio **不需要知道** pet 在跑模型、在等工具、还是在等人;
- **"谁把结果送回 studio"这个问题不存在** —— 没有人在等。

pet 的产出经由 toolkit 落在插件自己的状态里(§5.1),与 dispatch 无关。

---

## 2. 派活:`dispatch`

```ts
dispatch({ petId, request, correlationId? }) => { threadId }
```

返回 `{ threadId }` 表示**已经发出去了**,不表示任务完成。契约里没有阻塞
等待的入口 —— 要知道进展,去看驱动它的那个插件的领域数据。

`request` 是自然语言,studio 不定义任务结构。入参里**不带装配细节**:pet 该
有什么能力是 pet 配置的事,插件不参与 pet 的构造。

### 2.1 所有派活必经 studio

插件拿不到 pet 的引用:`listPets()` 只返回纯数据 descriptor。这是**机制
保证**而非约定 —— 否则 pet registry、身份与可派发性判断会在每个插件里重复
一遍,并发派活时也没有地方能协调。

### 2.2 dispatch 是点对点的

它只到达目标 pet:

- **不上 event 总线** —— 那会让每个插件都看见谁给谁派了活,凭空制造插件
  间的耦合;
- **不进 `pet.invoke`** —— pet 不需要知道是谁派的。

studio 记录**谁派的**:插件派活时是插件名,由 studio 从它的 context 补齐 ——
插件填不了也不用填,自报的来源迟早会撒谎。外部输入记为 `studio`。这个记录
只用于日志,不限流、不去重、不据此路由。

### 2.3 只有三种情况会被拒

| 情况 | 报错 |
| --- | --- |
| studio 已 `shutdown` | `already shut down` |
| petId 不在这块 studio 上 | `unknown petId "…"` |
| pet 的 `startupMode` 是 `disabled` | `pet "…" is disabled` |

**"正忙"不在其中** —— 那是队列的事(§3)。三者都是"这条派活压根发不出
去",与"发出去了但没干成"性质不同;后者不抛错,由闸门表达。

### 2.4 外部输入没有专属入口

外部输入就是一次 `dispatch({ petId: entryPetId, request })`。studio 暴露
`entryPetId` 供宿主取用,除此之外 entry pet 与别的 pet 没有区别 —— 契约里
不存在"提交目标"这类专属方法。

外部输入与插件委托走同一条通道、同一个契约,只是 `source` 不同。

---

## 3. 派出去之后:队列与闸门

### 3.1 每个 pet 一条队列

**studio 收下所有 dispatch,pet 空了就发 —— 插件完全不用关心 pet 忙不忙。**

多个插件(kanban、scheduler、http…)会并发给同一个 pet 派活。队列让它们不必
各自处理撞车:**排队不是业务**,它不决定派给谁(那是插件的事),只保证已经
收下的派活不会因为撞车而丢。这属于通道自身的完整性,与 `notify` 把 event 扇
给每个订阅者是同一类事,都不涉及内容。

pet 之间并行,单个 pet 内串行。队列只在内存里(§7 开放问题 1)。

### 3.2 闸门:队列凭什么放行

队列**不能**靠"上一次 `invoke` 返回了"放行 —— pet 撞到人工确认时 `invoke`
会提前返回,活并没有干完。照此放行,同一个 pet 会同时有两条活:一条悬着等
人,一条在跑。

所以 runtime 暴露一扇闸门:

| 状态 | 含义 | 门 | 谁能推动 |
| --- | --- | --- | --- |
| `open` | 空闲 | 开 | — |
| `busy` | 正在跑(模型 / 工具 / subagent) | 关 | **它自己会好** |
| `waiting` | 等外部输入 | 关 | 只有人 |
| `blocked` | 失败 / pet 声明干不了 | 关 | 只有人 |

判据是 checkpoint 上还有没有待跑节点(`next` / `tasks`),与 chat 路径同源。

四种而非两种,是因为门关着的原因分两类,而这个区别对**看的人**是必要的:
`busy` 的队列在动,等就行;`waiting` / `blocked` 的队列永远不会自己动。

**失败必须停下。** 队列里排着的活往往彼此依赖 —— 前一条写文件失败了,后一条
接着去改那个文件,那不是"下一个任务也失败",是在坏掉的状态上继续操作。破坏性
正是这么来的。

**门只由"活干完了没有"决定,不由 review 决定。** 人回答完了任务还得继续跑,
门当然还关着。§3.4 因此成立。

### 3.3 闸门的两条边界

**没有控制面。** 闸门是一面镜子,不是开关 —— studio 只读,不能操作 pet。
人要解开卡住的 pet,走 chat 路径直接跟它对话(两条路共用 checkpointer),
与 studio 无关。

**读不到判据时一律放行。** 没有 checkpointer、拿不到 threadId、`getState`
抛错 —— 三种情况都开门。关着的代价是**这个 pet 永久锁死**(没有控制面能解开
它),开着的代价只是退回"撞车可能并发"。宁可退化,不可锁死。

> 推论:**没有 checkpointer 的 studio 等于没有队列保护。** `chatCheckpointer`
> 在宿主侧是可选的(#613),没配时闸门恒为 `open`,`waiting` / `blocked` 都
> 不会出现。要队列真正起作用,必须配 checkpointer。

### 3.4 HITL 对 studio 透明

Studio 不认识 review。**等人只是执行的一种形态**,与"在跑模型"没有区别 ——
两者在闸门上都表现为"门关着"。

review 是 pet 与人之间的事:人已经在跟 pet 打交道了,再让 studio 知道一遍是
多余的一层。

> 类比:企业管理中,如果每个细节都要闭环上报,管理成本会压垮组织。不是所有
> 闭环都需要汇总 —— 需要汇总时 pet 主动报,或者从插件的领域数据里去发现。

### 3.5 卡住由人发现,不由系统判定

**进度停滞在插件的领域视图里是自明的。** 看板上一张任务几小时不动,一眼就能
看见;不需要系统去"检测"再盖一个 FAILED 的章。这与执行拓扑无关:并行是多条
进度线,串行是一条,哪条不动都同样可见。

因此**没有超时机制,也没有自动重试**。失败就留着,由人决定要不要重来 ——
自动重试是在替人做判断,而失败原因往往需要看一眼才知道该不该重试。

### 3.6 闸门变化沿 dispatch 回到发起方

`context.onDispatchGate(handler)` —— 插件订阅**自己派出去的**那些 dispatch 的
闸门变化。别的插件派的、宿主派的,都不会送过来。

**不走 event 总线。** 派活是点对点的,它的进展也是 —— "你派的那条活现在怎么
样"是发起方与 studio 之间的事。把通道自己的机制反馈塞进 event,那个概念会
慢慢变成万能管道,定义随之失效。

宿主派的活没有回路,这是刻意的:**宿主要听,就写一个插件**(见 §5.3),而不
是给宿主开专属通道。

> 设计意图:loop 跑起来一定有人参与。参与若集中在一处反而不好 —— 让用户看见
> 每个 pet 的状态、各自去处理去优化,稳定之后需要人介入的部分会越来越少。
> 但异常情况必须有人参与,所以 `waiting` / `blocked` 不自动放行。

---

## 4. 插件之间:`event`

插件发给 studio 的通知,studio 广播给其他插件。它是**插件之间的共享总线** ——
让互不认识的插件能交换信息。

```ts
type StudioEvent = {
  type: string;          // 插件自行命名，studio 不认识任何具体类型
  source: string;        // 哪个插件发的，由 studio 补齐
  correlationId?: string;
  payload?: unknown;     // 不解释、不校验
  occurredAt: string;
};
```

**studio 不解释 event 内容,也不持有由 event 推导出的状态。**

事件是"发生了什么"(一次性、单向),不是"当前是什么样"(可查询、有生命
周期)。这个区别决定了 studio 不需要存储、不需要一致性、不需要处理并发写。

投递是进程内的同步扇出:每个订阅者被调用一次,一个订阅方抛错不牵连其他方,
也不回溯影响发布方。不跨进程重启,不重试(§7 开放问题 3)。

### 4.1 两个方向互不配对

**这是最容易丢失的一条不变量。**

`dispatch` 和 `event` 是**两条独立的单向通道**,不是一次请求的两半:

- studio **不**记录"这次 dispatch 对应哪个 event";
- studio **不**等待、不超时、不判定某次 dispatch 是否"有回应";
- 一次 dispatch 可能引发零个、一个或很多个 event,也可能永远没有;
- 一个 event 可能与任何一次 dispatch 都无关(定时触发、外部 webhook)。

`correlationId` 是**插件自己的关联凭据**,studio 原样透传、从不解释,也从不
用它做匹配。kanban 往里放 `taskId`,别的插件放什么是它自己的事。

### 4.2 `subscribe` 是插件间的总线,不是对外的出口

契约里只有两个方向,`subscribe` 不是第三个:

```text
plugin ──notify──> studio ──broadcast──> 其他 plugin
                                   ↑
                            插件间共享总线
```

**studio 自己从不 subscribe 任何东西。** 它经 `notify` 接收、向订阅者广播,
仅此而已。`subscribe` 是 `StudioPluginContext` 给**插件**用的。

注意是"能够交换"而非"需要交换":目前每个插件都自足(kanban 听自己的
board,scheduler 看时间,http 插件收自己的请求),还没有哪个插件靠别人的
event 推进自己的状态。总线先于需求存在,不必为它编造用例。

---

## 5. 写一个插件

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

复用 `AgentToolkit` 而不是另立一套接口,是因为 `AgentToolkit` 已经有
`runtime.start` / `runtime.stop`;并排放第二套生命周期只会让两者不同步。

插件按配置顺序 `start`,逆序 `stop` —— 后启动的可能依赖先启动的。`start`
抛错会让 `createStudio` 失败:一个没起来的驱动器意味着这块 studio 不会派活,
静默吞掉会变成"提交了但什么都没发生"。

### 5.1 两副面孔

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
- **存不存、存在哪,是插件的事。** studio 不持久化任何东西,插件的领域状态
  由插件自己落盘。
- **pet 卡住了怎么表达,是插件的事。** studio 不认识 review、不认识"等待",
  要让"在等人"在看板上可见,得由插件订阅 `onDispatchGate` 自己标出来。

### 5.2 scheduler 的形态

它是一个**和 kanban 平级的普通插件**,形态由契约直接决定:

1. **`AgentToolkit` 面** —— 给 pet 一组工具排期,例如
   `schedule_add({ cron, request, petId })` / `schedule_list` / `schedule_cancel`。
   与 kanban 同理,`bindTools` 已带 `execution.threadId`,pet 不需要转抄任何 ID。
2. **`studio.start(context)` 面** —— 起自己的定时器。到点直接
   `context.dispatch({ petId, request })`,派完即忘;不等结果,不判定成败。
3. **自己的存储** —— 排期表是插件私有状态,由插件持有并落盘。studio 不知道
   "排期"这个词。
4. **经 `notify` 汇报** —— 触发、跳过、取消都作为 event 发回 studio,由订阅方
   自行解释。

前置条件只有一个:插件持久化的落盘位置需要与 kanban 统一(§7 开放问题 2)。
其余部分不需要 studio 做任何改动 —— 这正是插板契约要达到的效果。

### 5.3 http 插件的形态

对外的 HTTP 入口**也是一个插件**,不是宿主的特权:

- `studio.start(context)` 里起服务器,收到请求就 `context.dispatch(...)`;
- 派活的 `source` 因此是它的插件名,与 kanban、scheduler 一视同仁;
- 要跟踪自己派出去那些活的进展,订阅 `context.onDispatchGate`。

这解释了为什么宿主不需要专属的回路(§3.6):**宿主要参与,就以插件的身份
参与。** 开端口属于宿主职责,所以它的实现住在宿主侧,但 studio 看到的只是
一个会 dispatch 的插件。

### 5.4 已有与计划中的插件

契约与具体插件无关。以下不构成对 studio 的约束:

| 插件 | 驱动依据 | 状态 |
| --- | --- | --- |
| kanban | 任务依赖 + 进度 | 已落地 |
| scheduler | 时间(cron) | 待实现 |
| trigger | 外部事件(webhook / 文件变化) | 待实现 |
| http | 对外提供 HTTP 入口 | 待实现 |

---

## 6. Studio 的边界

**判断归属的口诀:问题若涉及具体领域(任务、进度、排期、评审、落盘),答案
一定在插件侧;studio 只负责通道的形状。**

| 属于 studio | 不属于 studio |
| --- | --- |
| pet registry、身份与可派发性 | 任务怎么拆(planner 是 pet) |
| `dispatch` 契约 + 每 pet 的队列 | 任务队列、依赖、进度呈现 |
| `event` 总线(入口 + 广播) | 什么时候派谁 |
| 装哪些插件 | run 何时结束 —— 不需要知道 "run" 这个词 |
| | 传输与界面 —— 见 §6.1 |

### 6.1 与宿主只有一个接触点

**dispatch 需要一个能真正跑起来的 pet —— 仅此而已。**

```ts
createStudio({ studioId, pets: PetAgentRuntime[], entryPetId, plugins })
```

`pets` 是接口。谁实现它、跑在哪台机器上、怎么连模型,studio 一概不知。宿主
把实现注进来,方向是**单向**的:studio 从不反过来向宿主要任何东西。

所以 studio 不认识 ws、peer、TUI、requestId、session —— 不是"暂时没用到",
而是**没有任何理由用到**。`@pinpawo/studio` 的 dependencies 里只有
`@pinpawo/pet-agent`,包内搜不到 tui / ws / peer / requestId 任何一个词。
这是这条边界的检验方式。

推论:**凡是需要在 studio 里增加一个概念来配合宿主的想法,都是错的。** 先回
这一节确认接触点是不是真的多了一个 —— 通常没有。

---

## 7. 开放问题

1. **队列不持久化,也没有上限。** 进程重启时排着队没轮到的 dispatch 直接
   消失,而发起方**不会知道** —— 它的 `dispatch()` 早就成功返回了。一个坏掉
   的插件疯狂派活会让队列无限增长,目前没有背压。

   是否要修取决于:**排队中的 dispatch 算不算"已经落地"的承诺?** 若算,它
   得跟着插件状态一起落盘;若只是尽力而为,现在这样就够,但要在契约里说明。
   倾向后者 —— studio 不持久化任何东西(§5.1),队列该守同一条。

2. **插件状态的落盘约定。** `KanbanBoard` 有 `snapshot()` / `restore()`,但
   没有任何调用方 —— 它只活在内存里,进程重启看板归零。scheduler 会面对同一
   个问题。需要一个统一位置(大概是 `<workdir>/.pinpawo/studio/<plugin-id>/`),
   但这属于宿主约定,不进契约。

3. **event 是否需要"至少一次"投递保证。** 目前是纯内存同步扇出,进程重启
   即丢。

   **暂时没有理由需要。** 每个插件都是自足的:kanban 听自己的 board,
   scheduler 看时间,http 插件收自己的请求 —— 没有谁靠别人的 event 推进自己
   的状态。真出现跨插件依赖时再回来看这条;在那之前,给一个没有消费方的通道
   加投递保证是凭空的复杂度。

4. **`start` 里立刻派活会漏事件。** 插件按配置顺序启动,先启动的若在 `start`
   里立刻 dispatch,后启动的还没 subscribe,会漏掉那批 event。顺序需要保留
   (插件之间可能有依赖),但"start 里不要立刻干活"这条纪律目前只是约定,
   没有写进契约。

5. **第三方插件从哪加载。** 目前只有宿主的内置注册表。

---

## 附录:与旧实现的关系

`docs/` 下的 `PET_AGENT_STUDIO_ORCHESTRATOR_DESIGN.md`、
`STUDIO_RUN_CONTROLLER_DESIGN.md`、`STUDIO_DUE_RUN_SCHEDULER_DESIGN.md` 等
文档描述的是一套**拉模型编排器**:studio 派活后等结果、持有 run/task 状态机、
自动重试、超时判定。那套实现已随 #629 整体删除,相关文档仅作历史记录。

两者的核心分歧在于**谁在等**。拉模型下 studio 必须知道 pet 在干什么,由此
派生出 run 生命周期、超时、重试预算、结果聚合;推模型下没有人在等,这些概念
随之全部消失。
