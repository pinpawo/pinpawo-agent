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

Host 在装配本地 Toolkit definitions 时固定有效 workdir。相对路径、命令缺省 cwd、
Agent prompt 与 review/authorization identity 使用同一份 snapshot。workdir 不是文件
系统 sandbox：显式绝对路径或 cwd 仍然是有效的 Tool 输入，执行层不会静默改写它。
另一个 workspace 由另一份 Host-scoped inventory 服务，不依赖进程级可变状态。

Studio 实际读取的文件见 [Studio 配置](../../studio/configuration.md)；未交付的设计见
[workspace proposal（英文）](../../../design/local-agent/workspace-runtime-config.md)。
