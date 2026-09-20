# CLI 参考

> **状态：当前契约。** 命令注册以 [`services/local-agent/src/cli.ts`](../../../../services/local-agent/src/cli.ts) 为准。

[English](../../../reference/api/cli.md)

`pinpawo` 是 local host 的入口；没有子命令时等价于以 chat mode 运行 `pinpawo server`。

| 命令 | 用途 | 重要参数 |
|---|---|---|
| `pinpawo init` | 创建本地配置与示例 Capability。 | `--dir`、`--force`、`--no-example-capability` |
| `pinpawo setup` | 诊断模型和运行时配置。 | `--workdir` |
| `pinpawo server` / `run` | 启动本地 Chat Host。 | `--workdir`、`--stdio` |
| `pinpawo tui` | 启动终端 UI。 | `--check`、`--qa`、`--embed-host`、`--workdir`、`--server-port` |
| `pinpawo-studio` | 启动独立 Studio Host。 | `--workdir`、`--pet-port` |
| `pinpawo browser extension <action>` | 管理 Chrome Extension driver。 | `--extension-id` |
| `pinpawo capability …` | 列举、校验、安装 Capability。 | `validate <dir>`、`install <dir> --link` |

`run` 是 `server` 的别名，两者只启动 Chat，不再接受 Studio mode。`--stdio` 使用单 peer
JSONL，标准输出仅用于协议。Studio 通过独立的 `pinpawo-studio` 进程启动，不复用 Chat
server 启动链。`pinpawo tui` 消费 local-agent conversation，不连接 Studio 或发送 Studio
dispatch；`--check` 与 `--qa` 不能同时使用。Studio 没有内建的 WebSocket 或 stdio
dispatch 协议，控制面由已配置的 Plugin 提供。

`pinpawo tui` 默认把 local agent 作为自己的 stdio 子进程启动，无需另外先跑一个
Host。launcher 通过 `PINPAWO_EMBED_HOST_COMMAND` 与 `PINPAWO_EMBED_HOST_ARGS`
传递解析好的 Host 运行时；两者缺失时回退到 `PATH` 上的 `pinpawo`。Host 的 stderr
追加写入 `~/.pinpawo/logs/embedded-host.log`。退出客户端即结束 Host。

`pinpawo tui --server-port <port>` 则改为连接已在该 loopback 端口监听的 Chat
server（走 bearer token 与 origin 校验）；`LOCAL_SERVER_PORT` 为未显式指定端口的
连接模式提供默认值。内嵌 Host 无法挂接到已在运行的 Host，因此 `--embed-host` 与
`--server-port`、`--pet-port`/`--pet-id`、`--check`、`--qa` 互斥；显式传
`--embed-host` 只是重申默认行为。
