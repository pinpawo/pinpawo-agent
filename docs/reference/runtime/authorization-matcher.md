# Authorization Matcher Lifecycle

> 状态：Implemented
> 日期：2026-07-31
> 关联：issue #512

## 目标

session authorization 只复用 toolkit 可信 policy 明确定义的同一调用身份。框架不拟合参数、不扩展 argv 前缀、不使用 wildcard，也不让 LLM 构造 matcher。

## 职责

- `ToolReviewPolicy.canAutoApprove()`：auto 模式下的直接放行规则；仅 `true` 批准当前调用，`false` 或抛错继续审核，不表示拒绝，也不建立复用授权。
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

`exactAuthorization(subject)` 对严格的 JSON subject 做确定性 canonicalization 和 SHA-256。`undefined`、非有限数值、非普通对象和循环引用都会 fail closed，不会被折叠成其他授权身份。checkpoint 只保存带版本的 opaque digest，不保存命令、argv、文件内容、headers 或 body。

`exact` 精确匹配的是 policy 选定的 subject，不一定是完整 input。`url_origin` 匹配协议、主机与有效端口；路径和 query 不影响匹配，但不同协议、子域或非默认端口不会命中。origin 范围只能由人工授权，模型不能建立或复用自动 origin grant。

matcher 是静态覆盖范围，不是批准结论。新增 matcher 类型时需同时扩展领域类型、解析/校验与相等比较；未知类型默认忽略，不能因为新增类型就自动开放模型授权复用。

旧的 `exact_args`、`shell_pattern`、`url_domain` checkpoint record 会被忽略。

## 生命周期

1. middleware 调用 toolkit policy，得到 candidate matcher；失败时按 `null` 处理。
2. 当前模式允许使用的 session grant 中，如存在相同 `toolName + matcher`，直接执行，不触发 review LLM。
3. auto 模式下对仍需审核的调用分别执行 `canAutoApprove()`；只将未决调用交给 review LLM。全部确定性通过则跳过模型。整个批次仍一起放行或停止；人工回退展示完整待审核批次，原生 interrupt 恢复沿用原决策，不重新评分。
4. human 的 “approve and authorize” 保存已经计算的 matcher，source 为 `human`。
5. `auto_authorization` 只对模型实际评估的调用，在 runtime 支持 session store、matcher 为 `exact` 且 policy 声明 `reuseAutoReview: true` 时保存，source 为 `auto_review`。读取 auto grant 时也检查该声明；人工 grant 不受该字段限制。
6. 同 key 的 human grant 替换 auto grant；auto grant 不能覆盖 human grant。
7. capability node 返回完整授权快照，checkpoint 跨 delegation、turn 和 graph rebuild 持久化。
8. registry authorization generation 改变时，旧快照整体失效。

authorization generation 标识注册工具的 `canAutoApprove()`、`buildMatcher()` 与 `reuseAutoReview`。函数源码 fallback 不捕获 closure state；如果闭包数据改变了授权或 subject 投影语义，policy 定义也必须同步升级。generation 不是工具实现或完整运行时代码的完整性证明。

`canAutoApprove` 是 review policy 上可选的快捷规则，`authorization.buildMatcher` 独立负责授权复用，两者可共存。已有授权命中时无需运行快捷规则，因此它不是必须执行的安全校验；硬性限制应由工具保证。当前 `apply_patch` 只配置快捷规则，没有 matcher。

`require_authorization` 不使用 auto grant，但不会删除它；human grant 在 require 和 auto 模式下均可使用。custom policy 默认也不使用 auto grant，只有显式设置 `reuseAutoAuthorizations: true` 才会复用。新 thread 使用独立 checkpoint state，不复用旧 grant。

## Tool-owned exact subject

默认 policy 对完整 input 建立 digest：

```ts
AuthorizationPolicies.exact();
```

完整 input 的 exact 默认允许复用模型批准。自定义 subject 或自定义 builder 默认不允许，工具可以在确认排除的参数不会改变授权范围后显式启用：

```ts
AuthorizationPolicies.exact({
  reuseAutoReview: true,
  subject: ({ input }) => ({
    argv: input.argv,
    cwd: normalizeCwd(input.cwd),
  }),
});
```

`run_shell` 当前使用规范化后的 `{ command, cwd }`，因此 timeout 变化可以复用，但 command 或 cwd 变化不能命中。它仍是 shell script 工具；本次改造不改变命令执行 API，也不引入命令语义拟合。

AutoReviewer 接收完整当前输入及候选 matcher 类型、自动复用条件，不接收 digest，也不能修改 subject 或创建 grant。允许复用不是降低当前调用风险评分的理由。当前调用获批但未启用自动复用时，仍可执行，只是不保存自动 grant。

## Fail closed 和可观测性

- builder 抛错、subject 无法确定性序列化、matcher 无效：不命中、不保存，继续 review。
- recorder 不存在：当前调用仍可获批，但不建立 session grant。
- 未知或旧 matcher：读取时忽略。
- 工具执行失败：不撤销 grant，授权表达“允许尝试调用”。

诊断事件为 `tool_authorization_hit`、`tool_authorization_miss`、`tool_authorization_recorded`、`tool_authorization_upgraded`。事件只暴露 tool name、matcher type、source 和 thread scope，不包含 digest 或原始 subject。
