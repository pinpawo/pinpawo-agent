# Browser Toolkit 独立包设计

> 2026-08-18：package extraction 与通用 Host/Runtime 装配迁移已完成。
> Host、Agent、Capability、Toolkit 与通用 Runtime diagnostics 以
> [领域关系与装配约束](../host-agent-capability-toolkit.md)为准。

## 状态

提案，用于指导 Browser Toolkit 从 `services/local-agent` 拆分为独立包。本文件描述源码所有权、运行时边界和发行组合；不把这些架构细节写入仓库级 `AGENTS.md`。

## 背景

Browser 已经不是一组无状态工具。它包含 Toolkit 定义、执行期 runtime、浏览器 session 与所有权、浏览器驱动、Chrome Extension、Native Messaging Host，以及安装和状态管理能力。

当前这些实现分散在 `services/local-agent/src/toolkits/browser` 与 `tools/chrome-extension`。这会造成两个问题：

- 代码位置暗示 Browser Runtime 由 local-agent 拥有，和“runtime 是 Toolkit 实现细节”的既有契约冲突；
- Extension、Native Host 与 Browser Runtime 被分别构建，容易产生协议、产物路径和版本不同步。

## 目标

- Browser 的静态 Toolkit 契约、runtime、驱动和宿主组件由一个独立包拥有。
- `services/local-agent` 只负责通用 Toolkit 装载、生命周期协调和默认发行组合。
- Chrome Extension 与 Native Host 作为 Browser Toolkit 的内部 host/transport，和 Browser 协议共同演进。
- Browser 源码全部使用 TypeScript；发布产物中的 JavaScript 由构建生成。
- Browser Toolkit 可以由其他宿主复用，而不依赖 local-agent 的配置存储模块。

## 非目标

- 不把 Browser 特有的 backend、session、profile、origin 或协议概念加入 `@pinpawo/pet-agent`。
- 不新增独立的 CDP core、Extension 或 Native Host 顶层架构包。
- 本阶段不设计通用的第三方 Toolkit 市场或动态安装协议。
- 不为尚无外部用户的旧 Native Host 产物路径保留兼容层；升级后重新注册即可。

## 目标结构

```text
packages/pet-agent/
  # 通用 AgentToolkit 与 ToolkitRuntimeManager 契约

toolkits/browser/                    # @pinpawo-toolkit/browser
  src/
    index.ts
    capability.ts
    toolkit.ts
    runtime.ts
    session.ts
    tools.ts
    drivers/
      managedCdp/
      chromeExtension/
        bridge.ts
        protocol.ts
        session.ts
    hosts/
      chromeExtension/
        extension/                   # MV3 TypeScript 源码与静态资源
        nativeHost/                  # Native Messaging Host TypeScript 源码
        install.ts
  scripts/
    build-extension.ts
    generate-icons.ts
  dist/
    index.js                         # npm 包入口
    hosts/chrome-extension/          # 生成的可分发 host 产物

services/local-agent/
  # 通用宿主、配置适配、Toolkit 装载与默认发行组合
```

`hosts/chromeExtension` 是 Browser Toolkit 内部目录，不是独立的顶层概念。Extension 负责 Chrome 内状态和 CDP 命令，Native Host 负责 Extension 与本机 Browser Runtime 之间的传输；Browser Runtime 仍是 session、执行所有权和恢复语义的唯一所有者。

## 所有权边界

### `@pinpawo/pet-agent`

只提供通用能力：

- `AgentToolkit`、工具和 review 元数据契约；
- `ToolkitRuntimeManager` 的 start、resolve、bind、release、stop 生命周期；
- 通用执行身份 `threadId`、`runId`、`delegationId`、`workdir` 与取消信号。

它不感知 Browser 的 backend、连接状态或安装方式。

### `@pinpawo-toolkit/browser`

拥有 Browser 的完整领域实现：

- `createBrowserToolkit()` 与 `createBrowserCapability()`；
- Browser Runtime、session、execution owner 与结构化错误；
- managed CDP 和 Chrome Extension driver；
- Extension/Native Host 协议、安装、状态投影和构建产物；
- Browser 自身的测试和源码规范。

### `services/local-agent`

作为默认宿主：

- 读取用户配置，并通过显式 options 创建 Browser Toolkit；
- 将 Browser Toolkit 加入 PinPawo 默认发行组合；它与 bash、git 等默认 Toolkit 一样只是一个预设，不是 local-agent 的特权能力；
- 启动通用 `ToolkitRuntimeManager`，不直接管理 Browser session；
- Browser CLI 只调用 Browser 包公开的 extension 安装和状态接口。

“默认内置”是发行策略，不代表源码归 local-agent 所有。

用户扩展遵循同一组合模型：外部插件提供 Toolkit，用户 Capability 在 `CAPABILITY.md` 的 `uses` 中声明所需 Toolkit。local-agent 负责加载并校验这两类配置；它不会把 Browser 或任何默认 Toolkit 当成用户 Capability 的隐式依赖。

`general` 是默认集合中的 host baseline，始终由 local-agent 加载且缺失时启动失败，但不作为可关闭的设置项展示。它只声明稳定的本地 `bash` 和 `git` Toolkit；每次 run 才产生的 profile、artifact 等上下文能力不再成为它的隐式依赖。

`/health` 不追加 Browser 专属 bridge、tab 或 extension 字段。运行时观测来自
`ToolkitRuntimeManager.diagnose()` 的统一 projection；Browser 只通过通用
`details` 提供自己的不透明状态。

## 配置与依赖

Browser 包不能导入 `services/local-agent/src/config` 或 `storage`。宿主在创建时注入配置：

```ts
type BrowserToolkitOptions = {
  backend?: () => string;
  workdir?: () => string;
};

const browserToolkit = createBrowserToolkit({
  backend: () => getConfig().browserBackend,
});
```

Host 是否选择 Browser 由 local-agent 在调用构造函数前决定，不进入
`BrowserToolkitOptions` 或 Toolkit availability。每个 `ToolkitRuntimeManager` 启动并
持有独立的 Browser Runtime root；不同 root 只共享固定 socket 所需的进程级
extension bridge transport，不共享 thread/session/workdir 状态，也不互相拥有
shutdown。Browser Runtime snapshot 只通过 Toolkit 的 `diagnose(root)` 进入通用
diagnostics，不再由 aggregate 或 availability cache 跟踪“当前 root”。

## 宿主接口

当前不引入通用 CLI contribution 框架。Browser 包保留窄的 extension 安装/状态接口；
Capability、Toolkit 与 Runtime lifecycle/diagnostics 则进入通用 Host 装配：

- `createBrowserToolkit(options)`、`createBrowserCapability()`：分别创建静态 definitions；
- `registerBrowserExtensionHost()`、`unregisterBrowserExtensionHost()`、`getBrowserExtensionHostStatus()`：供 CLI 适配。

local-agent 保留 Commander 参数、stdout 格式和 HTTP response 格式。这些是宿主 UI；实现与状态来自 Browser 包。

如果后续第二个外部 Toolkit 也需要贡献 CLI、资源和 health projection，再基于两个真实案例抽取通用 host contribution 契约。

## 构建与发布

- `@pinpawo-toolkit/browser` 独立执行类型检查和单元测试。
- Extension 的 `.ts` 源码编译为 MV3 可加载的 `.js`，静态 manifest、图标和 notices 一并复制到 Browser 包的 `dist/hosts/chrome-extension/extension`。
- Native Host 入口由 Browser 包构建到 `dist/hosts/chrome-extension/native-host.js`。
- `pinpawo` 构建只负责把 Browser 包的 host 产物纳入最终发行，不重新编译或复制仓库外的 Browser 源码。
- Native Host manifest 中的入口路径由 Browser 包的安装 API 解析，不能由 local-agent 硬编码。
- npm 发布顺序为 `@pinpawo/pet-agent`、`@pinpawo-toolkit/browser`、`pinpawo`；最终发行可以 bundle Browser Runtime，但包依赖和 host 产物仍以 Browser Toolkit 为版本所有者。

## 迁移顺序

1. 创建 `toolkits/browser` workspace，将 Browser Toolkit、runtime、drivers、Extension 和 Native Host 源码归拢到该包。
2. 以 options 注入替代 Browser 对 local-agent config/storage 的直接依赖。
3. local-agent 默认 registry 分别组装 Browser Capability 与 Toolkit definitions；CLI 使用包公开的窄 extension 管理接口。
4. Browser 包统一生成 Extension、Native Host 与 npm 入口产物；local-agent 发行构建消费这些产物。
5. 删除 `services/local-agent/src/toolkits/browser` 与顶层 `tools/chrome-extension` 的旧所有权路径。

每一步都应保持 Toolkit 的静态工具名称、review policy、runtime execution ownership 和 extension protocol 行为不变。

## 验收标准

- `services/local-agent` 不再包含 Browser Runtime、driver、Extension 或 Native Host 源码。
- Browser 包不导入 local-agent 内部模块。
- 仓库中的 Browser 与 Extension 源文件均为 TypeScript；生成目录除外。
- Browser Toolkit 可通过注入配置被 local-agent 组装和启动。
- `browser extension register/status/repair` 和 Browser tools 继续工作。
- Browser 包单测、local-agent 单测、根类型检查和发行构建通过。
