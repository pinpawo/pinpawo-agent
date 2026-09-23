# Host 的 Toolkit Runtime 装配

当前实现对应 [#848](https://github.com/pinpawo/pinpawo-agent/issues/848)，整体设计仍见
[Runtime 草案](../../design/toolkits/local-execution-runtime.md)。

## Agent 与 Host 的边界

`AgentToolkit` 只定义 Tools、instructions、availability 与 review 等 Agent 契约。
Runtime kind、客户端、连接身份、实例配置和诊断由 Host 管理，不进入 pet-agent。

本地 Host 的 [ToolkitRuntimeRequirement](../../../services/local-agent/src/toolkits/runtimeBinding.ts)
将 `AgentToolkit` 与可选 `runtimeKind` 组合为装配记录。Shell 实例是一套配置好的
shell/CLI 执行环境，不要求常驻 shell 进程。bash、git、project-inspection 可以共享
Shell 实例，也可以选择独立实例；browser 当前只使用 CDP。

```ts
const requirement = {
  toolkit: defineToolkit({ name: 'example', description: 'Example', tools }),
  runtimeKind: 'shell',
};
```

## 一次装配，正常调用

[HostToolkitCoordinator](../../../services/local-agent/src/toolkits/hostToolkitCoordinator.ts)
先校验 inventory，再连接本机独立的 Toolkit Runtime Service，通过 `bindToolkitRuntime` 为静态 Tool
绑定对应客户端。缺少客户端或接口不匹配明确失败。传给 Agent 的 Toolkit 就是需求记录
中的原始 `AgentToolkit`；Tool 的 schema、description、operation metadata 和 review policy 保持不变。

绑定只包装原 Tool 的 `invoke`，注入固定的 `context.toolkitRuntime` 客户端，然后交给原生 Tool
执行链处理校验、事件、ToolMessage、Command 和 interrupt。不逐调用重建 Tool，不在
pet-agent 中维护第二套执行器。

本地 Tool 读取 Host 私有的 `context.toolkitRuntime`，再传入
通用 `executionScope` 与取消信号。框架只透传调用上下文，不认识这些客户端字段。
共享客户端不保存可变的“当前执行”。客户端不进入 prompt 或 checkpoint。

实际环境、进程、浏览器连接及页面由服务持有。Host 关闭自己的连接，服务回收该连接
的资源；共享实例和其他 Host 继续存活。诊断由服务的 status 和实例接口提供。
没有 Toolkit root/start/resolve/bindTools/release/stop hooks，也没有逐执行远端绑定。
服务断开时，未完成的调用报告结果未知；静态 Tool 的 Host 客户端在下一次调用时以新
clientId 重连，不重放旧调用或接管旧进程/页面 handle。实例初始化失败可在短退避后重试。
服务启动只继承基础 OS 环境变量；需要进入 Shell 实例的额外变量应写入服务配置的 `env`。
若 Host 初始化时服务不可用，依赖它的 Toolkit 在 inventory 中标为 unavailable，纯 Host
Toolkit 仍可使用；修复服务配置后重启 Host 重新装配。

配置中 `instances.<id>.kind` 指定 Runtime kind，`toolkitBindings` 指定 Toolkit 到实例 ID
的映射。插件的 Host 入口为 `toolkitRuntimeRequirements`。IPC 协议从版本 1 开始。

## 参数准备与审批

`ToolDefinition.prepareInput(input, { workdir })` 在审批前生成完整参数。
`workdir` 来自本次执行上下文；本地 Toolkit 用它解析 cwd 和路径。该函数必须纯且幂等，
不创建资源。

参数准备独立于审批，在 full_access 下也运行。准备后的参数写回 Tool call，审批、
authorization matcher 与执行使用同一份参数。服务不回退到自己的 process.cwd。
若准备失败，同批 Tool 均不执行，也不进入审批；模型收到各调用的错误 ToolMessage，
可以修正参数后重新调用。

审批只关注 Tool 及其有效参数。exact / url_origin 保持各自匹配语义，不附加 Toolkit
环境、clientId、instanceId 或 workdir scope。改变环境但参数不变可以复用授权；改变
已解析的路径或 cwd，则按参数匹配规则重新判断。审批恢复 ID 包含 Tool、调用 ID 和
有效参数摘要，避免同一调用 ID 的参数变化误用旧批准。
升级前已停在审批上的调用因恢复 ID 改为有效参数摘要，恢复时会重新请求一次审批。

授权匹配、参数准备函数或自动审批策略变化仍影响 registry 的 authorization generation；
连接或 Runtime kind 变化不影响它。工作目录提示由 Host 提供，artifact discovery
指令由该 Toolkit 自己提供，Agent 不内置这些产品约定。

## 验证入口

- [Host 绑定测试](../../../services/local-agent/src/toolkits/runtimeBinding.test.ts)：客户端隔离、原生事件与 Command。
- [真实服务调用](../../../services/local-agent/src/runtimeService/hostClient.test.ts)：静态 Shell/Browser Tool、扩展适配器、独立进程与连接清理。
- [参数与审批测试](../../../packages/pet-agent/src/agent/orchestrator/toolkitExecution.test.ts)：参数准备、授权复用、错误恢复与取消。
- [Orchestrator 测试](../../../packages/pet-agent/src/agent/orchestrator/orchestrator.test.ts)：审批暂停、恢复、拒绝与批次执行。
