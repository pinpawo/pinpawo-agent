# CLI 参考

> **状态：当前契约。** 命令注册以 [`services/local-agent/src/cli.ts`](../../../../services/local-agent/src/cli.ts) 为准。

[English](../../../reference/api/cli.md)

`pinpawo` 是 local host 的入口；没有子命令时等价于以 chat mode 运行 `pinpawo server`。

| 命令 | 用途 | 重要参数 |
|---|---|---|
| `pinpawo init` | 创建本地配置与示例 Capability。 | `--dir`、`--force`、`--no-example-capability` |
| `pinpawo setup` | 诊断模型和运行时配置。 | `--workdir` |
| `pinpawo actor` | 选择本地 Pet identity。 | — |
| `pinpawo server` / `run` | 启动 local host。 | `--mode chat|studio`、`--workdir`、`--stdio` |
| `pinpawo tui` | 启动终端 UI。 | `--check`、`--qa`、`--workdir` |
| `pinpawo browser extension <action>` | 管理 Chrome Extension driver。 | `--extension-id` |
| `pinpawo capability …` | 列举、校验、安装 Capability。 | `validate <dir>`、`install <dir> --link` |

`run` 是 `server` 的别名。`--stdio` 使用单 peer JSONL，标准输出仅用于协议。`pinpawo tui` 启动唯一的终端客户端；`--check` 与 `--qa` 不能同时使用。
