# Capability 目录协议

> 状态：Capability / Toolkit V2
> 更新：2026-07-27

## 1. 目录结构

```text
<capability-dir>/
├── CAPABILITY.md
└── index.js        # 可选
```

`CAPABILITY.md` 同时拥有路由 metadata、required Toolkit 依赖和 Markdown instructions：

```md
---
name: inspect
description: "检查代码库并整理证据。"
uses:
  - bash
  - git
version: 1
icon: magnifyingglass
color: blue
defaultEnabled: true
entry: ./index.js
---

# Inspect

只读取并总结与当前任务相关的内容。
```

## 2. Frontmatter

- `name`：必填；稳定的 Capability route id。
- `description`：必填；planner 用于候选检索和选择。
- `uses`：必填；完整 required Toolkit 列表，可以为空。
- `version`：必填；当前只能为 `1`。
- `icon`、`color`、`defaultEnabled`：可选展示字段。
- `entry`：可选，必须是目录内相对路径。

`description` 应使用 YAML 双引号字符串；内容包含 `:`、`#`、引号或前后空白时，
需要按 YAML 字符串规则正确引用和转义。解析器继续接受早期 v1 loader 读取过的
未引用 description，但新文档不应依赖该兼容语法。

`uses` 的 block list 使用空格缩进，不使用 Tab；Tab 兼容仅用于读取已有 v1 文档。

未知字段、重复 `uses`、越界或 symlink 逃逸的 entry、空或超大 Markdown body 都会被拒绝。

`general` 是 local-agent host 的保留名，用户 Capability 不能注册该名称。

## 3. 可选代码入口

Capability 不需要代码入口。声明 `entry` 时，该模块只能导出：

```js
export const lifecycle = {
  async finalize(result, context) {
    // 只做确定性结果整理或 artifact 持久化。
  },
};
```

不允许从 entry 导出 runtime、tools、模型调用或任意扩展对象。需要编码实现的动作必须进入 Toolkit，再由 `CAPABILITY.md` 的 `uses` 引用。

## 4. 迁移

旧 `manifest.json/index.js` Capability 格式已删除，不提供兼容层。Loader 会跳过旧目录并输出迁移警告。
