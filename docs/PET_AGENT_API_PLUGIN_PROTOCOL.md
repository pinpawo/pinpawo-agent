# 能力插件协议

## 1. 插件结构

```text
<plugin-dir>/
├─ manifest.json
└─ index.js
```

### `manifest.json` 字段

1. `id: string`（必填）→ 与 `capability.name` 必须一致
2. `name: string`（必填）
3. `description: string`（必填）
4. `icon: string`（必填）
5. `color: string`（必填）
6. `defaultEnabled: boolean`（必填）
7. `builtIn: boolean`（用户插件必须是 `false`）
8. `comingSoon?: boolean`（可选）

## 2. `index.js` 约束

1. 必须导出 `createCapability()` 或 `default()`（返回 `AgentCapability`）。
2. `AgentCapability.name` 与 `manifest.id` 一致。
3. `createRuntime` 必须是函数。
4. 若包含 `availability`，只允许 `cache: 'startup' | 'none'`。

## 3. 加载与安装入口

1. 默认目录：`~/.pinpawo/capabilities/`
2. 额外目录：
   - 环境变量 `PINPAWO_CAPABILITY_DIRS`
   - 本地配置 `capability_dirs`
3. 安装命令：
   - `pinpawo-agent capability install <directory>`
   - `--link` 为软链接安装；否则拷贝（可重命名同名目录）
4. 验证命令：
   - `pinpawo-agent capability validate <directory>`

## 4. 扩展行为

1. 插件缺失文件时直接被跳过或报错（install/validate 行为不同）。
2. 同 ID 插件按扫描顺序 first-win。
3. 重复 ID 在扫描阶段会跳过后者。
