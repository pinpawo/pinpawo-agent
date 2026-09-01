# Workdir 配置

[English](../../../reference/runtime/workdir.md)

> **状态：当前 local-host 配置。** 路径解析实现位于
> [`services/local-agent/src/runtimeConfig.ts`](../../../../services/local-agent/src/runtimeConfig.ts)。

本地宿主一次运行使用一个 effective workdir。默认优先级为
`PINPAWO_WORKDIR`、已保存的 `workdir` 配置、当前进程目录；相对路径和 `~/`
会统一解析为绝对路径。

```text
<workdir>/
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

runtime 还能由 workdir 派生 `id`、`name`、`rootPath` 形式的 workspace metadata。
这是本地派生信息，不代表已有持久化 workspace registry 或按请求切换 workspace 的
公共协议。

Host 将有效 workdir 提供给 Agent 模型上下文与 review/authorization context。
它是运行事实，不是 System Policy。Capability 按
[Agent model context assembly](../../../design/agent-runtime/model-context-assembly.md)
通过 invocation-only `<capability_runtime_context>` 提供该信息。

Workdir 不是文件系统 sandbox，也不是隐式 Tool 参数：相对路径、绝对路径或 cwd
由模型决定，执行层不会注入或改写输入。Toolkit Runtime binding 只用于 Toolkit
自己拥有的动态资源与 ownership。

Studio 实际读取的文件见 [Studio 配置](../../studio/configuration.md)；未交付的设计见
[workspace proposal（英文）](../../../design/local-agent/workspace-runtime-config.md)。
