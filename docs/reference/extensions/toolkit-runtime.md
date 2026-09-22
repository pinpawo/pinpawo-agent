# Toolkit Runtime 客户端契约

## 状态与范围

当前工作树的实现契约（[#848](https://github.com/pinpawo/pinpawo-agent/issues/848)）。
它替代 #543/#645 中 Host 持有 root、逐执行 resolve/bindTools/release 的接口。
整体部署与联合验收仍由 [Runtime 重构草案](../../design/toolkits/local-execution-runtime.md)
跟踪，该草案保持 Draft。

公共类型见 [toolkit.ts](../../../packages/pet-agent/src/types/toolkit.ts)，
客户端注入见 [ToolkitRuntimeManager](../../../packages/pet-agent/src/agent/orchestrator/toolkitRuntime.ts)。
框架只认识 Toolkit 名、所需能力接口与通用执行身份，不实现 shell、CDP 或平台进程管理。

## 定义与实例

`AgentToolkit.runtime?: string` 声明所需的异步能力接口，例如 `shell`、`cdp` 或扩展接口名。
不需要执行环境的 Toolkit 省略该字段。该字段不接受生命周期 hooks。

Runtime 实例是具体执行环境。Shell 实例是一套配置好的 shell/CLI 执行环境，不要求
一个常驻 shell 进程；多个 Toolkit 可以共享同一实例，也可绑定不同实例。git 与 bash
复用 Shell 能力，不需要 Git Runtime 类型。本期 browser 只使用 CDP。

Host 装配 Toolkit → 实例的映射，并建立一个服务连接。实际环境、进程、浏览器连接
和页面由本机独立服务持有；Host 只持有异步客户端。平台实现与扩展装载不进入 pet-agent。
详见 [领域关系](../../design/host-agent-capability-toolkit.md) 与
[Host 客户端装配](../../../services/local-agent/src/runtimeService/hostClient.ts)。

## Host 注入

```ts
type ToolkitRuntimeClientBinding = {
  runtimeType: string;
  client: unknown;
  identity: { clientId: string; instanceId: string };
  diagnose?: () => JsonValue | Promise<JsonValue>;
};

const manager = new ToolkitRuntimeManager(bindings); // Toolkit name -> binding
manager.replaceBindings(nextBindings);
const { runtimes, identities } = manager.select(selectedToolkits);
```

`select` 同步校验每个已选择 Toolkit 的依赖与客户端类型，只返回这些 Toolkit 的客户端。
缺少客户端或类型不匹配明确失败。它不连接服务、不创建资源、不重建 Tool。
`replaceBindings` 用于 Host 建立或关闭连接时替换客户端映射；它不关闭连接或环境。

[HostToolkitCoordinator](../../../services/local-agent/src/toolkits/hostToolkitCoordinator.ts)
负责连接与断开；Host 关闭时清空映射并关闭自己的连接。服务清理该 client 的资源，
共享实例与其他 Host 的资源不随之关闭。没有 Toolkit root/start/resolve/bindTools/
release/stop hooks，也没有每次 Agent execution 的远端绑定或释放步骤。

## 每次 Tool 调用

Capability 只能使用 `uses` 选中的 Toolkit，执行时注入：

- `ToolRuntime.context.toolkitRuntimes`：按 Toolkit 名索引的异步客户端。
- `ToolRuntime.context.toolkitRuntimeIdentities`：受信的连接与实例身份。
- `ToolRuntime.context.toolkitName`：当前静态 Tool 的 Toolkit 所属，不来自模型参数。
- `ToolRuntime.context.executionScope`：thread、task、run、delegation 与有效 workdir。
- `ToolRuntime.signal`：本次调用的取消信号。

Tool 每次读取这些值并调用自己的客户端。共享客户端不保存可变的“当前执行”。框架
保持静态 Tool 对象、schema、description、operation metadata 与 review policy；客户端
不改变工具列表或执行实现。客户端对象只在调用 context 中，不写入 prompt 或 checkpoint。

[执行边界](../../../packages/pet-agent/src/subagent/toolkitExecution.ts) 位于 createSubagent
的工具 middleware 末尾，外层自定义 middleware 仍包围调用。它把受信的 Toolkit 所属
放入原静态 Tool 的 context，普通失败返回错误 ToolMessage，取消与 graph interrupt
继续传播。资源归属由服务使用连接身份、Toolkit 与 execution scope 校验。

## 审核前输入规范化

需要工作区解析的 Tool 声明纯函数、可重复调用的 `ToolDefinition.prepareInput`：

```ts
prepareInput(input, { toolkitName, toolName, executionScope, runtimeIdentity })
```

它在审核前产生明确的参数对象。比如省略 cwd 使用 workdir，相对路径基于 workdir
解析；缺少所需工作区明确失败。审核、授权 matcher 与执行使用同一份规范化参数，
不能在执行时再偷偷补全 cwd，服务也不回退到自己的 process.cwd。

该步骤在 full_access 模式仍执行；full_access 只跳过审核。它不改变 Tool schema，
也不创建假 Runtime。框架把规范化参数写回本次 tool call，review 暂停后重入仍适用，
所以规范化不能依赖可变会话状态或产生副作用。

授权 matcher 的框架 scope 包含 Toolkit、连接 clientId、instanceId 与 workdir，
exact/url_origin 的原有匹配含义保持。新连接、实例或工作区不能复用旧授权；
待处理 review 的身份也包含该目标。输入规范化与授权策略的变更参与 registry
授权 generation。身份只来自 Host 装配，不进入模型 Tool schema。

## 诊断与验证

`manager.diagnose()` 查询绑定客户端，返回 `toolkitName`、`runtimeType`、`identity`，
以及 JSON-safe `details` 或查询失败的 `error`。Host 不维护 root lifecycle 或 active binding
计数；实际状态由服务和实例产生。诊断不改变静态 inventory、availability 或权限。

[manager 测试](../../../packages/pet-agent/src/agent/orchestrator/toolkitRuntime.test.ts)
覆盖客户端选择、共享/独立身份、缺失依赖和诊断失败；
[真实 subagent 测试](../../../packages/pet-agent/src/agent/orchestrator/toolkitExecution.test.ts)
覆盖审核与执行目标一致、跨 Toolkit 并发所属隔离、授权失效、自定义 middleware 与取消；
[orchestrator 测试](../../../packages/pet-agent/src/agent/orchestrator/orchestrator.test.ts)
继续验证 review 暂停、恢复、拒绝和批次执行。
