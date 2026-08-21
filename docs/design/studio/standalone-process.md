# Studio Standalone Process Entry

> 状态：Draft process contract
> 对应：#638、#643
> 更新：2026-08-22

`@pinpawo/studio` 同时拥有独立 Host、resident Studio、transport adapter 与
`pinpawo-studio` 进程入口。这里没有第二个 Studio 可执行 package；入口只是
Studio package 的进程边界。该 package 以编译后的 library、types 和 CLI 公开发布。

Studio 仍只声明 `StudioModuleResolver` port，不自行扫描或 import Kanban、HTTP、trigger、
scheduler 等具体 module。

## 1. 依赖边界

```text
packages/studio
  ├─ StudioHost + resident Studio
  ├─ transport adapter
  ├─ standalone CLI/process lifecycle
  └─ StudioModuleResolver port

packages/studio  ─X─> concrete optional module
optional module  ───> Studio contracts
```

进程入口可以使用 local-agent 暴露的公共 `host-runtime` surface，但不会进入 Chat server
启动链。具体 module 的安装与发现仍由 Studio 外部装配者负责。

## 2. Module resolution boundary

- programmatic caller 可以把 `StudioModuleResolver` 传给 `runStudioHostProcess()`；
- `studio.json.plugins[].options` 由 resolver 对应的 module factory 校验；
- module 可以同时贡献 Studio plugin/Toolkit face 与配套 Capability；
- resolver 不改变 Capability `uses` 或 Host Toolkit availability；
- 当前 CLI 不内置 concrete module catalog。配置引用 module 时，外部装配者必须提供 resolver。

这样既不需要第二个可执行 package，也不会让 Studio 与 Kanban 形成 package 循环。

## 3. CLI contract

独立命令为 `pinpawo-studio`：

```text
pinpawo-studio --workdir <dir> --stdio
pinpawo-studio --workdir <dir> --port <port>
```

transport 必须显式二选一。CLI 不复用 `pinpawo server`，也不把 Studio mode 放回 Chat
启动链。CLI 先构造 immutable runtime config，再初始化 resident Host，最后打开 transport。
SIGINT/SIGTERM 只关闭本 Host，shutdown 顺序仍由 `StudioHost` 负责。

## 4. 后续阶段

本阶段不实现具体 HTTP 页面、module discovery、HITL/control 或 durable route index：

1. #638 的 HTTP module 可提供看板展示与 request 提交；
2. wiki ingest、样例配置、Kanban 持久化/gate 投射继续按 #638 推进；
3. HITL/control module 读取 checkpoint pending action，并负责重启后的 route/index 重建；
4. durable event log、断线重放和 module 安装/discovery 策略单独设计。
