# Local Process Runtime 设计

对应 issue #513。本文档只覆盖**决策**，不重复 #513 已经写清楚的工具协议。

状态：待确认。确认后再写实现。

## 1. 问题

`run_shell` 只有一种执行模型：同步等待，超时即失败。对于 `pnpm install`、构建、测试这类命令，框架的实际行为是**砍掉输出通道，但不砍掉任务，然后告诉模型"失败了"**。

一条 LangSmith trace 记录了后果：`pnpm install` 120s 超时 → 模型以为失败 → 重试（两个 install 并发写同一个 `node_modules`）→ 连发四条 `ls`/`pgrep` 猜测后台状态 → 最后手写 `while pgrep …; do sleep 2; done` 忙等。

PR #551 已修掉其中一半：超时/abort 现在终止整个进程组，且超时文案说明"已连同子进程一并终止"。剩下的一半是本文档的范围 —— **模型需要一种表达"这是长任务"的手段**，而不是只能在"等到超时"和"猜"之间二选一。

## 2. 已落地的基础

PR #551 引入了 `runShellCommand`（`toolkits/local/processTree.ts`）：

- `spawn` + `detached: true`，命令拥有自己的进程组
- SIGTERM → 宽限期 → SIGKILL，作用于整个组
- `ShellRunOutcome` 区分 `exited` / `timeout` / `aborted` / `spawn_failed`
- 每流独立的 `maxOutputChars` 上界

它刻意只做**有界命令**（总是等待退出）。本设计复用它的进程组处理，不重写。

## 3. 承载方式：Toolkit Runtime（#543 / PR #544）

PR #544 给 `AgentToolkit` 加了可选的 `runtime` 生命周期，其设计意图里明确点名了 bash：

> Browser Runtime 持有桥接连接和浏览器 session；**未来 Bash** 或第三方登录服务也可以持有自己的 host 绑定。

本设计直接搭在它上面，不另起炉灶：

```text
start(ctx)              -> ProcessRegistry           // host 启动，只建一次
resolve(root, ctx)      -> ExecutionBinding          // 每个 subagent execution
bindTools(binding, ctx) -> run_shell / wait_process… // 同名同数量，只换实现
release(binding, ctx)   -> 交还归属，不杀进程         // execution 结束/出错/取消
stop(root, ctx)         -> 终止全部 managed process  // host 关闭
```

`ToolkitRuntimeExecutionScope` 已经提供了需要的身份：`threadId` / `runId` / `delegationId` / `workdir` / `signal`。

这消解了本文档早期版本的两个决策点：

- **registry 作用域**：作为 `runtime.root` 天然是进程级单例，而归属校验由框架提供的 execution scope 保证，不再依赖"记录 sessionId 靠自觉"。**且不需要改 `createBashToolkit()` 签名**，也不牵动模块顶层的 `localToolOperationRegistry`。
- **shutdown 挂载点**：`runtime.ts` 的 `shutdown()` 已经调用 `toolkitRuntimeManager.stop()`，不需要新增全局 hook。

### 决策点 A：release 时是否终止长任务进程

**结论：不终止。**

外部资源的存活周期由 runtime 自己管，框架不该替它操心；工具在下一次调用时有办法知道当前状态即可。

Browser 已经是这个模式的范例（`ownership.ts`）：`release()` 只把 owner 置空并记为 `resumableOwner`，浏览器和页面继续存活。同一 `threadId` 下次 `resolve` 可以续用；其他 thread 必须显式 `browser_open`。

Bash 照搬：

- **进程注册在 root 上**，不挂在 binding 上
- `binding` 只持有「本次 execution 启动的 handle 列表」和归属信息
- `release()` 只解除关联，**不发任何信号**
- 真正的终止只有三个来源：`terminate_process`、进程自身超时、root 的 `stop()`

这样 `pnpm install` 能跨 execution 存活，而 host 关闭时 `stop()` 仍然兜底清理。

推论：`wait_process` 的归属校验按 execution scope 比对，而非按 binding 身份。同 scope 可续用自己的 handle；跨 scope 访问返回明确错误而不是静默失败。

## 4. 工具协议的取舍

#513 已定义 `run_shell` 增加 `yieldTimeMs`、配 `wait_process` / `write_process_stdin` / `resize_process_pty` / `terminate_process`。这里只记有争议的部分。

## 3.5 公开实现调研

调研了三个实现，结论对本设计有直接影响。

| | opencode | Codex | Claude Code |
|---|---|---|---|
| 后台 handle | ❌ 无 | ✅ `process_id` + `ProcessStore` | ✅ `run_in_background` |
| 超时后 | 杀掉，返回失败 | yield 成 handle | **转后台继续跑** |
| 增量输出 | — | ✅ 增量 drain | ❌ 全量重读 |
| 进程存活 | 不跨调用 | 跨 turn，LRU 淘汰（上限 64） | 跨 turn，session 退出时清理 |
| 进程组终止 | ✅ detached + 宽限强杀 | ✅ | ✅ |

**三家一致的**：进程组 detached + 宽限后强杀。PR #551 的方向被三方印证。

**Claude Code 的超时语义最值得借鉴**：超时不是失败，而是转后台。

> "When a command reaches its timeout without finishing, Claude Code moves it to the background instead of stopping it"

这直接命中 trace 的病根 —— 若超时即转 handle，第 2 步的并发重试根本不会发生。因此 yield 不必是一个独立的"提前退出时间窗"，**超时本身就可以是 yield 点**，两者合一。

**Codex 的经验值**（`unified_exec/mod.rs`）：

```rust
MIN_YIELD_TIME_MS: 250
MAX_YIELD_TIME_MS: 30_000
DEFAULT_MAX_BACKGROUND_TERMINAL_TIMEOUT_MS: 300_000
MAX_UNIFIED_EXEC_PROCESSES: 64
UNIFIED_EXEC_OUTPUT_MAX_BYTES: 1 MiB
```

**opencode 的超时文案**值得抄 —— 它指导模型下一步而不只是报告失败：

> `shell tool terminated command after exceeding timeout {N} ms. If this command is expected to take longer and is not waiting for interactive input, retry with a larger timeout value in milliseconds.`

trace 里模型把 timeout 从 120s 调**小**到 60s，正是缺这类提示。

### 决策点 B：yield 语义放在 run_shell 还是新工具

| 方案 | 优点 | 缺点 |
|---|---|---|
| **B1 复用 `run_shell` + `yieldTimeMs`**（#513 原案） | 模型不用学新工具；短命令行为完全不变 | `run_shell` 返回类型变成联合体，所有既有调用点要处理 `status:'running'` |
| **B2 新增 `start_process`** | `run_shell` 完全不动，零回归风险 | 模型要在两个工具间选择，容易误用；`run_shell` 仍会在长任务上超时 |

**倾向 B1**。B2 看似安全，但它没有解决问题 —— 模型仍然会先用 `run_shell` 跑 `pnpm install`，然后仍然撞超时。只有让 `run_shell` 自己具备 yield 能力，trace 里那个场景才会消失。

代价是 `run_shell` 的返回值语义变化。缓解：yield 只在**命令未在 `yieldTimeMs` 内退出**时触发，短命令的返回格式一字不变，因此既有测试和既有行为不受影响。

### 决策点 C：超时即 yield

**结论：超时不再是失败，而是转 handle。** 借鉴 Claude Code。

这消解了"yield 默认开不开、默认值取多少"的问题 —— 不需要额外的 yield 时间窗，现有的 `timeoutSeconds` 就是 yield 点：

```
命令在 timeoutSeconds 内退出  -> 现状不变，返回完整结果
命令未在 timeoutSeconds 内退出 -> 转 handle，返回 { status:'running', processId, 已有输出 }
```

短命令的返回格式一字不变，因此既有测试与既有行为不受影响；长命令不再收到"失败"，而是收到一个可继续操作的句柄。

对照 trace：`pnpm install` 在第 1 步就会拿到 handle，第 2 步的并发重试不会发生，第 3–6 步的 `ls`/`pgrep` 猜测也不再需要。

`timeoutSeconds` 的语义随之从"多久算失败"变为"多久之后转后台"，需要同步改 `run_shell` 的 description。默认 60s 保持不变。

**保留一个例外**：明确不希望转后台的场景（如 `sleep`）。Claude Code 对 `sleep` 就有特殊处理。首个实现可以不做这个例外，观察后再定。

## 5. 生命周期

### 清理挂载点

由 #544 提供：`runtime.ts` 的 `shutdown()` 调用 `toolkitRuntimeManager.stop()`，进而触发 bash toolkit 的 `runtime.stop(root)`。在那里终止全部 managed process 即可，不需要新增全局 hook。

注意 #544 的 manager 在 stop 时会先标记 stopping 再等待在途 resolve，且每个 execution 共享一个 release promise，因此正常路径与 shutdown 不会重复 release。

### 状态机

沿用 #513 的 `ManagedProcessStatus`。补充一条 #513 未明确的：

- **tombstone TTL**：进程退出后保留最终结果，允许最后一次 `wait_process`。建议 TTL 5 分钟或 LRU 上限 32 条，先取固定值，不做配置项。

### Interaction lock

#513 原文要求"同一 process 的 read/write/terminate 必须通过 interaction lock 串行化，避免重复 drain 或退出竞态"。Codex 的实现印证了这条的必要性，并揭示了一个不显然的细节：

```rust
// Do not prune processes while write_stdin or terminal event
// publication holds their interaction lock.
```

即：**正在发布终止事件的已退出进程，不能被当作可回收对象**，否则会在它发布事件的窗口里被误删。Codex 为此专门允许 store 短暂超过软上限。

本设计需要同样的串行化：每个 `ManagedProcess` 持有一把锁，`wait_process` 的 drain、`terminate_process`、以及退出事件发布都必须取到锁才能进行。

### 限额

- 全局最大活跃 **16** 个（Codex 用 64，但它有 sandbox 隔离；我们取更保守的值）
- 每流 buffer 上界复用 `SHELL_MAX_CAPTURE_CHARS`（4M 字符）
- **超限时拒绝启动**并返回明确错误，而不是排队或淘汰

**刻意不抄 Codex 的 LRU 淘汰**：淘汰意味着悄悄杀掉用户的长任务。Claude Code 同样不做并发数淘汰，而是靠资源上限（输出 5GB）、内存压力回收、以及 subagent 60 分钟上限来兜底。拒绝启动会让模型立刻看到"进程太多"，比静默丢失一个正在跑的构建要好。

## 6. 与已有机制的关系

### 与 #550 取消守卫

`wrapToolCancellation` 在 `defineToolkit` 层保证"aborted 不得被当成成功"。本设计不改这一点：

- `run_shell` 在 yield 前被 abort → 仍然抛 `AbortError`，并终止进程组
- 已经 yield 成 handle 的进程 → **不**随单次 tool 调用的 abort 而终止

这与 §3 的 release 决策是同一条原则的两面：进程一旦转为 handle，就脱离了那次 tool 调用的生命周期。

**实现上最容易写错的一处**：`runShellCommand` 目前把 `signal` 直接绑到进程组终止（`processTree.ts` 的 `onAbort`）。yield 模式下必须解绑，否则 handle 刚返回就会被下一次 abort 杀掉。

具体地说，yield 时需要：

1. `removeEventListener('abort', onAbort)` —— 解除与本次调用 signal 的绑定
2. 清掉 `timeoutTimer` 或改挂到 registry 自己的超时预算上
3. 把 pid、进程组、输出 buffer 的所有权移交 registry

`processTree.ts` 现在是"总是等待退出"的形状，需要为此扩展一条 yield 路径 —— 而不是在 `runShellCommand` 之外另写一份 spawn 逻辑。

### 与 operation tracker

现有 `toolOperationTracker.ts` / `runtimeOperationRegistry.ts` 负责把工具执行投射成 UI 可见的 operation。长任务需要它们支持"一个 operation 跨多次 tool 调用"，否则 TUI 上会显示成多个孤立操作。

**待确认**：这部分是否纳入首个实现 PR，还是先让长任务在 UI 上表现为多个独立 operation。

## 7. 建议的实现顺序

1. **runtime 层**：`LocalProcessRuntime` + `ProcessRegistry` + `BoundedOutputBuffer`，复用 `runShellCommand` 的进程组处理；含 shutdown hook 和限额。不动任何工具。
2. **工具协议**：`run_shell` 的 `yieldTimeMs` + `wait_process` + `terminate_process`。这一步让 trace 场景消失。
3. **runtime events**：`process.started` / `output` / `exited` 等，接入 TUI。
4. **stdin / PTY**：#513 自己也建议 v1 不向模型暴露任意 stdin。放最后。

第 1、2 步是"让 trace 里的 pnpm 场景不再发生"的最小集合。

## 8. 明确不做

- 跨 local-agent 重启的进程恢复（#513 已排除）
- 跨 session 接管进程（#513 已排除）
- 数据库/Docker/部署等领域工具（#513 已排除）
- Windows Job Object：当前只在 macOS/Linux 验证，Windows 路径先留 TODO 并在 registry 拒绝启动

## 9. 决策清单

| # | 决策 | 结论 |
|---|---|---|
| A | release 时是否终止长任务进程 | ✅ **不终止**。外部资源存活由 runtime 自己管，照搬 browser 的 `resumableOwner` 模式 |
| B | yield 放 `run_shell` vs 新增工具 | ✅ **复用 `run_shell`**。新增工具解决不了问题：模型仍会先用 `run_shell` 跑长命令 |
| C | yield 时机 | ✅ **超时即 yield**（借鉴 Claude Code）。不需要独立的 yield 时间窗 |
| — | registry 作用域 | ✅ 由 #544 消解：作为 `runtime.root`，归属靠框架提供的 execution scope |
| — | shutdown 挂载点 | ✅ 由 #544 消解：`toolkitRuntimeManager.stop()` 已接好 |
| D | operation tracker 跨调用聚合是否纳入首个 PR | 🔲 倾向不纳入，先接受多个独立 operation |

## 10. 前置依赖

- PR #544（Toolkit runtime lifecycle）—— ✅ 已合并（`d5d7fb3f`）
- PR #551（进程组终止）—— ✅ 已合并（`ab7f8303`）

两者都已就位，可以开工。
