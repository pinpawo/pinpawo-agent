# Authorization Matcher Lifecycle

> 状态：Implemented
> 日期：2026-07-31
> 关联：issue #512

## 目标

session authorization 只复用 toolkit 可信 policy 明确定义的同一调用身份。框架不拟合参数、不扩展 argv 前缀、不使用 wildcard，也不让 LLM 构造 matcher。

## 职责

- `ToolAuthorizationPolicy.buildMatcher()`：从当前 tool input 计算唯一的 candidate matcher。
- `ToolkitReviewMiddleware`：只计算一次 matcher，并依次负责命中检查、review 和持久化。
- authorization store：只比较 `toolName + matcher`，不读取原始 args 或工具 schema。
- LLM：只批准或拒绝当前 review batch，不能改变 matcher。

## Matcher

```ts
type ToolAuthorizationMatcher =
  | { type: 'exact'; key: string }
  | { type: 'url_origin'; origin: string };
```

`exactAuthorization(subject)` 对 JSON subject 做确定性 canonicalization 和 SHA-256。checkpoint 只保存带版本的 opaque digest，不保存命令、argv、文件内容、headers 或 body。

`url_origin` 是人工授权可使用的 origin 范围。auto-review 只能持久化 `exact`，不能自动建立 origin grant。

旧的 `exact_args`、`shell_pattern`、`url_domain` checkpoint record 会被忽略。

## 生命周期

1. middleware 调用 toolkit policy，得到 candidate matcher；失败时按 `null` 处理。
2. 当前模式允许使用的 session grant 中，如存在相同 `toolName + matcher`，直接执行，不触发 review LLM。
3. 未命中时进入 deterministic/global review。
4. human 的 “approve and authorize” 保存已经计算的 matcher，source 为 `human`。
5. `auto_authorization` 只在 runtime 支持 session store 且 matcher 为 `exact` 时保存，source 为 `auto_review`。
6. 同 key 的 human grant 替换 auto grant；auto grant 不能覆盖 human grant。
7. capability node 返回完整授权快照，checkpoint 跨 delegation、turn 和 graph rebuild 持久化。
8. registry authorization generation 改变时，旧快照整体失效。

`require_authorization` 不使用 auto grant，但不会删除它；human grant 在 require 和 auto 模式下均可使用。custom policy 默认也不使用 auto grant，只有显式设置 `reuseAutoAuthorizations: true` 才会复用。新 thread 使用独立 checkpoint state，不复用旧 grant。

## Tool-owned exact subject

默认 policy 对完整 input 建立 digest：

```ts
AuthorizationPolicies.exact();
```

工具可以显式排除不影响授权身份的运行参数：

```ts
AuthorizationPolicies.exact({
  subject: ({ input }) => ({
    argv: input.argv,
    cwd: normalizeCwd(input.cwd),
  }),
});
```

`run_shell` 当前使用规范化后的 `{ command, cwd }`，因此 timeout 变化可以复用，但 command 或 cwd 变化不能命中。它仍是 shell script 工具；本次改造不改变命令执行 API，也不引入命令语义拟合。

## Fail closed 和可观测性

- builder 抛错、subject 无法确定性序列化、matcher 无效：不命中、不保存，继续 review。
- recorder 不存在：当前调用仍可获批，但不建立 session grant。
- 未知或旧 matcher：读取时忽略。
- 工具执行失败：不撤销 grant，授权表达“允许尝试调用”。

诊断事件为 `tool_authorization_hit`、`tool_authorization_miss`、`tool_authorization_recorded`、`tool_authorization_upgraded`。事件只暴露 tool name、matcher type、source 和 thread scope，不包含 digest 或原始 subject。
