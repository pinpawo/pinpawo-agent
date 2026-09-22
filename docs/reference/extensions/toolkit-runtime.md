# Host 的 Toolkit Runtime 装配

当前实现对应 [#848](https://github.com/pinpawo/pinpawo-agent/issues/848)，整体设计仍见
[Runtime 草案](../../design/toolkits/local-execution-runtime.md)。

## Agent 与 Host 的边界

`AgentToolkit` 只定义 Tools、instructions、availability 与 review 等 Agent 契约。
Runtime 类型、客户端、连接身份、实例配置和诊断由 Host 管理，不进入 pet-agent。

本地 Host 的 [HostedToolkit](../../../services/local-agent/src/toolkits/runtimeBinding.ts)
在 `AgentToolkit` 外增加可选 `runtime: string`，声明所需接口。Shell 实例是一套配置好的
shell/CLI 执行环境，不要求常驻 shell 进程。bash、git、project-inspection 可以共享
Shell 实例，也可以选择独立实例；browser 当前只使用 CDP。

```ts
const toolkit = {
  runtime: 'shell',
  ...defineToolkit({ name: 'example', description: 'Example', tools }),
};
```

## 一次装配，正常调用

[HostToolkitCoordinator](../../../services/local-agent/src/toolkits/hostToolkitCoordinator.ts)
先校验 inventory，再连接本机独立 Runtime 服务，通过 `bindToolkitRuntime` 为静态 Tool
绑定对应客户端。缺少客户端或接口不匹配明确失败。传给 Agent 的 Toolkit 不含 runtime
声明；Tool 的 schema、description、operation metadata 和 review policy 保持不变。

绑定只包装原 Tool 的 `invoke`，注入固定的 Toolkit 所属和客户端，然后交给原生 Tool
执行链处理校验、事件、ToolMessage、Command 和 interrupt。不逐调用重建 Tool，不在
pet-agent 中维护第二套执行器。

本地 Tool 读取 Host 私有的 `context.toolkitName` 和 `context.toolkitRuntimes`，再传入
通用 `executionScope` 与取消信号。框架只透传调用上下文，不认识这些客户端字段。
共享客户端不保存可变的“当前执行”。客户端不进入 prompt 或 checkpoint。

实际环境、进程、浏览器连接及页面由服务持有。Host 关闭自己的连接，服务回收该连接
的资源；共享实例和其他 Host 继续存活。诊断由服务的 status 和实例接口提供。
没有 Toolkit root/start/resolve/bindTools/release/stop hooks，也没有逐执行远端绑定。

## 参数准备与审批

`ToolDefinition.prepareInput(input, { toolkitName, toolName, context })` 是通用参数准备接口。
框架不解释 context；具体 Toolkit 决定如何生成完整参数。比如本地 Toolkit 根据 Host
提供的 workdir 解析 cwd 和路径。该函数必须纯且幂等，不创建资源。

参数准备独立于审批，在 full_access 下也运行。准备后的参数写回 Tool call，审批、
authorization matcher 与执行使用同一份参数。服务不回退到自己的 process.cwd。

审批只关注 Tool 及其有效参数。exact / url_origin 保持各自匹配语义，不附加 Toolkit
环境、clientId、instanceId 或 workdir scope。改变环境但参数不变可以复用授权；改变
已解析的路径或 cwd，则按参数匹配规则重新判断。审批恢复 ID 包含 Tool、调用 ID 和
有效参数摘要，避免同一调用 ID 的参数变化误用旧批准。旧版本带环境 scope 的记录
被丢弃，不把它静默转换为不受 scope 限制的授权。

授权匹配、参数准备函数或自动审批策略变化仍影响 registry 的 authorization generation；
连接或 Runtime 类型变化不影响它。工作目录提示由 Host 提供，artifact discovery
指令由该 Toolkit 自己提供，Agent 不内置这些产品约定。

## 验证入口

- [Host 绑定测试](../../../services/local-agent/src/toolkits/runtimeBinding.test.ts)：客户端隔离、原生事件与 Command。
- [真实服务调用](../../../services/local-agent/src/runtimeService/hostClient.test.ts)：静态 Shell/Browser Tool、扩展适配器、独立进程与连接清理。
- [参数与审批测试](../../../packages/pet-agent/src/agent/orchestrator/toolkitExecution.test.ts)：参数准备、授权复用、错误恢复与取消。
- [Orchestrator 测试](../../../packages/pet-agent/src/agent/orchestrator/orchestrator.test.ts)：审批暂停、恢复、拒绝与批次执行。
