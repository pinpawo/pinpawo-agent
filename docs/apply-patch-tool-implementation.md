# Apply Patch Tool Implementation

> 状态：Implemented
> 日期：2026-08-09
> 范围：`services/local-agent` 的本地 `apply_patch` 工具

## 1. 目标

`apply_patch` 是面向模型的 V4A 文本编辑工具，只负责修改一个已存在的文件。它不负责新建、删除或移动文件，也不在一次调用中更新多个文件。

工具只实现一套协议，避免模型选择格式，也避免运行时同时维护 V4A 与 Unified Diff 的不同边界和应用语义。新建或完全重写使用 `write_file`，移动使用 `move_path`；删除由调用方选择其他已授权能力。

## 2. 输入契约

工具输入只有 `patch`：

```ts
type ApplyPatchInput = {
  patch: string;
};
```

`format` 字段已删除。`patch` 必须是完整 V4A；Unified Diff 不受支持，也不会被检测、修正或转换。非 V4A 内容返回解析错误，不写入文件。

## 3. V4A 协议

当前工具接受的结构如下：

```diff
*** Begin Patch
*** Update File: path/to/existing-file.ts
@@ optional unique anchor
 context before
-old line
+new line
 context after
@@ another optional anchor
-another old line
+another new line
*** End Patch
```

约束如下：

- 第一条非空行必须是 `*** Begin Patch`，最后一条非空行必须是 `*** End Patch`。
- envelope 内必须且只能有一个 `*** Update File:`。
- 每个 hunk 必须显式以 `@@` 开始；`@@` 后面的 anchor 可省略。
- 每个 hunk 至少包含一条 `+` 或 `-` 变更行。只有 context 的 hunk 是语法错误。
- context、删除和新增行分别以空格、`-` 和 `+` 开头。
- 为容忍模型或序列化过程剥离空格，hunk 中的裸空行也按空 context 处理；hunk/结束标记前的裸空行按分隔行处理。需要明确表示 hunk 末尾的空 context 时使用单个空格前缀。
- `*** End of File` 可选，且只修饰它所属的 hunk。
- `*** Add File:`、`*** Delete File:` 和 `*** Move to:` 均不受支持。
- `*** End Patch` 后只允许空行。

`@@ anchor` 不是行号范围。它是一条用于缩小搜索位置的上下文行；真正的替换位置仍由 hunk 的旧内容定位。

## 4. 执行流水线

```text
解析完整 V4A envelope
  -> 校验 single-file、existing-file、update-only 约束
  -> 读取 UTF-8 文件
  -> 逐 hunk 匹配并计算内存结果
  -> 通过临时文件 + rename 原子替换目标文件
  -> 返回结构化 JSON
```

解析和匹配由仓库内执行器完成，不调用 shell `patch`。原因是工具需要稳定实施单文件边界、hunk 级部分应用、结构化错误和统一审核信息；这些不是通用 patch CLI 的契约。

写入阶段始终只有一次文件替换。所谓“部分应用”，是指先在内存中计算所有成功 hunk，最后一次性提交合并后的文件内容，不是对磁盘逐 hunk 写入。

## 5. 匹配规则

匹配从上一个成功 hunk 之后的 cursor 向文件尾部单向进行，不会回退到 cursor 之前。候选范围内的匹配位置必须唯一；重复上下文不会选择第一个位置，而是返回 `ambiguous_context`，重复 anchor 返回 `ambiguous_anchor`。遇到重复文本时，应增加唯一 anchor 或更多上下文，必要时拆成单独调用。

匹配顺序为：

1. 完全一致；
2. 忽略行尾空白；
3. 忽略行首和行尾空白。

模糊匹配只用于定位。未变的 context 行会保留文件中的原始文本和缩进。

## 6. 部分应用语义

V4A 先完整解析，再按 hunk 顺序在同一份内存内容上匹配：

- 语法错误：不匹配、不写入任何 hunk。
- 某个 hunk 匹配失败：记录失败，继续尝试后续 hunk。
- 成功 hunk：影响后续 hunk 看到的内存内容。
- 至少一个 hunk 成功：把所有成功结果通过一次原子替换写入。
- 所有 hunk 失败：不执行写入。

同一次调用中的 hunk 应按文件顺序排列；为降低部分失败风险，可将存在强依赖的修改拆成更小的调用。工具不会生成修复补丁、给出 next action，或自动重试失败块；它只披露实际成功和失败的部分，由模型自行决定后续处理。

## 7. 返回结构与 token 控制

成功结果只返回文件摘要和成功 hunk 编号，不回显成功 diff：

```json
{
  "ok": true,
  "file": { "path": "/abs/file.ts", "chunks": 2 },
  "appliedHunks": [1, 2]
}
```

部分成功时，`ok` 仍为 `false`，并明确标记 `partial: true`。只有失败块回显 diff 和诊断信息：

```json
{
  "ok": false,
  "partial": true,
  "phase": "match",
  "code": "partial_patch_applied",
  "message": "Applied 1 of 2 V4A hunks; 1 failed.",
  "file": { "path": "/abs/file.ts", "chunks": 1 },
  "appliedHunks": [1],
  "failedHunks": [
    {
      "hunk": 2,
      "diff": "@@ anchor\n-old\n+new",
      "code": "context_not_found",
      "message": "chunk 2: context not found in file.ts.",
      "closest": ["20: similar line"]
    }
  ]
}
```

所有 hunk 都失败时返回 `partial: false`、空 `appliedHunks` 和完整 `failedHunks`。解析或目标校验失败返回顶层 `phase`、`code`、`message`，以及可用的 `line`、`path`、`matches` 等诊断字段。

成功块只用编号确认；只有失败块携带原始 hunk diff。这既披露真实执行状态，也避免成功后重复消耗补丁文本 token。

## 8. TUI 与审核

- 调用开始和人工审核展示输入 patch 的 diff 预览。
- 执行输出不做 `apply_patch` 专属二次改写；TUI 使用通用工具输出渲染。
- 成功、部分成功和失败结构以工具实际返回为准，不维护另一套 UI 文案或 next-action 状态。
- 在全局 `auto_authorization` 模式下，如果 V4A 能解析出一个已存在文件，且目标的真实路径位于当前 workdir 内，toolkit 策略会确定性批准该调用，不再把 patch 交给模型分类器，也不会升级到人工审核。
- 目标位于 workdir 外、经过符号链接逃逸、文件不存在、V4A 无法解析或同一批次还包含未通过确定性策略的操作时，仍走原有 auto-review；信息不足或风险较高时继续要求人工审核。

## 9. 代码所有权与验证

- `services/local-agent/src/toolkits/local/applyPatch.ts`：V4A 解析、匹配和部分应用。
- `services/local-agent/src/toolkits/local/fileTools.ts`：工具 schema、目标校验、原子写入和结构化输出。
- `services/local-agent/src/toolkits/local/index.ts`：工具包级模型使用说明。
- `services/tui/src/timeline/operationDisplay.ts`：生产 TUI 的输入 patch 预览和通用工具输出渲染。
- `services/local-agent/src/localToolsFile.test.ts`：协议、匹配、部分应用、错误结构和工具注册测试。
- `services/tui/src/timeline/operationDisplay.test.ts`：当前 TUI 的输入 diff 与原始结果输出测试。
- `services/local-agent/evals/apply-patch-protocol.eval.ts`：真实模型的 V4A 生成和完成率评估。

实现变更至少应运行：

```bash
node --import tsx --test services/local-agent/src/localToolsFile.test.ts
npm run test -w @pinpawo/tui
npm run typecheck -w pinpawo
```
