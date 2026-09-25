# Toolkit 的 RS 依赖：ShellRS / BrowserRS

## 状态

当前实现契约（#856，#848 阶段 2；ShellRS 独立服务部署见 #853，阶段 3）。它取代了
#543 的 Toolkit 可选 Runtime 生命周期（`AgentToolkit.runtime` / `ToolkitRuntimeManager`），
后者已删除。

- 通用声明与生命周期类型：[`packages/pet-agent/src/types/toolkit.ts`](../../../packages/pet-agent/src/types/toolkit.ts)
  （`ToolkitRSRequirement`、`ToolkitRS`）与
  [`types/toolExecution.ts`](../../../packages/pet-agent/src/types/toolExecution.ts)
  （`readToolExecutionContext`）。
- ShellRS 契约与 POSIX 实现：
  [`services/local-agent/src/toolkits/local/shellRS.ts`](../../../services/local-agent/src/toolkits/local/shellRS.ts)、
  [`posixShellRS.ts`](../../../services/local-agent/src/toolkits/local/posixShellRS.ts)。
- BrowserRS 契约与 Chrome Extension 实现：
  [`toolkits/browser/src/browserRS.ts`](../../../toolkits/browser/src/browserRS.ts)、
  [`chromeExtensionBrowserRS.ts`](../../../toolkits/browser/src/chromeExtensionBrowserRS.ts)；
  服务端 [`browserRSService.ts`](../../../services/local-agent/src/toolkits/browserRSService.ts)、
  Host 端连接 [`browserRSClient.ts`](../../../services/local-agent/src/toolkits/browserRSClient.ts)。
- Host 端连接的公共部分：[`rsService/contractClient.ts`](../../../services/local-agent/src/rsService/contractClient.ts)。
- ShellRS 独立服务：服务框架
  [`services/local-agent/src/rsService/`](../../../services/local-agent/src/rsService/)、
  服务端 [`shellRSService.ts`](../../../services/local-agent/src/toolkits/local/shellRSService.ts)、
  Host 端连接 [`shellRSClient.ts`](../../../services/local-agent/src/toolkits/local/shellRSClient.ts)、
  入口 [`rsServiceEntry.ts`](../../../services/local-agent/src/rsServiceEntry.ts)、
  管理命令 [`commands/rs.ts`](../../../services/local-agent/src/commands/rs.ts)。
- Host 装配：[`services/local-agent/src/toolkits/hostRS.ts`](../../../services/local-agent/src/toolkits/hostRS.ts)。

## 概念

RS 是持有实际执行环境和交互状态的实例。ShellRS（#853）和 BrowserRS（#862）都只在
本机独立服务中运行，Host 分别经 `ShellRSClient`、`BrowserRSClient` 访问。

RS 只有"实现"一个维度（POSIX，以后的 Windows……），没有"部署"维度：Host 端的
client 是传输，不是另一种 RS。每个 RS 只有一种生产部署方式，所以同一契约的 session
语义只有一种。

```text
Agent session（threadId）──Host 装配──> RS 逻辑 session ──> RS 自己管理的资源
Toolkit 定义所需接口 ──────────────> Host 注入对应 RS 实例
```

Agent session 与 RS 逻辑 session 描述同一段工作，分别位于 Agent 与环境两侧：

- 一个 Agent session 在它使用的每个 RS 实例中各有一个逻辑 session；Agent session
  驱动 RS session，反之不成立。
- 一个 Agent session 在环境中留下的状态，对它之后的工作可见，对其他 Agent session
  不可见，即使二者使用同一个 RS 实例。
- 只在 session 层对齐：task、run、delegation 共享同一个 RS 逻辑 session。
- 生命周期相互独立：Tool 调用、run 结束、Host 断连都不关闭逻辑 session；没有
  `closeSession`。独立服务中的 session 跨 Host 重启存活，随服务停止而结束。
- workdir、Host、连接只是某次调用的执行条件，不属于 session 关系。

## Toolkit 声明

Toolkit 通过类型化工厂接收 RS 实例，并在定义中声明依赖：

```ts
defineToolkit({
  name: 'bash',
  tools: /* 基于注入的 shell 构建的静态 Tool */,
  requires: { shell: { contract: 'pinpawo.shell-rs', version: 1, session: 'agent-session' } },
  availability: () => shell.status(),
});
```

`requires` 只供 Host 装配使用。pet-agent 的 `validateToolkitDefinition` 只检查格式；
registry 编译与执行不读取它，也不按契约、Toolkit 名称或平台分支。没有环境依赖的
Toolkit 不声明 RS。RS 实例不进入审核范围。

Host 用 `assembleToolkit(create, deps)` 调用工厂并核对注入实例的 `contract` /
`version` 与声明一致。同一实例注入多个 Toolkit 即共享环境；注入不同实例即隔离。
Tools 在装配时生成一次，不按 Agent execution 重建。

## RS 生命周期接口

```ts
type ToolkitRS = {
  readonly contract: string;
  readonly version: number;
  status(): ToolkitAvailability | Promise<ToolkitAvailability>;
  ensureSession(agentSessionId: string): void | Promise<void>;
};
```

- `status()` 是依赖该 RS 的 Toolkit 的可用性来源；一个 RS 不可用只影响依赖它的
  Toolkit。
- `ensureSession` 幂等；实现也在该 session 首次调用时惰性建立。
- Host 注入的实例另有 `start()` / `dispose()`，属于 Host 对自身所建对象的管理，不是
  session 操作。对 `ShellRSClient`，`dispose()` 只关闭本 Host 的连接。启动失败记录在
  `status()` 中，不使 Host 初始化失败。

每个 RS 按自己的语义定义类型化接口；Toolkit 面前不存在框架级 `call(method, args)`。
独立服务的传输层按请求/响应转发某个契约的操作，但 Toolkit 只看到类型化接口。纯文件或
格式处理仍在 Toolkit 内完成。

## 执行上下文

Host 为每次 Tool 调用提供固定上下文（`ToolRuntime.context.executionScope`）。
`readToolExecutionContext(config)` 读出 `agentSessionId`（threadId）与 `workdir`。
Toolkit 用原始参数和该上下文在执行时解释目标：local 工具经 `withExecutionWorkdir`
在执行时（审核之后）解析相对路径与默认 cwd。框架没有审核前改写 Tool 输入的阶段；
审核继续依据 Tool 参数与各 Toolkit 既有 review policy。

缺少 Agent session 的调用返回普通 Tool 错误。

## ShellRS

- 契约 `pinpawo.shell-rs@1`；实现 `PosixShellRS`。一个 Agent session 对应一个逻辑
  session，托管该 session 启动的命令、输出和进程句柄；内核进程组只是实现资源。
- `exec(session, { command: { shell } | { argv }, cwd, waitMs, onTimeout, … })`：
  短命令等待完成；超过 `waitMs` 时 `onTimeout: 'yield'` 返回继续运行的句柄，
  `'terminate'` 结束命令。另有 `wait` / `read` / `terminate` / `list`，句柄访问核对
  session。
- 命令经 pipe 作为独立进程运行，不继承上次 `cd` / `export`；这不是持久交互 shell。
  交互 PTY 与显式托管进程在契约中预留，本阶段未实现。
- bash、git、project-inspection 共享 Host 的同一个 ShellRS 实例。git/gh 以 argv
  经 ShellRS 运行。
- 外部命令只经 ShellRS 执行。代码搜索和 JSON 查询没有专用工具（原 `grep_search` /
  `glob_search` / `jq_query` 已删除），由 `inspect_shell` 运行 `rg` / `jq`；
  project-inspection 也提供 `inspect_shell`。
- RS 提供自己的命令目录，放在每条命令 PATH 的最前面：其中的 `rg` 是打包自带的
  ripgrep，默认排除 `.pinpawo`（Agent 自己的 checkpoint 存储）并截断超过 2000 列的
  长行，调用方参数追加在默认参数之后。因此 shell 里的 `rg` 总是可用、版本一致。
- Windows：原 PowerShell 执行器已删除。`PosixShellRS.status()` 在 Windows 上报告
  不可用，shell 相关 Toolkit 随之不可用。未来的 Windows ShellRS 必须兼容同一接口与
  Tool 可观察语义（含 shell 字符串语法与 argv 行为）。

进程句柄按 Agent session 可见：同一 session 的后续 run 与其他 delegation 可以
wait / read / terminate / list；其他 session 访问得到 "belongs to a different
session"。

### 独立服务部署（#853）

```text
Host（Chat / Studio）── ShellRSClient ── 本机 socket + token ──> RS 服务
                                                                 └─ PosixShellRS（按 agentSessionId 的逻辑 session）
```

- 每个 OS 用户一个服务，目录默认 `~/.pinpawo/rs`（`PINPAWO_RS_DIR` 可改），内含
  `rs.sock`、`token`、`service.log`。目录必须是当前用户私有（0700）；token 是唯一的
  权限边界，不信任客户端自报身份。
- Host 装配时 ensure-running：探测端点，不在则以 detached 方式启动 `rsService.js`。
  并发启动由启动锁 + 端点探测收敛到一个 owner；没当上 owner 的候选由启动它的
  launcher 结束。
- 握手核对传输协议版本和契约 `contract` / `version`；不一致时该 RS 不可用并提示
  `pinpawo rs stop` 重启服务，不自动杀旧服务，不热重载。
- 构建标识：服务报告自己入口文件（构建产物 `rsService.js`）的哈希。Host 发现服务
  跑的是别的构建（升级或重新 build 之后）时，若服务空闲（没有 running 进程、没有
  未应答调用）就停掉它并启动当前构建；仍有工作时保留旧服务并警告一次，由用户在
  工作结束后 `pinpawo rs stop`。`pinpawo rs status` 的 `upToDate` 显示是否一致。
  从源码（tsx）运行时只哈希入口文件本身，不跟踪其依赖。
- 环境：服务进程自身只保留最小环境。每次 `exec` 携带调用方 Host 当时的环境作为基础，
  请求的 `env` 叠加其上，所以命令看到的环境与在该 Host 内运行时一致，各 Host 互不
  串环境。`cwd` 由 Host 给出绝对路径，服务不使用自己的工作目录。
- 故障：服务不可达时 shell 相关 Toolkit 不可用、工具返回可恢复错误，Host 照常启动；
  下次调用或状态检查会重连（必要时重新拉起服务）。调用进行中连接断开返回
  `result_unknown`，不重放；已启动的命令仍在其 session 中，可用 `list` 找回。取消
  经传输层按请求取消。
- Host 断开或退出不回收任何 session；服务停止（`pinpawo rs stop` 或信号）时结束
  全部 session 与进程（包括仍在首次等待期、尚未转入后台的命令），并报告清理结果。
  不承诺跨服务重启恢复。
- 管理命令：`pinpawo rs status`、`pinpawo rs processes [--session <id>]`、
  `pinpawo rs terminate <processId>`、`pinpawo rs stop`，全部经 token 连接服务，
  从不启动服务。
- 测试不经 Host 开关绕开服务：Toolkit 级测试把 `PosixShellRS` 作为替身直接注入
  Toolkit 工厂；服务相关测试在临时目录启动服务。Windows 上 `ShellRSClient` 直接报告
  不可用，不尝试启动服务。

## BrowserRS

- 契约 `pinpawo.browser-rs@1`；实现 `ChromeExtensionBrowserRS`。页面级类型化接口
  open/snapshot/click/type/scroll/wait/extract/screenshot/close，每次调用携带
  `{ agentSessionId, workdir, signal }`。
- 一个 Agent session 对应一个逻辑 session：扩展中一个独立的 browser context 及其
  显式绑定的标签。workdir 只决定截图位置；同一 session 更换 workdir 不再报错。
- RS 自己维护 extension bridge、target/ref 与 CDP 状态。bridge 启动失败只使 Browser
  Toolkit 不可用，下一次调用会重试启动。
- 标签分组、跨 origin 审核之外的归属校验等留待后续阶段。

### 独立服务部署（#862）

- BrowserRS 运行在 RS 服务里，和 ShellRS 同一个服务。服务启动时由
  `ChromeExtensionBrowserRS` 持有唯一的 extension bridge，监听
  `~/.pinpawo/run/browser-bridge.sock`；Native Host 和 extension 不变。多个 Host
  共用这一个 extension 连接，不再各自监听或互相抢连接。
- Agent session 到 extension browser context 的映射在服务里，服务存活期间保持稳定：
  Host 重启后用同一个 Agent session 继续操作原来的页面。extension 只看到不透明的
  context id。服务停止时关闭所有 Browser session。
- Host 注入 `BrowserRSClient`：转发 `{ agentSessionId, workdir }` 与参数，`signal`
  映射为传输层取消。审核与 origin 批准仍在 Host 的工具层。
- 错误跨进程保留 `code` / `retryable` / `details`，Browser Tools 给模型的结构化错误
  与进程内一致。服务不可达返回 `runtime_disconnected`（retryable）；调用中途断连返回
  `result_unknown`（不重放，先重新 snapshot）。
- 有打开页面的 session 算"忙"：服务跑的是别的构建时，只要还有这样的 session 就不会
  被自动替换。
- 诊断：`pinpawo rs status` 的 BrowserRS 详情（extension 状态、`commandReady`、
  session 数），`pinpawo browser extension status` 的 `service` 字段。
