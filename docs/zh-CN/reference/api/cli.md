# CLI 参考

> **状态：当前契约。** 命令注册以 [`services/local-agent/src/cli.ts`](../../../../services/local-agent/src/cli.ts) 为准。

[English](../../../reference/api/cli.md)

`pinpawo` 是 local host 的入口；没有子命令时等价于以 chat mode 运行 `pinpawo server`。

| 命令 | 用途 | 重要参数 |
|---|---|---|
| `pinpawo init` | 创建本地配置与示例 Capability。 | `--dir`、`--force`、`--no-example-capability` |
| `pinpawo setup` | 诊断模型和运行时配置。 | `--workdir` |
| `pinpawo server` / `run` | 启动本地 Chat Host。 | `--workdir`、`--stdio` |
| `pinpawo tui` | 启动终端 UI。 | `--check`、`--qa`、`--workdir` |
| `pinpawo-studio` | 启动独立 Studio Host。 | `--workdir`，并在 `--stdio` / `--port` 中严格二选一 |
| `pinpawo browser extension <action>` | 管理 Chrome Extension driver。 | `--extension-id` |
| `pinpawo capability …` | 列举、校验、安装 Capability。 | `validate <dir>`、`install <dir> --link` |

`run` 是 `server` 的别名，两者只启动 Chat，不再接受 Studio mode。`--stdio` 使用单 peer
JSONL，标准输出仅用于协议。Studio 通过独立的 `pinpawo-studio` 进程启动，不复用 Chat
server 启动链。`pinpawo tui` 消费 local-agent conversation，不连接 Studio 或发送 Studio
dispatch；`--check` 与 `--qa` 不能同时使用。
