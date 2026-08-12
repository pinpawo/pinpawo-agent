# Studio 推模型:orchestrator 缩减与看板驱动

Tracking issue: #561

本文记录一次方向性转变。它推翻了此前若干设计,后续实现以本文为准。

**总原则:一切的目标是简单。** 下面每一条取舍,判据都是"哪个更简单",
而不是"哪个更完备"。

---

## 1. 核心转变:从拉模型到推模型

此前的隐含假设是**拉模型** —— Studio 派活,然后盯着等结果:

```text
orchestrator ──派活──> pet
      ↑                  │
      └──── 等结果 ───────┘        ← orchestrator 必须知道 pet 在干什么
```

这带来一连串问题:pet 等人时算不算"在执行"、谁判定超时、结果怎么送回来。

**推模型**把方向反过来:

```text
orchestrator ──派活──> pet
                        │
                        └──汇报──> 看板
```

Studio 派完就不管了。pet 干完自己往看板上贴进展。

由此:

- Studio **不需要知道** pet 在跑模型、在等工具、还是在等人;
- `invoke()` 何时返回不再是核心问题;
- "谁把结果送回 orchestrator"这个问题**不存在** —— 没有人在等。

---

## 2. HITL 不再是一个需要处理的状态

Studio 不需要知道 review 概念。等人只是**执行的一种形态**,与"在跑模型"
没有区别 —— 两者对 Studio 都只是"这张卡还没动完"。

因此:

- `PetAgentRuntimeInvokeResult` **不应**有 `waiting_review` 分支;
- `StudioInvocation.status` **不应**有 `waiting_review`;
- orchestrator **不应**因为 review 而释放或保留 pet slot。

> #618 当前版本引入了 `waiting_review`。按本文它应当退役 —— 那是把
> review 概念塞进了 Studio,与透明原则相反。

---

## 3. 卡住不需要检测,看板上是自明的

此前担心:推模型下没人在等,pet 崩了怎么办?于是想引入超时判定。

**不需要。** 看板本来就是呈现进度的东西 —— 一张卡长时间不动,这件事在
看板上一眼就能看到,不需要系统去"检测"再盖一个 FAILED 的章。

这与执行拓扑无关:五个 pet 并行是五条进度线,串行是一条,哪条不动都同样
一眼可见。

**推论:自动重试退役。** 失败就留在看板上,由人决定要不要重来 ——
自动重试是在替人做判断,而失败原因往往需要看一眼才知道该不该重试。

> 这意味着此前为"重试预算持久化"所做的 `failedAttemptCount` /
> invocation 计数逻辑一并退役。不是白做:它被更简单的模型取代了。

---

## 4. 看板 runtime 就是驱动器

orchestrator 需要"能给 pet 发 request"这个**能力**,但**不需要**自己决定
什么时候发。

一度设想给 orchestrator 加一个"驱动器插槽",再往里插不同策略(依赖驱动、
cron 驱动、事件驱动)。**这层是多余的** —— 看板 runtime 本身就是驱动器。

看板已经持有:哪些卡在等依赖、哪些卡完成了、什么时候该推下一张。让
orchestrator 再维护一套依赖判定与 ready 扫描,是把看板已有的信息又抄一遍。

```text
orchestrator
  ├── 接收用户目标
  ├── 叫 planner 拆解 → task 上看板
  └── 提供 dispatch(petId, brief)      ← 一个出口

kanban runtime
  ├── 持有任务队列与进度
  ├── 决定什么时候该推谁                ← 驱动
  └── 调 orchestrator 的 dispatch
```

驱动策略(依赖满足即发 / cron / 事件)属于看板 runtime 的实现细节,
**现在不定**;它是 framework 层面的事,不该由本次改动锁死。

### 4.1 `StudioRunQueueStore` 的性质要变

它现在是纯存储(`save` / `get` / `list` / `recoverOpenRuns`),由
orchestrator 拿着读写。作为驱动器,它需要能**主动调 dispatch** ——
从"被动的 store"变成"有生命周期的 runtime",与 browser toolkit 那种
`start()` + 持有状态的形态更接近。

---

## 5. pet 如何汇报:三个候选

pet 主动汇报到看板。实现方式有三种,**尚未定案**:

| | 谁决定汇报 | 评价 |
| --- | --- | --- |
| 1. middleware:studio 模式下让模型输出特殊内容 | 框架强制 | **不倾向** |
| 2. 独立 capability:pet 显式声明"我会汇报" | 模型自主 | 多一层配置 |
| 3. kanban toolkit 自带汇报工具 | 模型自主 | **倾向** |

**倾向 3**:kanban 已经是 pet 的工具(`wiki_read` 就在里面)。"读看板"与
"往看板贴进展"是同一件事的两面,拆成两个概念反而更复杂。

**不倾向 1**:强制每次输出特殊内容,等于框架替模型决定"什么算 done"。
而 task done / goal done 恰恰需要判断 —— pet 可能认为还没做完,硬性截断
会失真。

**2 与 3 的取舍**取决于:是否存在"装了 kanban 但不该汇报"的 pet。若没有,
3 就够了,2 是多余的配置层。

---

## 6. orchestrator 缩减范围

当前 `createStudioOrchestrator.ts` 为 1070 行。

### 随推模型消失

| 职责 | 位置 | 为什么消失 |
| --- | --- | --- |
| `runDispatch` 等结果、判定 satisfied/failed | 108 行 | pet 自己汇报,不需要判定 |
| `dispatchQueuedTask` 的完成回调链 | 123 行 | 同上 |
| `scheduleQueue` 依赖扫描 | 60 行 | 归看板 runtime |
| `activePets` 单槽 | 6 处 | 并发由看板决定 |
| `buildTerminalOutcomeIfReady` 结果聚合 | ~40 行 | 结果在看板上 |
| `waiting_review` 分支 | — | §2 |
| 重试计数 | — | §3 |

### 保留

- 接收用户目标、调 planner、把 task 放上看板
- `dispatch(petId, brief)` —— 核心出口
- run/task 身份(`runId` / `taskId` / `invocationId`)—— 看板需要它们寻址

预期缩减后约 150–250 行。

---

## 7. 本次转变推翻了什么

诚实记录,避免后续从错误前提出发:

| 此前结论 | 现状 |
| --- | --- |
| HITL bridge 应迁到 invocation scope(#229) | ❌ 应删除,不是迁移 |
| `invoke()` 返回 `waiting_review`(#618) | ❌ Studio 不该认识 review |
| 需要"第 4 步:resume 完成后回调 orchestrator" | ❌ 伪需求;推模型下无人在等 |
| 需要超时机制判定卡住 | ❌ 看板上自明 |
| 重试预算需持久化(#606) | ❌ 自动重试整体退役 |
| orchestrator 需要可插拔驱动器插槽 | ❌ 看板 runtime 即驱动器 |

`checkpointer`(#613)**不受影响** —— pet 的执行进度仍需落盘,与谁驱动无关。

---

## 8. review 不产生任何面向 Studio 的汇报

一度担心:pet 被框架打断去做 review 时,它没机会主动调工具汇报,是否需要
框架兜底?

**这个顾虑本身是错的。** review 是 pet 与人之间的事 —— 人已经在跟 pet 打
交道了,再让 Studio 也知道一遍是多余的一层。看板上那张卡就停在原地,
与"pet 正在跑一个很慢的工具"没有区别。

> 类比:企业管理中,如果每个细节都要闭环上报,管理成本会压垮组织。
> 不是所有闭环都需要汇总 —— 需要汇总时 pet 主动报,或者通过看板去发现。

因此 `invoke()` 的语义变了:它不再是"把这个 task 干完",而是
**"给这个 pet 发一个 request"**。发完即返回,Studio 对返回值**不做任何判定**
—— 不判 satisfied / failed,不记重试。

- pet 干完 → 自己往看板贴
- pet 在等人 → 卡停着,无事发生
- pet 崩了 → 同上

---

## 9. `waitForRun` 退役,提交即返回

`waitForRun()` 让 orchestrator 必须知道 run 何时结束 —— 而那是看板的事。

因此该接口去掉,`studio_request` 的语义随之改变:

```text
之前:提交 → 阻塞等待 → 返回最终结果
现在:提交 → 立即返回 accepted → 客户端之后自己看看板
```

这是本次改动中唯一的**对外协议行为变化**,需要在 PR 中显著标注。

---

## 10. 待定项

1. §5 的三个汇报方案定案(倾向 3)。
2. 看板 runtime 的驱动策略与生命周期形态。
