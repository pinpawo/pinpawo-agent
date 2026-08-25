# Studio Standalone Process Entry

> 状态：Draft process contract
> 对应：#638、#643
> 更新：2026-08-26

`@pinpawo/studio` 拥有独立 Host、resident Studio 与 `pinpawo-studio` 进程入口。这里没有
第二个 Studio 可执行 package；入口只是 Studio package 的进程边界。Studio core 不拥有
Agent conversation transport，control plane 也不再内置第二套 WebSocket/stdio protocol。

Studio 仍只声明 `StudioPluginResolver` port，不自行扫描或 import Kanban、HTTP、trigger、
scheduler 等具体 Plugin。

## 1. 依赖边界

```text
packages/studio
  ├─ StudioHost + resident Studio
  ├─ standalone CLI/process lifecycle
  └─ StudioPluginResolver port

packages/studio  ───> local-agent public host-runtime/interaction builders
packages/studio  ─X─> concrete Plugin
concrete Plugin  ───> Studio contracts
```

进程入口可以使用 local-agent 暴露的公共 `host-runtime` surface，但不会进入 Chat server
启动链。具体 Plugin 的安装与发现仍由 Studio 外部装配者负责。

Resident Pet 的目标装配也由该 `host-runtime` surface 完成。local-agent 将 resident runtime
builder 与 interaction builder 分开公开；Studio Host process 为每个配置 Pet 配套构造两者，
但 Studio core 只取得 dispatch port。conversation port 由 local-agent Agent Session adapter
直接服务，不经过 Studio。见
[Resident Pet Host Ports](../agent-runtime/resident-pet-host-ports.md)。

## 2. Plugin resolution boundary

- programmatic caller 可以把 `StudioPluginResolver` 传给 `runStudioHostProcess()`；
- `studio.json.plugins[].options` 由 resolver 对应的 Plugin factory 校验；
- Resolver 返回 Plugin；Plugin 可通过 `toolkits` 声明零个或多个 Agent Toolkit；
- Studio Host 在构建 resident Pet 前，把这些 Toolkit 与其他来源一起送入统一 inventory；
- Plugin lifecycle 只使用 dispatch/event/hook，不参与 Capability 选择或 Pet runtime 装配；
- Resolver 和 Plugin 都不注册 Capability，也不改变 Capability `uses`；
- Studio Host 按 `petId` 严格加载 `pets/<petId>/capabilities/`；目录成员直接决定
  对应 Pet 的 Capability definitions 与选择；
- 当前 CLI 不内置 concrete Plugin catalog。配置引用 Plugin 时，外部装配者必须提供 resolver。

这样既不需要第二个可执行 package，也不会让 Studio 与 Kanban 形成 package 循环。

## 3. Process contract

独立命令仍为 `pinpawo-studio`。目标进程由两个彼此隔离的 adapter 组成：

```text
pinpawo-studio process
├─ Studio HTTP Plugin       -> dispatch / event / Plugin hook
└─ local-agent WS listener  -> Agent Session conversation for resident Pets
```

CLI 不复用 `pinpawo server`，也不把 Studio mode 放回 Chat 启动链。它先构造 immutable
runtime config，再 eager-start 全部 resident Pet 与配套 Agent Session interaction adapter，
最后打开 local-agent WebSocket listener 和 Studio HTTP Plugin。任一 Pet 启动失败使整个
进程启动失败；Pet 启动/关闭顺序不构成 contract。

当前 `--stdio` / `--port` 所选择的内置 Studio invocation transport 是过渡实现，不是目标
contract。迁移时应移除 `--stdio`，并分别为 HTTP Plugin 与 local-agent Agent Session
WebSocket 提供明确的 endpoint 配置；具体 flag/config shape 在实现 PR 中固化。

## 4. 后续阶段

Kanban Plugin 已按独立草案拥有可选 durable state，并直接消费自己的 dispatch
receipt；Studio core 没有增加 Kanban 状态或持久化接口。

HTTP Plugin 已作为独立的零 Toolkit Plugin 提供 direct dispatch 与 live SSE event
投射，并暴露 route hook 供其他 Plugin 反向贡献页面或 API，见
[HTTP Plugin draft](http-plugin.md)。它自身不内置领域页面，并在目标架构中成为 Studio
control plane 的唯一外部 transport。

后续仍需分别设计：

1. local-agent Agent Session WebSocket endpoint 的配置与 TUI 选择 Pet 的连接方式；
2. durable event log 与断线重放；
3. trigger、scheduler 和 Plugin 安装/discovery 策略。

HTTP 展示与 Wiki ingest 已不再作为当前核心架构阶段的默认链路；如重新启用，应分别
以具体 Plugin / Agent Capability 的需求重新评审，不能恢复 Studio core 特例。
