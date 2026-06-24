# Toolkit HITL Policy Presets Design

> 状态：Draft v2
> 日期：2026-06-16
> 关联：issue #133

## 1. 核心原则

`ReviewPolicy` 的重点不是“review 内容怎么写”，而是“这个 tool call 是否需要 HITL”。

review 内容天然来自 tool call 本身，以及已有的 operation metadata。preset 不应该让具体 tool 重新声明 `normalize`、`classifyRisk`、`formatBody`、`authorizeInput` 这类规则；否则只是把旧 policy 换了一个地方重写。

目标 API 形态：

```ts
policy: {
  toolReview: {
    write_file: ReviewPolicies.localMutation(),
    apply_patch: ReviewPolicies.localMutation(),
    move_path: ReviewPolicies.localMutation(),
    copy_path: ReviewPolicies.localMutation(),
    mkdir_path: ReviewPolicies.localMutation(),

    run_shell: ReviewPolicies.commandExecution(),

    http_fetch: ReviewPolicies.externalAccess(),
    download_file: ReviewPolicies.externalAccess(),

    git_add: ReviewPolicies.localMutation(),
    git_commit: ReviewPolicies.localMutation(),
  },
}
```

这段配置本身就是 policy。除非进入 `custom()`，不应该再为每个 tool 写一套审核规则。

## 2. 分层职责

### 2.1 Tool

tool 负责执行动作和硬性校验。

例子：

- `run_shell` 继续硬性拒绝 `sudo`、heredoc、输出重定向写文件。
- `apply_patch` 继续解析 patch、校验上下文、保证原子写入。
- `write_file` 继续处理 `createDirs`、`append` 等执行细节。

这些是工具执行语义，不是 HITL policy。

### 2.2 Operation Metadata

operation metadata 只负责描述 tool call，供事件、日志、review view 使用。

允许字段：

```ts
type ToolOperationMetadata = {
  title?: string;
  titleKey?: string;
  summarizeInput?: (input: unknown) => ToolOperationSummary | null;
  summarizeOutput?: (output: unknown) => ToolOperationSummary | null;
  summarizeError?: (error: unknown) => ToolOperationSummary | null;
};
```

metadata 不负责决定：

- 要不要 HITL。
- 风险等级。
- 是否可以复用授权。
- 如何构造授权 identity。

如果某个 review 内容不清楚，优先补 `title` 或 `summarizeInput`，但不要把 policy logic 放进 metadata。

### 2.3 HITL Policy Preset

preset 只回答：

- 这个 tool call 是否需要 HITL。
- 当前 runtime 没有 HITL 能力时 block 还是 allow。
- 是否启用通用授权复用。

preset 不负责：

- 生成工具专属 review 文案。
- 解析 patch 并重组 review body。
- 计算风险等级。
- 读取文件 before/after diff。
- 生成 tool-specific authorization identity。

## 3. Presets

### 3.1 `ReviewPolicies.localMutation()`

用于会改变本地状态的工具。

适用：

- `write_file`
- `apply_patch`
- `move_path`
- `copy_path`
- `mkdir_path`
- `git_add`
- `git_commit`

默认行为：

- 需要 HITL。
- 没有 HITL 能力时 fail closed。
- review view 由 runtime 根据 operation metadata 和 raw input 通用生成。
- 默认不启用授权复用。

### 3.2 `ReviewPolicies.commandExecution()`

用于命令执行类工具。

适用：

- `run_shell`
- 后续可能的 `run_process`

默认行为：

- 配置了该 preset 的命令执行需要 HITL。
- 硬性禁止仍由 raw tool 自己处理。
- 默认不启用授权复用。

第一版不做“安全命令免审”的内置分类。需要更细的命令分类时，应先确认这是框架级通用规则，而不是某个 tool 的私有 policy。

### 3.3 `ReviewPolicies.externalAccess()`

用于访问外部系统的工具。

适用：

- HTTP request
- API call
- webhook
- download/upload
- 第三方服务调用

默认行为：

- 配置了该 preset 的外部访问需要 HITL。
- 默认不启用授权复用。

第一版不拆 `httpAccess()`、`apiCall()`、`webhookCall()`。这些是 tool/operation 的描述细节，不是 HITL 策略主抽象。

### 3.4 `ReviewPolicies.requireHitl()`

最低层通用 preset。

适用：

- 不想归类，但确定每次都要人确认的工具。
- 插件临时迁移。

### 3.5 `ReviewPolicies.never()`

明确声明不走 HITL。

没有 `toolReview` policy 也表示不走 HITL；`never()` 主要用于显式文档化。

### 3.6 `ReviewPolicies.custom()`

custom 是兜底，不是默认推荐路径。

适用：

- 需要多阶段审批。
- 需要外部服务参与判断。
- 需要非标准 review options。
- 确认无法由通用 preset 表达。

## 4. Runtime 生成 ReviewSpec

runtime 使用通用方式 materialize `ReviewSpec`：

```txt
title:
  operation.title
  fallback: tool name

body:
  operation.summarizeInput(input)
  fallback: raw input JSON
```

标准 options：

```ts
[
  approve(),
  reject(),
  respond(),
]
```

默认不出现 `approve-and-authorize`。如果某个 preset 显式打开通用授权复用，runtime 才追加该 option。

## 5. Authorization

第一版默认不启用授权复用。

原因：

- 文件内容、patch、header、body 等 raw args 可能很大或敏感。
- tool-specific identity 容易把 policy logic 搬进 operation metadata。
- 本轮优化目标是让 preset 像配置，而不是重新实现 policy。

保留一个通用 escape hatch：

```ts
ReviewPolicies.localMutation({
  authorization: 'exact_args',
})
```

`exact_args` 只适合参数小、稳定、无敏感信息的工具。复杂 identity 应进入 `custom()`，并在 review 中说明为什么不能使用 preset 默认行为。

## 6. 无头或非交互 Runtime

`reviewCapabilities` 必须由 host 显式传入。

交互式 host，例如 TUI、app chat，应传入对应 interface 的能力。无头路径，例如 once、定时任务、后台执行，应显式传入：

```ts
{
  humanReview: false,
  sessionAuthorization: false,
}
```

对于默认 `unavailable: 'block'` 的 preset，如果一次调用需要 HITL，而 runtime 没有 `humanReview` 能力，wrapper 必须 fail closed：不执行 raw tool，并返回 cancelled/error 结果。

需要在无头任务中执行变更类工具时，调用方必须：

- 提供支持 HITL 的 interface context。
- 或显式选择 `unavailable: 'allow'`。
- 或不要把变更类 toolkit 暴露给该无头任务。

## 7. 内置 Toolkit 迁移规则

local toolkit 使用 preset 配置表达默认 HITL：

```ts
toolReview: {
  write_file: ReviewPolicies.localMutation({ authorization: 'exact_args' }),
  apply_patch: ReviewPolicies.localMutation({ authorization: 'exact_args' }),
  move_path: ReviewPolicies.localMutation({ authorization: 'exact_args' }),
  copy_path: ReviewPolicies.localMutation({ authorization: 'exact_args' }),
  mkdir_path: ReviewPolicies.localMutation({ authorization: 'exact_args' }),
  http_fetch: ReviewPolicies.externalAccess({ authorization: 'exact_args' }),
  download_file: ReviewPolicies.externalAccess({ authorization: 'exact_args' }),
  run_shell: ReviewPolicies.commandExecution({ authorization: 'exact_args' }),
}
```

git toolkit：

```ts
toolReview: {
  git_add: ReviewPolicies.localMutation({ authorization: 'exact_args' }),
  git_commit: ReviewPolicies.localMutation({ authorization: 'exact_args' }),
}
```

browser toolkit：

```ts
toolReview: {
  browser_open: ReviewPolicies.externalAccess({ authorization: 'exact_args' }),
  browser_open_with_session: ReviewPolicies.externalAccess({ authorization: 'exact_args' }),
  browser_open_with_profile: ReviewPolicies.externalAccess({ authorization: 'exact_args' }),
}
```

只读工具不声明 policy：

- `read_file`
- `view_file_chunk`
- `list_dir`
- `glob_search`
- `grep_search`
- `git_status`
- `git_diff`
- `git_log`
- `git_show`
- `browser_snapshot`
- `browser_extract`
- `browser_wait`
- `browser_click`
- `browser_type`
- `browser_session`
- `browser_close`

## 8. 验收标准

- toolkit 的 `toolReview` 看起来像配置。
- 内置工具不再导出 `writeFileReviewPolicy` / `applyPatchReviewPolicy` 这类手写 policy。
- operation metadata 不包含 `effect`、`authorizeInput`、risk classifier 或 authorization identity。
- preset 中不出现 tool-specific `formatBody`。
- review view 内容来自 operation metadata 或 raw input 的通用格式化。
- custom policy 仍可用于少数特殊工具，但不作为默认推荐路径。
