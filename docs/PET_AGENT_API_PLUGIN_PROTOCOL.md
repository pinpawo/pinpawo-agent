# Capability 目录协议

## 1. 目录结构

```text
<capability-dir>/
├─ CAPABILITY.md
├─ references/      # 可选，当前不会自动注入
└─ index.js         # 可选，仅用于 lifecycle.finalize
```

纯 Markdown Capability 只需要 `CAPABILITY.md`。

## 2. CAPABILITY.md

```md
---
name: web_research
description: 调查网页资料、核验来源并输出带引用的研究结论。
uses:
  - browser
  - web_search
version: 1
icon: magnifyingglass
color: blue
defaultEnabled: true
---

# Web Research

## 目标
...
```

必填字段：

- `name`：稳定 ID；
- `description`：用于 search / routing 的描述；
- `uses`：required Toolkit 名称列表，可以为空；
- `version`：当前必须为 `1`；
- Markdown 正文：非空，最大 64 KiB。

可选字段：`icon`、`color`、`defaultEnabled`、`entry`。

`builtIn` 由安装来源决定，作者不能声明。Loader 会计算正文 SHA-256
digest，并在一次 registry generation 内保持内容不变。

## 3. 可选 entry

frontmatter 可声明：

```yaml
entry: ./index.js
```

entry 路径必须留在 Capability 目录内，不能通过 `..`、绝对路径或 symlink
逃逸。模块只能导出：

```js
export const lifecycle = {
  async finalize(result, context) {
    // deterministic result ingest / artifact finalization only
  },
};
```

额外导出、`createRuntime`、Capability-owned tools 或通用 middleware 都会被拒绝。

## 4. 加载与安装

- 默认目录：`~/.pinpawo/capabilities/`
- 额外目录：`PINPAWO_CAPABILITY_DIRS` 或本地配置 `capability_dirs`
- 安装：`pinpawo-agent capability install <directory>`
- 验证：`pinpawo-agent capability validate <directory>`
- 同名 Capability 按扫描顺序 first-win，后者会被跳过并记录警告。

旧 `manifest.json + createCapability()` 协议不再加载，也没有兼容层。
