# Apply Patch Tool Implementation

> 状态：Implemented
> 日期：2026-08-09
> 范围：`services/local-agent` 的本地 `apply_patch` 工具

## 1. 目标

`apply_patch` 只负责修改一个已存在的文本文件。它提供两种显式协议：

- `v4a`：面向模型生成的小块补丁协议，支持 hunk 级部分应用和失败披露。
- `unified`：标准 Unified Diff 的单文件更新子集，保持整次原子应用。

工具不负责新建、删除或移动文件，也不在一次调用中更新多个文件。新建或完全重写使用 `write_file`，移动使用 `move_path`；删除由调用方选择其他已授权能力。缩小单次调用范围可以降低生成错误的影响，也让审核、执行结果和失败内容更容易理解。

## 2. 对外输入契约

工具输入只有两个字段：

```ts
type ApplyPatchInput = {
  format: 'v4a' | 'unified';
  patch: string;
};
```

`format` 必填，并且必须与 `patch` 的实际内容一致。工具会检测协议，但不会自动转换、修正或猜测 mixed 内容：

- 声明 `v4a` 时，内容必须是完整 V4A envelope。
- 声明 `unified` 时，内容必须包含 Unified Diff 文件头和 hunk header。
- 声明格式与检测格式不同时返回 `patch_format_mismatch`。
- Unified Diff 中出现无前缀的 `*** Begin Patch` 或 `*** End Patch` 时返回 `mixed_patch_formats`。带 `+`、`-` 或空格前缀的同名文本仍是合法文件内容。

## 3. V4A 协议

当前工具接受的 V4A 子集如下：

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
- `*** End of File` 可选，且只修饰它所属的 hunk。
- `*** Add File:`、`*** Delete File:` 和 `*** Move to:` 均不受支持。
- `*** End Patch` 后只允许空行。

`@@ anchor` 不是行号范围。它是一条用于缩小搜索位置的上下文行；真正的替换位置仍由 hunk 的旧内容定位。

## 4. Unified Diff 协议

当前工具接受标准 Unified Diff 的单文件更新子集：

```diff
--- path/to/existing-file.ts
+++ path/to/existing-file.ts
@@ -10,3 +10,3 @@
 context before
-old line
+new line
 context after
```

可以带 `diff --git`、`index` 和 mode metadata，但有以下限制：

- `---` 与 `+++` 必须指向同一路径。
- `/dev/null`、`new file mode` 和 `deleted file mode` 会被拒绝。
- 第二组文件头会返回 `multiple_file_patches`。
- 每个 hunk 必须至少包含一条 `+` 或 `-` 变更行。
- hunk header 的 old/new range 用于语法识别，不作为执行定位依据；执行仍按上下文匹配。

Unified Diff 是 all-or-nothing：任意 hunk 解析或匹配失败，都不会写入文件。

## 5. 执行流水线

```text
校验输入 format
  -> 检测并解析协议
  -> 校验单文件、existing-file、update-only 约束
  -> 读取 UTF-8 文件
  -> 按协议匹配 hunk
  -> 计算内存中的最终内容
  -> 通过临时文件 + rename 原子替换目标文件
  -> 返回结构化 JSON
```

解析和匹配由仓库内的执行器完成，不调用 shell `patch`。原因是工具需要稳定实施单文件边界、V4A hunk 级部分应用、结构化错误和统一审核信息；这些并不是通用 `patch` CLI 的完整契约。

写入阶段始终只有一次文件替换。所谓 V4A “部分应用”，是指先在内存中依次计算所有成功 hunk，最后一次性提交合并后的文件内容，不是对磁盘逐 hunk 写入。

## 6. 匹配规则

两种协议都要求匹配位置唯一。重复上下文不会选择第一个位置，而是返回 `ambiguous_context`；重复 anchor 返回 `ambiguous_anchor`。

V4A 的匹配顺序为：

1. 完全一致；
2. 忽略行尾空白；
3. 忽略行首和行尾空白。

模糊匹配只用于定位。未变的 context 行会保留文件中的原始文本和缩进。

Unified Diff 只允许完全一致或忽略行尾空白，不忽略行首缩进。

## 7. V4A 部分应用语义

V4A 先完整解析，再按 hunk 顺序在同一份内存内容上匹配：

- 语法错误：不匹配、不写入任何 hunk。
- 某个 hunk 匹配失败：记录失败，继续尝试后续 hunk。
- 成功 hunk：影响后续 hunk 看到的内存内容。
- 至少一个 hunk 成功：把所有成功结果通过一次原子替换写入。
- 所有 hunk 失败：不执行写入。

因此同一次调用中的 hunk 应彼此独立。工具不会生成修复补丁、给出 next action，或自动重试失败块；它只披露实际成功和失败的部分，由模型自行决定后续处理。

## 8. 返回结构与 token 控制

成功结果只返回文件摘要和成功 hunk 编号，不回显成功 diff：

```json
{
  "ok": true,
  "format": "v4a",
  "file": { "path": "/abs/file.ts", "chunks": 2 },
  "appliedHunks": [1, 2]
}
```

V4A 部分成功时，`ok` 仍为 `false`，并明确标记 `partial: true`。只有失败块回显 diff 和诊断信息：

```json
{
  "ok": false,
  "partial": true,
  "format": "v4a",
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

所有 V4A hunk 都失败时返回 `partial: false`、空 `appliedHunks` 和完整 `failedHunks`。解析、目标校验或 Unified Diff 匹配失败则返回顶层 `phase`、`code`、`message`，以及可用的 `line`、`path`、`matches` 等诊断字段。

这个结果设计刻意压缩成功输出：成功块只用编号确认；只有失败块携带原始 hunk diff。它既向模型披露真实执行状态，也避免每次成功后重复消耗补丁文本 token。

## 9. TUI 与审核

- 调用开始和人工审核仍展示输入 patch 的 diff 预览。
- 执行输出不做 `apply_patch` 专属二次改写；TUI 使用通用工具输出渲染。
- 因而成功、部分成功和失败结构以工具实际返回为准，不维护另一套 UI 文案或 next-action 状态。

## 10. 代码所有权与验证

- `services/local-agent/src/toolkits/local/applyPatch.ts`：协议检测、V4A 解析、共享匹配与部分应用。
- `services/local-agent/src/toolkits/local/unifiedDiff.ts`：Unified Diff 单文件 update 解析。
- `services/local-agent/src/toolkits/local/fileTools.ts`：工具 schema、目标文件校验、原子写入和结构化输出。
- `services/local-agent/src/toolkits/local/index.ts`：工具包级模型使用说明。
- `services/local-agent/src/tui/components/applyPatchDisplay.ts`：输入 patch 预览。
- `services/local-agent/src/tui/components/agentTimelineRendering.ts`：通用工具输出渲染。
- `services/local-agent/src/localToolsFile.test.ts`：协议、匹配、部分应用、错误结构和工具注册测试。
- `services/local-agent/src/tui/components/agentTimelineRendering.test.ts`：输入 diff 与原始结果输出测试。
- `services/local-agent/evals/apply-patch-protocol.eval.ts`：真实模型的协议选择、格式一致性和完成率评估。

实现变更至少应运行：

```bash
node --import tsx --test services/local-agent/src/localToolsFile.test.ts
node --import tsx --test services/local-agent/src/tui/components/agentTimelineRendering.test.ts
npm run typecheck -w pinpawo
```
