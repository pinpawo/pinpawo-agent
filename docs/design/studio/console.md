# Studio Console

> 状态：Draft implementation contract
> 更新：2026-08-28

Studio Console 是独立的纯前端应用，不是 Studio Plugin，也不由任何 Plugin 打包或托管。
它只消费 HTTP Plugin 及领域 Plugin 贡献的 API：

```text
apps/studio-console
  ├─ Studio     -> /pets /dispatch /events
  ├─ Kanban     -> /kanban /kanban/events
  ├─ Scheduler  -> /scheduler /scheduler/events
  └─ Trigger    -> /triggers /triggers/events

Console -X-> Studio core / Agent / checkpoint / Plugin hook / SQLite
Plugin  -X-> Console assets or frontend module
```

Console 使用固定页面，不实现前端 Plugin 系统。后端没有装配某个领域 Plugin 时，对应页面
显示 unavailable；这不影响其他页面。连接地址和 Studio Bearer token 是运行时输入，不在
构建时绑定某个 Studio 实例。

## 第一版

- Studio：列出存活 Pet、提交单向 dispatch、观察 live Studio event；
- Kanban：读取 task snapshot/history，以连续状态流展示 waiting/doing/todo/blocked/done；
- Scheduler：查看 schedule、创建一次性 schedule、取消尚未触发的 schedule；
- Trigger：查看 trigger 定义和 delivery history、复制外部接收说明；
- Knowledge：暂不实现 graph；以后只通过独立只读 API 列出和读取受限 Markdown。

第一版不实现动态 UI module、Plugin 静态资源 hook、传统泳道/拖拽看板、Agent Session、
HITL resume 或 checkpoint 操作。Console 的 dispatch 成功只表示 Studio 已接受输入，页面
不得等待 Agent completion。

## 数据恢复

领域页面先读取 snapshot/history，再订阅 live `/events`。Studio event 是 live-only；
Kanban、Scheduler 和 Trigger 各自的 SQLite history 才是断线恢复事实源。Console 不用
Studio SSE 重建领域状态。

## 安全

管理 API 使用 HTTP Plugin 的 Studio Bearer 与 Origin/CORS 边界。Console 不把 token
写入 URL；第一版只保存在当前浏览器 session。Trigger 的外部接收凭证属于 Trigger 领域，
不复用 Studio Bearer。
