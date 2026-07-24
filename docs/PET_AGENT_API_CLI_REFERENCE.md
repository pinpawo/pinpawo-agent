# CLI API 参考

## 1. 命令入口

主命令：`pinpawo`（来自 `services/local-agent/src/cli.ts`）

默认行为：无子命令时等价执行 `pinpawo run`。

## 2. 命令列表

1. `pinpawo init`
   - `--dir <directory>`：目标配置目录，默认 `~/.pinpawo`
   - `--force`：覆盖已有 scaffold
   - `--no-example-capability`：不生成示例能力
2. `pinpawo login`
3. `pinpawo actor`
4. `pinpawo run`
5. `pinpawo tui`
   - `--dry-run`：不落盘
6. `pinpawo detect`
7. `pinpawo capability list`
8. `pinpawo capability validate <directory>`
9. `pinpawo capability install <directory>`
   - `--overwrite`：覆盖同 ID 插件
   - `--link`：安装为软链接

## 3. 输出规范

1. 大多数命令向 stdout 输出人类可读或 JSON（例如能力校验结果）。
2. 错误走 stderr，退出码为非零。
3. 解析脚本建议依赖标准 JSON 字段：
   - `status`
   - `ok`
   - `id`
   - `name`

## 4. 运行方式

1. `npm run tui` 实际启动本地 TUI（开发脚本）
2. 生产分发建议使用 CLI 可执行文件 `dist/index.js`（`bin` 中 `pinpawo`）

## 5. 与 API 的关系

1. CLI 侧对外只暴露用户可调用行为，不暴露 runtime 内部对象。
2. 复杂流程（capability 安装后刷新能力列表）可结合能力清单接口做前端编排。
