# Studio Plugin Control-plane Boundary

> 状态：Draft target contract
> 更新：2026-08-24

## 决定

Studio Plugin 是 Studio 的控制面扩展，不是 Pet Agent 或 Capability 的扩展点。Plugin 可以
声明自己拥有的 Toolkit definition；这是它与 Agent 装配的唯一连接，Toolkit 的选择仍完全在
Agent 侧。一个 Plugin 的 lifecycle 只可通过以下 Studio contract 行动：

```text
dispatch  ──> 向已配置 Pet 提交 typed work / resume
event     ──> 发布或订阅 Plugin-owned live domain notification
hook      ──> 与已安装的其他 Studio Plugin 装配不透明扩展点
```

Plugin 不读取 Pet runtime、graph、checkpoint、thread state 或 Agent execution metadata；
不定义、注册、选择或注入 Capability；也不把自己的领域状态塞进 Studio。Plugin 可定义
Toolkit，但不决定哪个 Pet 使用它，也不直接把 Toolkit 注入某个 runtime。
`petId` 只是在 `dispatch` 时选择已配置的目标，不赋予 Plugin 对该 Pet 的任何装配或运行时
所有权。

```text
Agent side                                Studio control plane
Capability -> Toolkit -> Pet runtime      Plugin -> dispatch/event/hook -> Studio
             ^  ^                                      |
             |  |                                      v
       Host assembly  Plugin Toolkit definition   configured Pet target
```

## 适用示例

- Kanban Plugin 持久化自己的 task/continuation queue；在 task ready 或 continuation
  input 到达时 dispatch；
  将自己的 committed task mutation 发布为 event；可向 HTTP Plugin 的 `routes` hook 贡献 UI/API。
- HTTP Plugin 只把 dispatch 与 Plugin event 投射到 HTTP/SSE，并暴露 HTTP-owned route hook。
- 任何 UI、scheduler 或 trigger Plugin 也只能沿 dispatch/event/hook 工作。

Kanban 记录 waiting receipt 中的公开 continuation projection，是 Kanban task 状态；它不是
读取或管理 checkpoint。typed `resume` 仍经 dispatch 送给 Pet runtime，由 runtime 自行验证
checkpoint 和其自身的 payload。

## 迁移说明

`StudioPlugin.toolkits` 是一个明确的 Toolkit definition 出口：Host 在构建 resident Pet 前
把所有 Plugin definitions 放入统一 inventory，Capability 再通过 `uses` 选择。它不表示
Plugin 可以参与 Pet Agent 装配；Plugin 不能读写 Capability、inventory result 或 runtime。
