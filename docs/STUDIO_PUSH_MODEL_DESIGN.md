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
身份与可派发性判断会在每个插件里重复一遍,而且多个插件同时派活时没有任何
地方能协调(将来的 capacity / lease 正依赖"所有 dispatch 都看得见")。

```ts
dispatch({ petId, request, correlationId? }) => { threadId }
```

`request` 是自然语言 —— studio 不定义任务结构。

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

### 2.3 `submitRequest` 就是一次 dispatch

```text
submitRequest(goal) ≡ dispatch(plannerPetId, goal)
```

goal 直接派给 planner pet。它**不需要**"路由给哪个插件"这一步 —— 外部入口
与插件委托走同一条通道、同一个契约,只是发起方不同。

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
- `dispatch` 契约(唯一出口)
- `event` 总线(唯一入口 + 广播)
- 插件配置:这个 studio 装哪些插件

**不属于 studio**

- 任务怎么拆(planner 是 pet,不是 studio 的一部分)
- 任务队列、依赖、进度呈现
- 什么时候派谁
- run 何时结束 —— studio 甚至不需要知道 "run" 这个词

---

## 6. 缩减范围

当前 `createStudioOrchestrator.ts` 为 1070 行。

### 随推模型消失

| 职责 | 规模 | 为什么 |
| --- | --- | --- |
| `runDispatch` 等结果、判定 satisfied/failed | 108 行 | pet 自己汇报 |
| `dispatchQueuedTask` 完成回调链 | 123 行 | 同上 |
| `scheduleQueue` 依赖扫描 | 60 行 | 归插件 |
| `activePets` 单槽 | 6 处 | 并发由插件决定 |
| `buildTerminalOutcomeIfReady` 结果聚合 | ~40 行 | 结果不在 studio |
| 重试计数 | — | §4.2 |

### 迁出(归插件)

`StudioRun` / `StudioTask` / `StudioRunQueueStore` / 依赖模型 / 进度状态机。

预期缩减后约 100–150 行。

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
| `submitRequest` 需要路由给某个插件 | ❌ 它就是一次 dispatch |

`checkpointer`(#613)**不受影响** —— pet 执行进度仍需落盘,与谁驱动无关。

---

## 8. 第一批插件

契约与具体插件无关。以下只是**将要实现的第一批**,不构成对 studio 的约束:

| 插件 | 依据 |
| --- | --- |
| kanban | 任务依赖 + 进度 |
| scheduler | 时间(cron) |
| trigger | 外部事件 |

`localStudioDueRunScheduler` 是 scheduler 的雏形,现在长在 local-agent 里。

---

## 9. 待定项

1. 各插件的领域模型与生命周期形态(属于插件自身,不进本契约)。
2. `StudioRun` / `StudioTask` / `StudioRunQueueStore` 迁往哪个插件。
