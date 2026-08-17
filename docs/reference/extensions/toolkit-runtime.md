# Toolkit 可选 Runtime 生命周期

## 状态

当前实现契约（#543）。公共类型位于
[`packages/pet-agent/src/types/toolkit.ts`](../../../packages/pet-agent/src/types/toolkit.ts)，
协调器位于
[`packages/pet-agent/src/agent/orchestrator/toolkitRuntime.ts`](../../../packages/pet-agent/src/agent/orchestrator/toolkitRuntime.ts)。

## 目标与边界

Toolkit 可以有可选 runtime：例如 Browser Runtime 持有桥接连接和浏览器 session；
未来 Bash 或第三方登录服务也可以持有自己的 host 绑定。runtime 是 Toolkit 的
实现细节，不是 local-agent 的一级概念，也不是新的 Capability 或 backend router。

框架只认识 Toolkit 名、opaque root/binding 和通用执行身份：`threadId`、`runId`、
`delegationId`、`workdir`、`AbortSignal`。它不认识 browser、session、profile、
backend、cookie 或登录协议。

Toolkit Runtime 属于 Toolkit 领域，不是与 Host、Agent、Capability、Toolkit
平级的第五个概念。完整领域关系见
[领域关系与装配约束](../../design/host-agent-capability-toolkit.md)。

## 生命周期

```text
host start
  -> assemble static Toolkit definitions
  -> ToolkitRuntimeManager.start(roots, declared order)
  -> availability -> compile immutable registry

capability subagent start
  -> resolve(root, generic execution scope)
  -> expose invocation identity and opaque Toolkit Runtime ports through ToolRuntime.context
  -> bindTools(binding) for Toolkit-owned live resources [same static names only]
  -> execute with bound tools
  -> release(binding, reverse order; also on error/cancellation)

host shutdown
  -> host cancels in-flight executions
  -> wait for active executions to release their own bindings
  -> stop roots (reverse start order)
```

Root starts are serialized: concurrent subagents cannot start the same Toolkit
twice. Binding resolution remains concurrent and must be isolated by the Toolkit.
On a partial start or resolve failure, already-created resources are rolled back
in reverse order. Shutdown marks the manager as stopping before it waits for
in-flight resolutions; each execution owns one shared release promise, so its
normal finally path and any repeated release call cannot invoke the hook twice.
Shutdown does not take bindings away from an active subagent. The host owns
cancellation policy; the manager waits for those executions to unwind and run
their normal release path before it stops shared roots.

## 静态与动态边界

`AgentToolkit` 中的 tools、`operation` metadata、review policy、authorization、
instructions、availability 和 Capability 的 `uses` 均是静态契约。没有声明
`bindTools` 的 Toolkit 保持同一批静态 Tool；它的 opaque runtime port 以 Toolkit
name 为 key 放入 `ToolRuntime.context.toolkitRuntimes`，Tool 可以在每次调用时把
invocation identity 传给自己的 Runtime。框架不解释 port 的接口，也不把它放进
registry、planner workspace、prompt 或 checkpoint。

`bindTools` 是另一种互斥的消费方式：只在某个 Toolkit 确实需要替换执行
implementation 时，为同名、同数量的 Tool 注入 Toolkit 自己持有的动态资源或
ownership，例如 process registry；这类 binding 不再额外暴露到 Tool runtime context。
管理器保留原始 Tool 对象的
schema、description、response format 等公开契约，只把底层 `_call` 分派给 bound
implementation。管理器拒绝更名、增删或非 StructuredTool 的返回值。因此 planner、
checkpoint、registry 与 review 决策永远引用静态契约，不携带 runtime binding。

`threadId`、`runId`、`delegationId` 等 invocation identity 由 Agent 放入
`ToolRuntime.context.executionScope`。同一个 context 还携带按 Toolkit name 索引的
opaque Runtime port。workdir 不属于普通 Tool 的模型输入或隐藏参数：Host 将同一份
snapshot 提供给 Agent prompt、Tool runtime context 与 review/authorization，模型
负责生成具体 path 或 cwd。Toolkit Runtime 可以从通用 execution scope 读取 workdir
来管理自身资源，例如 Browser session 和截图目录，但不能据此静默补全、解析或改写
普通 Tool input。是否需要审核属于 review / authorization 层。

Browser Tools 不绑定或持有 `BrowserSession`。它们保持静态 Tool 形状，在每次调用时
从 `toolkitRuntimes.browser` 取得 Browser Runtime port，并显式传入当前 `threadId`、
workdir 和 cancellation signal。Browser Runtime 根据 thread 选择和管理 session；
session ownership、backend、origin 和释放策略都留在 Browser Toolkit 内部。通用
manager 和 Agent 不接触这些概念。

## 宿主责任

- 长驻 local-agent 在 transport 开始接收请求前启动 Toolkit roots，并在进程关闭时
  stop 共享 manager。
- Plugin/本地 Toolkit 先以定义形式加载，root 启动后再做 availability 解析，避免
  runtime-dependent availability 读取到未启动状态。
- 独立 `createPetAgentRuntime()` 持有自己的 manager，调用方结束时调用
  `shutdown()`；host 注入 shared manager 后，只有 host 可以关闭它。
- 若 host 直接传入预构建 orchestrator graph，则该 graph 创建时必须获得同一个
  manager；pet factory 不会在 graph 外额外启动 root。

## 统一诊断（Accepted target，pending #645）

本节是已确认的迁移目标，尚未作为当前 manager 公共 API 实现。
`ToolkitRuntimeManager` 必须为每个声明 Runtime 的 Toolkit 暴露同一份基础诊断：
Toolkit name、lifecycle、active binding 数和最近失败。Toolkit 可以通过通用
`diagnose(root)` hook 提供不透明 `details`；Host 只负责聚合和转发，不按 Toolkit
名称解释这些字段，也不维护 Browser、shell 或 git 专属状态源。

Runtime diagnostics 只描述 live operational state。它不替代 Host config selection，
也不改变 Toolkit availability 或 Capability `uses` 的静态语义。

## 验证

`toolkitRuntime.test.ts` 覆盖 root 单次启动、并发 resolve 的隔离 binding、失败回滚、
Runtime port 暴露和静态 Tool inventory 防漂移；Browser tools 测试验证同一批静态
Tool 会在每次调用时向当前 Runtime 传递 thread identity。完整 `npm test` 同时覆盖
local-agent、socket bridge 和 Chrome extension。
