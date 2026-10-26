# Workdir 配置

[English](../../../reference/runtime/workdir.md)

> **状态：当前 local-host 配置。** 路径解析实现位于
> [`services/host/src/config/runtimeConfig.ts`](../../../../services/host/src/config/runtimeConfig.ts)。

本地宿主一次运行使用一个 effective workdir。默认优先级为
`PINPAWO_WORKDIR`、已保存的 `workdir` 配置、当前进程目录；相对路径和 `~/`
会统一解析为绝对路径。

```text
<workdir>/
├── PET.md
└── .pinpawo/                     # 项目配置（stateRoot）
    ├── studio.json
    ├── studio/studio.sqlite
    └── pets/

~/.pinpawo/workspaces/<workspace-id>/   # 会话（sessionRoot）
├── workspace.json
├── capability-artifacts/
├── checkpoints-capability-v5/
├── checkpoints-tui-capability-v5/
├── checkpoints-studio-capability-v5/
├── resident-sessions/
└── tui-sessions-capability-v5.json
```

`HostRuntimeConfig` 在装配 runtime 前派生这些路径。Studio 读取 workdir 下的
`studio.json` 与 `pets/`。会话状态（各 Host 的 checkpoint、会话列表和 Capability
artifact）放在用户 home 下，每个 workdir 一个目录，目录名是由路径派生的 workspace id
（`local-` 加路径哈希），`workspace.json` 记录它对应的 workdir。按 workdir 分目录，
是为了让不同项目里同时运行的 Host 不争同一个 checkpoint 写入租约。
`PINPAWO_WORKSPACES_DIR` 可替换 `~/.pinpawo/workspaces` 这个基础目录。会话状态不迁移：
workdir 移动或改名后从空会话开始；旧版本留在 `<workdir>/.pinpawo` 的会话文件会在 Host
启动时提示，可以直接删除。

shared wiki、due-run store、run identity 与 scheduler policy 都不是当前
Studio 契约的一部分。

单 Pet Chat Host 从 `<workdir>/PET.md` 读取该 Pet 的根文档；Studio 则从每个已配置
Pet 的目录定位同一个 `PetDocument` 契约。

runtime 还会由 workdir 派生 `id`、`name`、`rootPath` 形式的 workspace metadata。
这是本地派生信息，不代表已有持久化 workspace registry 或按请求切换 workspace 的
公共协议。

Host 将解析后的目录放入 `AgentInvokeInput.context.workdir`；直接调用 graph 时使用
runnable options 中的 `context.workdir`。共享 system-message 构造器为 Entry、Supervisor、
Capability 执行器和最终 Answer 渲染一次工作目录。review context 与 Toolkit Runtime
execution scope 读取同一个结构化值。Host 的机器和会话信息走公共 system sections，
不再重复目录；旧 `runtimeEnvironment` 和 `configurable.workdir` 通道已移除。

每次调用都需要重新提供 context，包括 checkpoint resume。它不从对话历史恢复，通用
agent runtime 也不会从进程全局状态猜测目录。

workdir 是路径解析基准，不是文件系统 sandbox。files、shell、web、github 和
project-inspection Toolkit 的绑定会将受支持的相对路径，以及相对或省略的 `cwd`，解析到执行目录下；绝对
路径保持绝对路径。绑定不会修改进程 cwd，因此同一进程里的不同 Host 可以保持各自的
执行范围。实现见
[executionContext.ts](../../../../services/host/src/toolkits/executionContext.ts)
中的 `withExecutionWorkdir()`。

Studio 实际读取的文件见 [Studio 配置](../../studio/configuration.md)；未交付的设计见
[workspace proposal（英文）](../../../design/host/workspace-runtime-config.md)。
