# Studio Standalone Application Composition

> 状态：Draft implementation contract
> 对应：#638、#643
> 更新：2026-08-22

`@pinpawo/studio` 已经拥有独立 Host、resident Studio 和 transport adapter，但它不是
最终应用 composition root。它声明 `StudioModuleResolver` port，却不会自行扫描或 import
Kanban、HTTP、trigger、scheduler 等具体 module。

本阶段增加独立的 `services/studio-app` 应用，把“Studio core”和“安装了哪些 module”
之间最后一段装配补齐。

## 1. 依赖边界

```text
services/studio-app               application composition root / CLI
  ├─ @pinpawo/studio              Host + resident Studio + transport
  ├─ pinpawo/host-runtime         shared local-machine capability supply
  └─ optional Studio modules
       └─ @pinpawo-toolkit/studio-kanban

@pinpawo/studio  ─X─> concrete optional module
```

应用可以依赖具体 module；Studio package 不能。module 通过显式 catalog 注册 factory，
由 `studio.json.plugins[].id` 选择。catalog 不做静默自动启用，也不允许未知 id 或重复 id。

## 2. Catalog contract

- registration 拥有稳定 `id` 和 factory；重复 id 在应用启动前失败；
- factory 每次解析都创建新的 module 实例，不能跨 Host 共享可变 board/runtime；
- `plugins[].options` 由对应 factory 校验，Studio core 只负责原样透传；
- 未安装的 id 必须报告已安装列表并 fail fast；
- module 可以同时贡献 Studio plugin/Toolkit face 与配套 Capability；
- catalog 只决定 definition 来源，不改变 Capability `uses` 或 Toolkit availability。

当前 installed catalog 只包含 `kanban`。后续 HTTP、trigger、scheduler 以相同方式注册，
不需要修改 `@pinpawo/studio`。

## 3. CLI contract

独立命令为 `pinpawo-studio`：

```text
pinpawo-studio --workdir <dir> --stdio
pinpawo-studio --workdir <dir> --port <port>
```

transport 必须显式二选一。CLI 不复用 `pinpawo server`，也不把 Studio mode 放回 Chat
启动链。CLI 先构造 immutable runtime config 与 module resolver，再初始化 resident Host，
最后打开 transport。SIGINT/SIGTERM 只关闭本 Host，shutdown 顺序仍由 `StudioHost` 负责。

## 4. 后续阶段

本阶段不实现具体 HTTP 页面、HITL/control 或 durable route index。完成 composition root 后：

1. #638 的 HTTP module 可提供看板展示与 request 提交；
2. wiki ingest、样例配置、Kanban 持久化/gate 投射继续按 #638 推进；
3. HITL/control module 读取 checkpoint pending action，并负责重启后的 route/index 重建；
4. durable event log、断线重放和第三方 module 安装策略单独设计。
