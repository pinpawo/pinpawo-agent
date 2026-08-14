# 快速开始

> **状态：当前操作指南。** 命令和类型的详细边界由 [Reference](../reference/index.md) 维护。

[English](../../guides/getting-started.md)

本指南会运行本地 PinPawo Agent、验证生成的 Capability 示例，并指向下一条集成路径。

## 前置条件

- Node.js 24 或更高版本
- npm
- 一个 OpenAI-compatible 模型端点和 API key

local host 在你的机器上运行。`PINPAWO_LOCAL_ONLY=1` 会关闭 PinPawo hosted API、relay 和 Hasura 连接，但不会替代运行 Agent 所必需的模型配置。

## 安装与初始化

```bash
npm install -g pinpawo
pinpawo init
pinpawo login
pinpawo setup
```

`pinpawo init` 会创建 `~/.pinpawo/.env`、本地 Capability 目录与 `hello-pinpawo` 示例。`pinpawo login` 配置模型；`pinpawo setup` 用于诊断缺失配置。

## 验证示例

```bash
pinpawo capability validate ~/.pinpawo/capabilities/hello-pinpawo
pinpawo capability list
```

示例是 `CAPABILITY.md`。Capability 描述用户任务与允许使用的 Toolkit，并不是任意代码插件；请先阅读[核心概念](../concepts/core-concepts.md)。

## 运行 Agent

```bash
# 交互式终端
pinpawo tui

# OpenTUI 客户端
pinpawo tui

# 本地 server 或进程集成
pinpawo server
pinpawo server --stdio
```

`--stdio` 使用单个 JSONL peer，标准输出只能写协议消息。完整参数请看[CLI 参考](../reference/api/cli.md)。

## 从仓库开发

```bash
npm install
npm run typecheck
npm test
npm run build
```

## 创建一个 Capability

创建带有 `CAPABILITY.md` 的目录，写明稳定 `name`、`description`、`uses` 和 Markdown 指令，然后验证并链接安装：

```bash
pinpawo capability validate ./repository-audit
pinpawo capability install ./repository-audit --link
```

`--link` 会在开发期间直接加载你的源目录。详细格式参见[扩展契约](../reference/extensions/capability-toolkit.md)。
