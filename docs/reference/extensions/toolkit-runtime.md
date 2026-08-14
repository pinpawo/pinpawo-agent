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

## 生命周期

```text
host start
  -> assemble static Toolkit definitions
  -> ToolkitRuntimeManager.start(roots, declared order)
  -> availability -> compile immutable registry

capability subagent start
  -> resolve(root, generic execution scope)
  -> bindTools(binding) [same static names only]
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
instructions、availability 和 Capability 的 `uses` 均是静态契约。`bindTools` 仅为
同名、同数量的 Tool 提供 execution implementation；管理器保留原始 Tool 对象的
schema、description、response format 等公开契约，只把底层 `_call` 分派给 bound
implementation。管理器拒绝更名、增删或非 StructuredTool 的返回值。因此 planner、
checkpoint、registry 与 review 决策永远引用静态契约，不携带 runtime binding。

Browser 的 binding 仅把同一个 `BrowserSession` 封装为带 execution owner 的闭包。
release 会在 Browser 自己的串行队列中撤销 active owner；保留的页面只能由相同
thread/run/delegation scope 在下一次 resolve 时恢复，其他 execution 仍需显式
`browser_open`。通用 manager 不接触这些 ownership/origin/review 细节。

## 宿主责任

- 长驻 local-agent 在 transport 开始接收请求前启动 Toolkit roots，并在进程关闭时
  stop 共享 manager。
- Plugin/本地 Toolkit 先以定义形式加载，root 启动后再做 availability 解析，避免
  runtime-dependent availability 读取到未启动状态。
- 独立 `createPetAgentRuntime()` 持有自己的 manager，调用方结束时调用
  `shutdown()`；host 注入 shared manager 后，只有 host 可以关闭它。
- 若 host 直接传入预构建 orchestrator graph，则该 graph 创建时必须获得同一个
  manager；pet factory 不会在 graph 外额外启动 root。

## 验证

`toolkitRuntime.test.ts` 覆盖 root 单次启动、并发 resolve 的隔离 binding、失败回滚
和静态 Tool inventory 防漂移；Browser tools 测试验证两个 execution facade 不共享
闭包。完整 `npm test` 同时覆盖 local-agent、socket bridge 和 Chrome extension。
