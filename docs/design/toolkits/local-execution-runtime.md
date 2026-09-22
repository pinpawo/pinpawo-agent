# 本机独立进程统一托管 Toolkit Runtime

> 状态：Draft。单进程托管、Shell Runtime 表示执行环境、实例共享/隔离和 Browser 只保留 CDP
> 已确认。契约、托管服务和消费方已在工作区实现，正在联合验收；本草案仍待评审，未提升为正式设计。
> 更新：2026-09-22
> Tracking：[issue #848](https://github.com/pinpawo/pinpawo-agent/issues/848)
> 现有契约：[领域关系](../host-agent-capability-toolkit.md)、
> [Toolkit Runtime](../../reference/extensions/toolkit-runtime.md)

## 1. 最终结构

**一个本机独立进程持有所有实际 Runtime。Host 运行 Agent、Toolkit Tools 和审核，
通过一个本机连接调用 Runtime。Toolkit 按能力使用实例，可共享，也可隔离。**

~~~text
Chat / Studio Host
  Agent、Capability、静态 Tools、review
  一个 Runtime client
             │ 本机 IPC
             ▼
Runtime 托管进程
  Shell instance dev  ← bash、git、project-inspection
  Shell instance isolated ← 需要独立环境的 Toolkit
  CDP instance browser ← browser Toolkit
~~~

本期默认提供两种 Runtime：

| 类型 | 能力 | 消费方 |
| --- | --- | --- |
| shell | bash/zsh 命令、argv 程序执行、进程与输出管理 | bash、git、project-inspection |
| cdp | CDP 连接、页面、浏览器操作与事件 | browser |

**Shell Runtime 就是一个配置好、可以运行 shell/CLI 的执行环境。** 实例代表这个
环境及其执行入口：在哪里运行、使用哪个 shell、可访问的工作区、env/PATH 和执行权限。
Toolkit 选择实例，就是选择在哪里执行工具；环境、命令执行和资源管理是它的职责，
不需要再拆成独立的领域对象。

本机执行与 sandbox 内执行是环境的承载方式，不因此新增 Runtime 类型。本期直接在
宿主机器运行 shell/CLI；sandbox 仅说明后续可替换的承载方式，不加入本期实现。
一个环境实例不必对应一个新进程或常驻 shell。是否延续 cd/export 等 shell 内部状态
属于会话行为，不能仅因共用 Runtime 就推断它们会跨调用保留。

bash/zsh 是 Shell 实例的配置。Git 的参数和结果语义归 git Toolkit；执行复用 Shell
Runtime。git/gh 等 argv 调用可直接启动程序，无须拼接 shell 字符串。
browser 明确表示 CDP Toolkit；其他浏览器 backend 删除，未来需要时建立独立 Toolkit。

设计只区分 Toolkit、Runtime 类型和 Runtime 实例。Toolkit 依赖异步能力接口，
实例由配置指定；不要求 Toolkit 与 Runtime 一一对应。没有资源需求的 Toolkit 不分配
Runtime。当前消费方不需要通用的多 Runtime 组合协议，待出现实际需求再增加。

## 2. 实例配置与装载

服务启动时读取配置，首次操作时准备对应执行环境。Host 请求所需接口，服务校验
Toolkit 到实例的固定映射。默认配置文件为 `~/.pinpawo/runtime/config.json`，可用
`PINPAWO_RUNTIME_DIR` 选择独立命名空间。以下为可用的配置结构：

~~~json
{
  "instances": {
    "dev": { "type": "shell", "shell": "bash", "pathBase": "/workspace" },
    "git-isolated": { "type": "shell", "shell": "zsh", "pathBase": "/workspace" },
    "browser": { "type": "cdp", "endpoint": "http://127.0.0.1:9222" }
  },
  "toolkitBindings": {
    "bash": "dev",
    "git": "dev",
    "project-inspection": "dev",
    "browser": "browser"
  }
}
~~~

- 相同 instanceId 共享一个实例；不同 ID 独立，即使配置相同也不合并。将 git 的绑定
  改为 git-isolated 即选择隔离，无需修改 Tool 逻辑。
- 隔离包括环境快照、进程集合和 Runtime 状态，不等于文件系统沙箱。两个实例访问
  同一仓库仍会修改同一批文件；CDP 连接同一浏览器也可能共享登录状态。
- 配置与绑定在连接期间固定。修改服务配置需显式重启服务，Host 重新连接和装配；
  本期不做热更新、配置 revision 或实例在线替换。
- 服务按 type 静态注册执行实现，按 instanceId 持有环境及其操作入口，管理初始化、
  诊断和释放。本机实例直接使用宿主资源，不要求创建独占进程；不为每个 Toolkit 创建 root。
- Shell 与 CDP 各有自己的异步接口，Toolkit 只使用所需方法。接口复用通过代码契约
  和装配检查保证；不建立独立的 port registry、双侧 descriptor 或动态能力协商。
- 扩展复用现有实例时只声明依赖与绑定；引入新 Runtime 时提供受信的服务模块入口及
  对应客户端适配器，由服务配置显式注册。框架不按 Toolkit 名增加执行分支。

现有 [pluginLoader](../../../services/local-agent/src/pluginLoader.ts) 返回含函数的
Toolkit 对象，不能直接传给另一个进程。插件的 `runtimeClients` 导出提供 Host 适配器；
配置中的 `modules` 绝对路径指向受信服务模块，其 `runtimeFactories` 导出提供实际实现。
服务不接收 RPC 上传的 JS、函数或任意模块路径；未注册的接口明确报错。
本期采用随发行配套的客户端与服务入口，一个 IPC 协议版本；独立插件版本协商不在本期。
服务模块是受信的同进程扩展，必须完成初始化、响应取消并让清理操作返回；本期不提供
第三方模块的强制抢占隔离。永久挂起的模块会拖延服务停止，需要单独处置服务进程。

## 3. 调用和生命周期

每个 Host 建立一个连接。服务为连接分配不可复用的 clientId，并记录已校验的
Toolkit → instanceId 映射。绑定只是配置映射，没有单独的 attachment、租约或续租过程。

~~~text
Host 启动：ensure-running → connect（校验协议与绑定）
Tool 调用：审核 → Runtime client → 对应实例操作 → 结果/输出
Host 退出或连接断开：回收该 client 的资源
服务显式停止：关闭全部实例
~~~

### Tool 调用

静态 Tool 从 ToolRuntime.context 取得异步客户端和已有的 execution scope。
context 只注入当前 Capability 已选择的 Toolkit 接口；scope/signal 每次调用读取，
共享 client 不保存可变的“当前执行”。
每次操作携带 Toolkit、实例、thread/run/delegation、有效 workdir 与参数；
clientId 来自服务端连接上下文，不相信调用者自报的身份。
服务核对固定映射、操作接口及资源归属后执行。

只有真实操作创建进程、页面等资源。每次 Agent execution 不再触发远端
start/attach/resolve/release/detach；执行身份随请求传入即可。
AbortSignal 留在 Host，并映射为请求取消消息。

[Toolkit 契约](../../../packages/pet-agent/src/types/toolkit.ts) 的 `runtime` 仅声明接口类型；
[manager](../../../packages/pet-agent/src/agent/orchestrator/toolkitRuntime.ts) 只选择与诊断客户端绑定。
Host 负责客户端注入与关闭。Tools 使用 context 中的接口，旧 root hooks、逐执行 bindTools
重建及仅用于改写 cwd 的假 root 已删除。

### 资源归属

- 服务内资源记录 client、Toolkit 和必要的 execution owner。两个 Host 使用相同
  thread/run/delegation 也互相隔离；共享实例不共享 process handle、Tool inventory
  或审核授权。
- 普通 Tool 调用结束不停止已 yield 的进程；同一 Host 连接内保留原有查询、续读、
  终止及 Browser thread session 语义。
- Host 退出或连接关闭时，先使 client 失效并拒绝新调用，再清理它创建的进程、页面
  和临时资源；尚在异步创建中的资源返回后也必须回收。清理不能停止共享实例或其他
  client 的资源。实例保留到服务停止，不需要引用计数驱动销毁。
- 实例共享要求实现能区分调用方。实例初始化失败只影响使用它的 Toolkit；
  不回滚其他 Host 的实例或资源。
- 服务正常停止时拒绝新请求并关闭所有实例。一个服务崩溃会影响全部客户端；
  存活资源的清理结果必须如实报告，不承诺任务跨重启恢复。

### 托管进程

默认按当前 OS 用户和配置命名空间运行一个服务，Chat、Studio、多项目共用。
Host 使用统一 launcher 的 ensure-running；并发启动通过锁与端点探测保证只有一个
owner。清理失效锁/端点前须确认服务已不存在；版本不兼容报错，不自动杀旧服务。

提供 start/status/stop。Host 断开不停止服务，最后一个 Host 退出后服务仍可驻留。
服务启动配置及 bootstrap env 由 launcher 显式提供，不采用某次 Agent 调用的临时环境。
服务入口、launcher 与 IPC 属于本地装配代码；pet-agent 不包含 shell/CDP 平台实现。
macOS companion 继续暂停，不参与本期实现。

## 4. 本机协议、故障与审核

Unix socket / Windows named pipe 使用同用户访问控制及端点身份校验。
协议只承载连接、请求、响应、取消和有界输出；一个 requestId 用于关联请求和取消。
具体操作与错误由对应 Runtime 接口定义，原生进程对象、JS 回调和 Error 实例不跨进程。

| 情况 | 行为 |
| --- | --- |
| 连接、协议或绑定失败 | 明确不可用，不在 Host 执行 fallback |
| 操作取消 | 请求先登记再启动异步工作；处理取消竞态，确认前不声称已终止 |
| 输出过多 | 有界缓存、游标续读与显式截断，保留同一连接内的进程输出能力 |
| 响应丢失或连接断开 | 未知结果明确报告；清理本 client 资源，不自动重放有副作用的操作 |
| 再次连接或服务重启 | 新 client 身份；旧进程/页面 handle 失效，不能接管旧任务 |

本期不做透明重连、心跳租约、断线续传、去重账本或自动恢复。连接内 yield 与输出续读
属于已有工具能力；连接断开后继续持有任务则属于后续恢复设计。CDP 自身的连接/页面
失效由 CDP 实现处理，不扩展为通用 IPC 恢复框架。

Host 保留准入与 review，服务校验资源访问，不增加第二套审核引擎。
审核缓存绑定消费方 Toolkit、当前连接、实例与有效目标；新连接或实例绑定变化不能
复用旧授权。连接身份与实例配置放在受信上下文，不进入模型 Tool schema。

### workdir 只解析一次

本期使用同机共同文件系统。Host 提供明确的绝对 workdir；Toolkit 在审核前解析有效
cwd/路径，让审核和执行使用同一目标：绝对路径保持原值，相对路径基于 workdir，
省略 cwd 使用 workdir。没有 workdir 时，需要工作区的操作明确失败。
服务只执行已确定的目标，不回退到服务 process.cwd，也不调用全局 process.chdir。

[prepareInput](../../../packages/pet-agent/src/agent/orchestrator/toolkitReviewMiddleware.ts)
在审核或 full_access 执行前调用；[本机路径解析](../../../services/local-agent/src/toolkits/local/workdirBinding.ts)
是纯输入准备函数，覆盖 run_shell、inspect_shell、git/gh 与文件工具。
[上位设计](../host-agent-capability-toolkit.md) 和 [workdir reference](../../reference/runtime/workdir.md)
同步描述这一显式步骤，删除旧 binding 中的隐式执行期改写；相关授权上下文与 #658 协调。

## 5. Shell Runtime

本期实例是一套配置好的本机 shell/CLI 执行环境，托管进程负责使用和管理它。
实例初始化时确定环境配置与程序解析结果；所有主/辅助进程启动显式传入 env。
共享实例中的单次 cwd、locale 或最小 env 选项不能修改基础环境或污染其他调用。

- 环境优先级：服务显式配置 > 服务启动快照 > 平台默认值。未指定 env 使用服务快照；
  空对象表示不继承应用变量，仅使用 PATH 和 Windows SystemRoot 等平台基础值；
  删除与空字符串不同，Windows PATH 大小写统一处理。
- POSIX 默认选择 bash/zsh。实例显式 shell > 服务 defaultShell > 配置的可用候选顺序；
  创建时验证并固定路径。显式不可用时报错，运行中不随客户端 $SHELL 改变。
  Windows 沿用 PowerShell 平台适配器，不另建 Toolkit。
- 选择 shell 不自动开启交互/login 模式，也不创建永久交互终端。保留 bash/zsh 语法、
  inspect_shell 准入、argv、timeout、取消、进程树、yield、退出码和输出限制。
- 后台任务须通过 yield 返回 processId，供 wait/terminate 管理。POSIX 命令退出前清理
  同组无 handle 子进程，不把已退出命令的 PGID 长期保存到 Host 断连时再处理。
  Windows 使用 taskkill 管理仍存活的进程树；没有 OS Job 的情况下，不能保证父进程
  先退出后的孤儿子树清理，也不使用可能已复用的旧 PID 追杀。
- rg：显式路径优先，否则 bundled rg。git/gh/jq：显式路径优先，否则服务配置的 PATH。
  shell/taskkill 等辅助程序使用同一环境解析；显式配置错误不回退。
- 成功解析的程序固定到实例，目标消失时报失效；缺失程序可按相同配置重新检查。
  相对/空 PATH 项使用配置中的明确基准，不使用某次调用 cwd。
- 专用工具与 shell 中普通受管命令名命中同一程序。实例维护私有命令目录并加入 PATH；
  POSIX 链接与 Windows 映射均须验证 argv、Unicode/空格、退出码和取消。
  显式路径、调用中覆盖 PATH、内建命令和函数不属于这个保证。
- 保留 git locale、jq 最小环境及输出限制、rg 的 --no-config/忽略/排序/截断语义。
  可选 gh/jq 缺失只影响对应操作，不使整个 Shell Toolkit 消失。

环境快照不冻结磁盘、Git 配置或凭据文件。纯文件/格式处理可继续在 Host 执行，但使用
同一有效 workdir；外部命令进程及其管理全部归服务。

## 6. CDP Runtime 与 Browser 清理

CDP 指托管进程直接连接 Chrome/Chromium 调试端点，管理连接、target/session、事件和
截图。browser 只有这一条执行路径。底层可使用合适的 CDP 客户端库，库名不构成 backend。

[connection.ts](../../../toolkits/browser/src/connection.ts) 使用 playwright-core 的
`connectOverCDP` 连接实际 CDP 端点；[session.ts](../../../toolkits/browser/src/session.ts)
维护页面操作。旧 extension 和 launchPersistentContext 执行路径已删除。

实例显式选择连接已有浏览器，或启动受管浏览器后通过 CDP 连接。两者只区别资源归属：
已有浏览器只释放自建 target/连接；自己启动的浏览器由服务回收。共享 endpoint 可能
共享默认 context/登录状态，需要隔离时使用独立 context 或浏览器实例。

session 按 client、Toolkit 和 thread 归属，不再只按 threadId。CDP 断连、页面关闭使
受影响操作明确失败；重建连接不得静默重用失效 ref/target 或重放点击。
导航、selector/ref、弹窗、提取、截图、取消、origin/review 继续接受实际操作验证。
截图与 artifact 文件标明归属和有效期，Host 退出不能关闭其他 Host 或用户的浏览器。
连接已有浏览器不支持的 profile/headless 等启动参数明确报错。

| 清理范围 | 处理 |
| --- | --- |
| backend | 删除 auto/extension/独立 playwright 分支、selector 与 fallback |
| extension | 删除 bridge、Native Messaging Host、extension 源码和专属 exports |
| 配置/CLI | 删除 browserBackend、PINPAWO_BROWSER_BACKEND、初始化模板及 extension 管理命令 |
| 构建/发行 | 删除 extension 构建、复制、打包、商店产物与专属 smoke tests；移除未使用依赖 |
| 文档 | guides/reference/README 改为 CDP；旧配置明确报错，不做兼容转换 |

清理覆盖 [package](../../../toolkits/browser/package.json)、
[exports](../../../toolkits/browser/src/index.ts)、
[Host 配置](../../../services/local-agent/src/config/config.ts)、
[CLI](../../../services/local-agent/src/commands/runtimeService.ts) 和
[Host 构建](../../../services/local-agent/package.json)。
仓库清理不自动删除用户 Chrome、profile 或会话数据。保留的 Tool schema/metadata/review
保持稳定。`browser_open_with_profile` 只接受已配置的受管 profile，`headless` 只校验
已配置的启动模式；Tool 不再切换实例启动配置，借用浏览器拒绝这些启动参数。

## 7. 诊断与实施顺序

诊断直接查询服务和实例，显示连接、实例状态、Toolkit 映射和最近失败；
共享实例只记录一份状态。Host 只补充自身连接状态，不维护另一份资源状态。
静态 Tool inventory 不随连接或安装状态改变；诊断不输出凭据、env 值或其他 client 的资源。

| 阶段 | 交付与验证 |
| --- | --- |
| 契约与托管服务 | 简化 Host client/context 接入，实例配置、静态注册、单进程 launcher/IPC/诊断；完成双 Host 隔离、取消、断连清理和真实扩展装载验证 |
| Shell 与消费方 | bash/git/project-inspection 使用同一异步接口；环境/程序选择统一，验证共享与隔离、进程行为、审核与 cwd 一致；删除对应旧生产路径 |
| CDP Browser | 实现 CDP 操作与资源归属，完成上表清理；同步删除其他 backend，验证保留的 Browser 行为 |
| 联合验收 | Chat/Studio 默认组合、跨平台验证、发行与文档收尾；确认所有实际 Runtime 仅在服务运行 |

这些工作面在当前分支一起落地，便于按边界审阅。每个消费方迁移时一并删除旧生产入口，
故障和权限语义随服务基础交付。

### 验收

- [x] 双 Host 共用一个服务 PID；并发启动只有一个 owner。Host 退出不停止
  服务或另一 Host 的资源，显式 stop 才关闭全部实例。
- [x] Shell 实例代表执行环境，不要求每实例一个常驻 shell 或每 Toolkit 一个新进程。
  相同 instanceId 共用实例；不同 ID 独立。共享不扩大工具、资源和审核权限，
  单次 cwd/env 不污染其他调用。
- [x] 静态 Tools 直接调用异步接口；没有假 root、逐执行远端绑定或 bindTools 重建，
  没有 Host 内实际 Runtime/fallback。真实扩展与默认 Toolkit 使用相同装载规则。
- [x] POSIX 取消竞态、进程树、yield、输出游标/上限、断连清理有真实进程验证；结果未知、
  清理未确认如实报告，新连接不能使用旧 handle。
- [x] macOS bash/zsh、程序定位及 argv 行为通过；git/gh/jq/rg 的既有
  操作契约保持，审核与执行目标一致且不使用服务 cwd。
- [x] Browser 只有 CDP，保留的操作与 origin 审核通过；跨 client session 不串用，
  已有浏览器/受管浏览器的释放正确，非 CDP 代码、配置、构建与发行依赖已清理。
- [x] Chat/Studio 装配与全仓测试、完整 build、编译后 CLI 独立进程 smoke 通过。
  发行包包含 runtimeService 入口且不再含 extension 产物。
- [ ] Linux/Windows 的真实 IPC、进程与 Chrome 验证：已加入三平台
  [Runtime CI](../../../.github/workflows/runtime-service.yml)，等待实际运行结果；本机证据为 macOS。

## 8. 现状依据与范围

实现入口与验证依据如下；重构前基线为 da6c791b：

| 当前入口 | 本期调整 |
| --- | --- |
| [Shell 环境](../../../services/local-agent/src/toolkits/local/shellEnvironment.ts)、[客户端](../../../services/local-agent/src/toolkits/local/shellClient.ts)、[Toolkit factories](../../../services/local-agent/src/toolkits/local/index.ts) | 服务持有环境，静态工具通过客户端调用 |
| [search](../../../services/local-agent/src/toolkits/local/searchBackend.ts)、[JSON](../../../services/local-agent/src/toolkits/local/jsonTools.ts)、[Git](../../../services/local-agent/src/toolkits/local/gitTools.ts) | 外部命令统一交给 Shell |
| [BrowserRuntime](../../../toolkits/browser/src/runtime.ts)、[toolkit](../../../toolkits/browser/src/toolkit.ts) | extension 状态和 thread-only session 改为 CDP 与客户端归属 |
| [Host assembly](../../../services/local-agent/src/hostCapabilityAssembly.ts)、[coordinator](../../../services/local-agent/src/toolkits/hostToolkitCoordinator.ts) | 装配一个共享 client 与显式实例映射 |
| [launcher 验证](../../../services/local-agent/src/runtimeService/launcher.test.ts)、[IPC 验证](../../../services/local-agent/src/runtimeService/server.test.ts)、[客户端验证](../../../services/local-agent/src/runtimeService/client.test.ts) | 独立服务、并发连接、归属、取消、断连及畸形响应 |
| [真实 CDP 验证](../../../toolkits/browser/src/cdp.integration.test.ts) | 页面行为、origin 边界、已有/受管浏览器生命周期 |
| [Host 到服务的联合验证](../../../services/local-agent/src/runtimeService/hostClient.test.ts) | 静态 Shell/Browser Tool、插件客户端、独立服务及真实 Chrome |

#645/#659 的 Host 实际 root 归属和 [Runtime reference](../../reference/extensions/toolkit-runtime.md)
随实现修订；#658 协调审核/workdir，#513/#549 保留进程语义，#437 保留搜索，
#562 验证 Windows，#790 协调模块出口。#510 中通用 Browser 行为作为验收依据，
extension 专属设计不要求保留旧 backend。
[Browser 包提取记录](browser-package.md) 保留历史归属依据，不继续作为迁移步骤。

本期不交付远程/容器路径映射、任务跨连接恢复、热配置、动态插件协商、OS 自启动或
新增 profile/login 产品能力。测试可用替身，不增加另一种生产托管模式。
