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
| `pinpawo runtime start / status / stop` | 启动、查看或停止共享的本地 Runtime 服务。 | `--directory <path>` |
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

## Runtime 服务

Host 启动时会确保独立的 Runtime 服务已运行。`runtime start` 可以显式启动服务并
输出 JSON 状态；`runtime status` 连接已有服务并输出状态；`runtime stop` 请求停止
服务并输出确认信息。status 和 stop 不会启动尚未运行的服务。

服务目录默认为 `~/.pinpawo/runtime`。`PINPAWO_RUNTIME_DIR` 可覆盖默认值，Runtime
命令的 `--directory` 优先于环境变量。目录中的 `config.json` 声明命名实例与
`toolkitBindings`；默认 `bash`、`git`、`project-inspection` 共用 Shell 实例，
`browser` 使用 CDP 实例。服务目录与实例选择独立于各 Host 的 `--workdir`。

关闭一个 Host 只释放该连接的资源，服务会继续运行。显式停止服务会影响所有已连接
Host。修改配置后需要重启服务并重新建立 Host 连接；旧客户端不会自动重连或重放操作。

浏览器 extension 命令与 backend 选择已移除。请删除 `PINPAWO_BROWSER_BACKEND` 和
已保存的 `browser_backend`，在服务配置中设置 CDP 实例。浏览器连接方式见
[CDP 浏览器指南（英文）](../../../guides/browser-bridge.md)。
