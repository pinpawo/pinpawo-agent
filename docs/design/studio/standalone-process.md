# Studio Standalone Process Entry

> 状态：Draft process contract
> 对应：#638、#643
> 更新：2026-08-22

`@pinpawo/studio` 同时拥有独立 Host、resident Studio、transport adapter 与
`pinpawo-studio` 进程入口。这里没有第二个 Studio 可执行 package；入口只是
Studio package 的进程边界。该 package 以编译后的 library、types 和 CLI 公开发布。

Studio 仍只声明 `StudioPluginResolver` port，不自行扫描或 import Kanban、HTTP、trigger、
scheduler 等具体 Plugin。

## 1. 依赖边界

```text
packages/studio
  ├─ StudioHost + resident Studio
  ├─ transport adapter
  ├─ standalone CLI/process lifecycle
  └─ StudioPluginResolver port

packages/studio  ─X─> concrete Plugin
concrete Plugin  ───> Studio contracts
```

进程入口可以使用 local-agent 暴露的公共 `host-runtime` surface，但不会进入 Chat server
启动链。具体 Plugin 的安装与发现仍由 Studio 外部装配者负责。

## 2. Plugin resolution boundary

- programmatic caller 可以把 `StudioPluginResolver` 传给 `runStudioHostProcess()`；
- `studio.json.plugins[].options` 由 resolver 对应的 Plugin factory 校验；
- Resolver 返回 Plugin；Plugin 通过 `toolkits` 定义零个或多个 Agent Toolkit；
- Studio Host 在构建 resident Pet 前，把这些 Toolkit 送入 Host 统一 inventory；
- Resolver 和 Plugin 都不注册 Capability，也不改变 Capability `uses`；
- Studio Host 按 `petId` 严格加载 `pets/<petId>/capabilities/`；目录成员直接决定
  对应 Pet 的 Capability definitions 与选择；
- 当前 CLI 不内置 concrete Plugin catalog。配置引用 Plugin 时，外部装配者必须提供 resolver。

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

本阶段不实现具体 HTTP 页面、Plugin discovery、HITL/control 或 durable route index：

1. #638 的 HTTP Plugin 可提供看板展示与 request 提交；
2. wiki ingest、样例配置、Kanban 持久化/invocation 投射继续按 #638 推进；
3. interaction Plugin 消费公开 pending interrupt，并负责重启后的用户侧索引重建；
4. durable event log、断线重放和 Plugin 安装/discovery 策略单独设计。
