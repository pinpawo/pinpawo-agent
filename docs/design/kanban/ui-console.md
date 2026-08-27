# Kanban Console UI

> 状态：Draft product and adapter contract
> 更新：2026-08-27
> 依赖：[Kanban SQLite Task Store](sqlite-task-store.md)

Kanban Console 是独立 Kanban application 的桌面 Web 操作台。它不是传统人类项目管理
看板，不以泳道、卡片位置或关系图作为主界面；它帮助用户完成一个更直接的循环：

```text
提交 dispatch → 观察 event → 理解 task 状态 → 必要时授权 → 读取 Markdown 上下文
```

Console 可以嵌入 Studio composition，也可以由独立 Kanban application 提供。UI 不拥有
task、event、SQLite、Agent checkpoint 或 Studio runtime 状态。

当前 React Console 位于
[`plugins/kanban/console/`](../../../plugins/kanban/console/)，已经通过 HTTP Plugin route
接入 Pet registry、dispatch、Kanban snapshot/history 和 Studio SSE event。授权与 Markdown
仍是未接入的独立 adapter；后续接入必须保持第 3 节边界。

## 1. MVP 边界

第一版是固定 desktop layout，面向鼠标点击操作：

- 优先展示需要人处理的授权等待；
- 用 task 分组给出当前状态索引；
- 用 event stream 展示真实的推进过程；
- 知识区仅显示 Markdown 文件列表和只读预览；
- 用一个自然语言 dispatch composer 发起新目标。

第一版明确不做：

- 关系图、节点画布或知识图谱可视化；
- 传统多列 Kanban、泳道、拖拽排序；
- 键盘优先交互、快捷键体系、焦点管理或可调整 pane；
- Markdown 搜索、编辑、文件监听、索引构建或目录管理；
- task 直接 SQL 编辑、任意 metadata 编辑或 Web 直写数据库；
- event 查询 DSL、导出、复杂过滤、无限虚拟滚动或原始 JSON inspector；
- 用户积分、个人仪表盘或其他 Studio 产品页面。

## 2. 信息结构

```text
┌──────────────────────────── Header ────────────────────────────┐
│ Kanban Console · 当前实例 · connection state                    │
├───────────────┬────────────────────────────────────────────────┤
│ TASKS         │ AUTHORIZATION                                  │
│               │ 一个置顶等待项 + 批准 / 拒绝 / 详情             │
│ waiting       ├────────────────────────────────────────────────┤
│ doing         │ EVENTS                                         │
│ todo          │ 时间 · source · type · task · 简短说明          │
│ blocked       │ 可点击展开一条简短 detail                        │
│ done          │                                                │
├───────────────┤                                                │
│ KNOWLEDGE     │                                                │
│ .md 文件列表  │                                                │
│ Markdown 预览 │                                                │
├───────────────┴────────────────────────────────────────────────┤
│ DISPATCH  [target] [自然语言目标输入]                    [发送] │
└────────────────────────────────────────────────────────────────┘
```

左侧是状态与上下文；右侧是正在发生的事实；底部是唯一的新工作输入。没有额外侧边导航、
统计卡片或二级工作区。

### 2.1 Authorization

授权区固定在 event stream 上方。它不是普通 task group：

- 最多展示当前最高优先级的一个 action，并显示总数；
- 显示 task、请求操作、简短原因与依赖信息；
- 提供鼠标可点击的“批准”“拒绝”“详情”；
- 只有 Kanban-owned typed attention/authorization record 才能进入授权区；不能把 Studio
  gate 或 Agent Session waiting event 当成授权项；
- 没有 interaction adapter 时可以显示该 record，但操作按钮必须 disabled 并说明当前
  没有授权处理器；
- UI 不能直接恢复 checkpoint。批准/拒绝只调用独立 interaction adapter；adapter 通过
  Pet-scoped Agent Session connection 发送已有 typed control input，不发起 Studio
  dispatch resume。

`waiting` task 仍同时出现在 TASKS 的 attention group；顶部授权区只是最高优先级投射，
不制造第二份 task 状态。

### 2.2 Tasks

TASKS 是紧凑的文本行，不是卡片：

- 固定顺序：`waiting`、`doing`、`todo`、`blocked`、`done`；
- 每行只显示 status dot、task ID、assignee、短标题和 dependency 摘要；
- 点击 task 后筛选右侧 event stream 到该 task，并保留一个“显示全部”动作；
- `blocked` 只显示原因摘要，不提供隐式重试；
- `done` 默认收起，避免历史淹没当前工作。

### 2.3 Events

EVENTS 是页面的主表面，按时间升序或降序显示一条连续流。每行有：

```text
time | source | event type | task ID | human-readable message
```

最小可见事件包括：dispatch 接收、task 创建、task claim、task 状态转移、授权等待、
授权回应、dependency release、Plugin 领域事件和 task 完成/阻塞。

点击某行只展开一段受限 detail，例如 note 或状态转换前后值；第一版不展示原始
payload / JSON。新 live event 追加到流尾；用户正在查看旧记录时不强制滚动。

### 2.4 Knowledge

知识区只是当前 workdir 下明确配置的 Markdown read adapter：

- 一屏展示有限的 `.md` 文件列表；
- 点击文件在同一区域预览经过安全渲染的 Markdown；
- 不用树形 graph 表示文件关系，也不推导“知识图谱”；
- 不编辑文件，不监听文件变化，不索引全文；
- 文件路径必须由 adapter 约束在配置 root 内，UI 不传任意 filesystem path。

第一版不把 task 或 event 与 Markdown 文件做持久关联；知识区是独立的只读上下文，不向
Kanban task schema 或 Studio execution metadata 增加文件引用字段。

### 2.5 Dispatch

底部 composer 是唯一创建新工作的方法：

```text
[target selector] [自然语言目标] [发送]
```

发送调用 application 的 dispatch adapter；成功后立即在 EVENTS 中显示 acceptance，后续
task 如何创建、claim 和完成完全由 Kanban service / runner adapter 决定。UI 不等待执行
完成，也不把浏览器连接当成 cancellation owner。

## 3. 数据与 adapter 边界

```text
Console UI
  ├─ dispatch adapter       -> submit goal
  ├─ Kanban read adapter    -> task snapshot + task history
  ├─ live event adapter     -> committed Kanban events / optional Studio events
  ├─ interaction adapter    -> list and resolve pending actions
  └─ Markdown read adapter  -> list/read configured .md files

Console UI -X-> SQLite
Console UI -X-> Agent runtime / checkpoint
Console UI -X-> Studio internal event queue
```

在 Studio composition 中，HTTP Plugin 可以承载这些 adapter routes 并统一提供 loopback
鉴权；HTTP 本身不解释 Kanban、Markdown 或 interaction 领域。

Kanban read model：

- current snapshot：`tasks` 与 `lastEventSequence`；
- task history：`after=<sequence>` 的 committed Kanban task event；
- Studio live event：由 Studio core event bus 广播，再由 HTTP Plugin 投射为 SSE；不提供
  durable cursor。

首次连接和每次重连都先读取 Kanban snapshot/history，再建立 Studio live event 连接。
断线期间缺失的 Studio event 不重放；UI 依赖 Kanban 自己的 committed history 补齐 task
变化。UI 永远以 Kanban snapshot/history 为 task 事实源，不用 Studio SSE 重建任务状态。

Markdown 和 interaction 都是独立 adapter；缺少其中任一 adapter 时，对应区域显示
unavailable 状态，但不影响 dispatch、task 或 event 主循环。

## 4. 鼠标优先交互

第一版每个关键动作都有明显可点击控件：

| 用户意图 | 控件 | 调用 |
| --- | --- | --- |
| 提交目标 | composer 的发送按钮 | dispatch adapter |
| 查看 task 过程 | task 行 | 本地 event filter |
| 查看全部 event | 显示全部按钮 | 清除本地 filter |
| 查看知识上下文 | Markdown 文件行 / 引用链接 | Markdown read adapter |
| 批准或拒绝 | 授权条按钮 | interaction adapter |
| 查看授权原因 | 详情按钮 | 展开本地 detail |

快捷键可以在后续作为纯增强加入；没有快捷键不得阻止任何 MVP 行为。pane 不可拖拽、不可
缩放，desktop 宽度不足时显示明确的最小宽度提示，而不是在第一版实现复杂 responsive
布局。

## 5. 视觉约束

采用已选定的简化 terminal/TUI 方向：深色平面背景、等宽字体用于 ID/event/type、普通
字体用于自然语言、细分隔线和受限状态色。视觉的目的只是提高运行事实可读性：

- cyan/blue：selection 或 active；
- amber：waiting / requires human attention；
- green：done / accepted successful transition；
- red：blocked / failure；
- 不使用渐变、玻璃拟态、装饰插画或仪表盘图表。

视觉状态不得取代语义文本；颜色以外仍要显示 status/type/原因。

## 6. MVP 验收

- 用户可在一个页面提交 dispatch、看见 acceptance 和后续 task/event。
- waiting action 总在正常 event 之前，且有可点击的授权入口或明确 unavailable 原因。
- task selection 能定位相关 event；断线后能由 snapshot/history 恢复 task flow。
- Markdown 能安全列出和阅读配置 root 内的文件，不直接读取任意本机路径。
- 所有关键行为可用鼠标完成；没有快捷键依赖。
- UI 不直接读写 SQLite，不解释 Agent checkpoint，不向 Studio metadata 加 UI 字段。
- 没有 graph、传统 Kanban board、泳道或 task drag-and-drop。

## 7. 后续而非 MVP

- keyboard navigation / shortcuts；
- event filtering、search、virtualization 和 export；
- responsive/mobile layout；
- Markdown search、tree、watch、editing；
- knowledge relation visualization；
- direct human Kanban commands；
- 多 Studio / 多 Kanban instance 聚合视图。
