# Workdir 配置

[English](../../../reference/runtime/workdir.md)

> **状态：当前 local-host 配置。** 路径解析实现位于
> [`services/local-agent/src/runtimeConfig.ts`](../../../../services/local-agent/src/runtimeConfig.ts)。

本地宿主一次运行使用一个 effective workdir。默认优先级为
`PINPAWO_WORKDIR`、已保存的 `workdir` 配置、当前进程目录；相对路径和 `~/`
会统一解析为绝对路径。

```text
<workdir>/
├── PET.md
└── .pinpawo/
    ├── studio.json
    ├── pets/
    ├── capability-artifacts/
    ├── checkpoints-capability-v2.json
    ├── checkpoints-tui-capability-v2.json
    └── tui-sessions-capability-v2.json
```

`LocalAgentRuntimeConfig` 在装配 runtime 前派生这些路径。Studio 读取其中的
`studio.json` 与 `pets/`；Capability artifact、checkpoint 和 session 文件由宿主
分别管理。shared wiki、due-run store、run identity 与 scheduler policy 都不是当前
Studio 契约的一部分。

单 Pet Chat Host 从 `<workdir>/PET.md` 读取该 Pet 的根文档；Studio 则从每个已配置
Pet 的目录定位同一个 `PetDocument` 契约。

runtime 还能由 workdir 派生 `id`、`name`、`rootPath` 形式的 workspace metadata。
这是本地派生信息，不代表已有持久化 workspace registry 或按请求切换 workspace 的
公共协议。

Host 将解析后的目录放入 `AgentInvokeInput.context.workdir`；直接调用 graph 时使用
runnable options 中的 `context.workdir`。共享 system-message 构造器为 Entry、Supervisor、
Capability 执行器和最终 Answer 渲染一次工作目录。review context 与 Toolkit Runtime
execution scope 读取同一个结构化值。Host 的机器和会话信息走公共 system sections，
不再重复目录；旧 `runtimeEnvironment` 和 `configurable.workdir` 通道已移除。

每次调用都需要重新提供 context，包括 checkpoint resume。它不从对话历史恢复，通用
agent runtime 也不会从进程全局状态猜测目录。

workdir 是路径解析基准，不是文件系统 sandbox。本地 bash、project-inspection 和 Git
Toolkit 的绑定会将受支持的相对路径，以及相对或省略的 `cwd`，解析到执行目录下；绝对
路径保持绝对路径。绑定不会修改进程 cwd，因此同一进程里的不同 Host 可以保持各自的
执行范围。实现见
[workdirBinding.ts](../../../../services/local-agent/src/toolkits/local/workdirBinding.ts)。

Studio 实际读取的文件见 [Studio 配置](../../studio/configuration.md)；未交付的设计见
[workspace proposal（英文）](../../../design/local-agent/workspace-runtime-config.md)。
