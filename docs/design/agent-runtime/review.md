# Review and Interrupt Runtime Design

> Status: working design; current runtime behavior is described in
> [Native human review interrupts](interrupt.md). This page retains the review
> policy, replay/validation details, and compatibility evidence.
> Related: issues #133, #675, #684, #721, #747 and #749; PR #682.
> Host boundary: [Resident Pet Host ports](resident-pet-host-ports.md).

The Agent interrupts a run when a tool action requires human review. Review
policy decides whether to proceed, block, or request review; the interrupt and
resume path handles a pending human decision. Review is not a second state
machine beside the runtime checkpoint.

Only human review is a resumable interrupt in the current runtime. Reject or
cancel ends the current round and preserves the plan; a later explicit input
starts a fresh run. There is no `PauseTaskInterrupt`, pause gate, empty-input
resume, or retained paused Capability execution. See [Interrupt Domain](interrupt.md)
and [Root, Supervisor and Capability](run-scoped-supervisor-session.md).

The earlier design proposed a distinct task-pause interrupt and a private
replay helper. Those sections are superseded: the
[original review design at main commit 29f0bec9](https://github.com/pinpawo/pinpawo-agent/blob/29f0bec9094a0be57ed48f03778ce2a7ccc6ac3d/docs/design/agent-runtime/review.md)
and [historical delegation pause design](../tui/delegation-pause-interaction.md)
retain their context. They are not current contracts.

## 工具审核策略

当前配置入口是 `ToolDefinition.review`，不是独立的 `toolReview` 映射。
Tool 负责参数和硬性执行校验；operation metadata 描述调用，不决定授权；
review policy 决定是否需要审核。[Toolkit 绑定](../../../packages/pet-agent/src/agent/orchestrator/subagentDispatch.ts)
保留原始工具并收集 review bindings，由 `ToolkitReviewMiddleware.afterModel` 在执行前审核，
不为每个工具增加执行 wrapper。

[ReviewPolicies](../../../packages/pet-agent/src/autoReview/reviewPolicies.ts)
提供 `required()`：要求审核（由谁审核取决于全局策略：人工、自动或自定义），默认在 Host 不支持 human review 时阻止执行，默认不启用授权复用。
早期按工具类别命名的 preset（`localMutation`、`commandExecution`、`externalAccess`）行为完全相同，
类别从未成为审核输入，是否放行由全局策略与 AutoReviewer 针对具体动作判断，因此已收敛为 `required()`。
若将来审核或界面需要工具类别，应作为 operation metadata 的显式字段引入，而不是重新用 preset 名称承载。
`never()` 返回无需审核，`custom()` 接受自定义策略；preset 不负责按命令名称推断安全性。
Host 显式提供 `reviewCapabilities`，调用方可通过 `unavailable: 'allow'` 显式选择无审核时放行，
不能将其当作默认降级行为。

审核内容来自 operation 摘要或输入，标准操作为 approve、reject、respond。
只有配置了授权 matcher 且 Host 支持 session authorization 时才提供授权复用选项。
`exact` / `url_origin` 的匹配及 generation 约束见
[授权契约](../../reference/runtime/authorization-matcher.md)。
全局审核策略与具体批准、拒绝、取消和恢复语义见下文及 [Interrupt Domain](interrupt.md)。

### 风险控制原则

整体偏宽松。设计好工具、相信模型按描述选工具。一个调用免审核，只能来自下面两种
机制，两者都不需要逐条补规则：

- **结构保证**：工具参数本身表达不了危险操作。例如 `git_push` 没有 force 参数，
  refspec 以 `+` 或 `:` 开头会被 schema 拒绝；`git_add` 只接受显式 pathspec。
- **只读白名单，认不出就不放行**：`inspect_shell` 只把白名单里的 git/gh 查看形式
  当作只读，认不出的子命令、别名或全局选项一律拒绝，并提示改用会审核的
  `run_shell`。漏判的代价是多一次审核，不会变成免审核的写操作。

不在自由格式命令里"先放行日常写操作、再列举危险形式去拦"：git/gh 的参数组合
列不完，每漏一种就是一条免审核的危险路径（2026-10-27 #1013 review 发现的路径
checkout、`--` 后的 refspec、`gh pr checkout --force` 都属此类）。所以
`git_shell` / `gh_shell` 和按命令免审 `run_shell` 的做法都已删除。

1. **`inspect_shell` 免审核，省掉一次审核（auto review 时也省一次模型调用）。**
   用来跑 rg、cat、sed -n、git status/log/diff/show、gh pr view/diff/checks 这类
   查看命令。除 git/gh 的只读白名单外，其余靠黑名单兜底：它是引导，不是保证；
   拒绝时提示改用哪个工具，不追求完整，不是沙箱。漏掉的情况意味着模型违背描述
   使用工具，属于"相信模型"接受的风险。
   - 不可逆操作：rm/dd/提权/强制 kill 等，改用 `run_shell`。
   - 常见写法：重定向到文件、`sed -i`、`mv`、`cp`、`tee` 等写文件（改用文件工具或
     `run_shell`）；包管理器的安装、发布和脚本（只放行 ls/view/outdated 这类只读
     子命令）；curl 的写请求和写文件、wget 下载；`make`；运行脚本文件
     （`bash x.sh`、`source`）。
   - git/gh 不在只读白名单里的形式，改用专用写工具或 `run_shell`。
   - 不检查解释器内联代码（`python -c`、`node -e`）和其他动态代码。
   见 `services/host/src/toolkits/shell/readOnlyShell.ts`，git/gh 白名单在
   `services/host/src/toolkits/cli/{gitCommands,ghCommands}.ts`。
2. **日常写操作用结构化工具，免审核。** `git_add`、`git_commit`、`git_push`、
   `gh_pr_create`、`gh_issue_create` 的参数结构排除了危险形式，直接执行。只有
   高频、且能用结构排除危险形式的操作才值得做成专用工具。
3. **`run_shell` / `start_process` 每次审核，放心让 LLM 调用。** 审核就是这类工具
   的防线，描述里不再额外限制使用时机。其他 git/gh 写操作（切换分支、stash、
   rebase、评论、合并等）都走这里。auto review 只按通用风险分档判断，丢弃未提交
   改动、强推、删除远端引用、合并等已在最高档里；shell Toolkit 不再另列 git/gh
   的 `reviewGuidance` 清单。列清单同样是逐条补规则：列出的形式会不看任务一律
   判最高分，没列出的反而被低估（#1013 实测：任务明确要求丢弃单个文件的
   `git restore` 从 1 变成 10，复制 SSH 私钥到 /tmp 从 10 掉到 9）。

## Auto review 领域边界

[autoReview](../../../packages/pet-agent/src/autoReview/index.ts) 承载静态 policy、
preset、matcher 和动态 AutoReviewer，不依赖 orchestrator 或 interrupt。
Toolkit 提供具体工具规则；AutoReviewer 只评估当前动作，不读 session、不创建授权。
orchestrator 负责模式选择、授权持久化与执行/人工交互；ReviewSpec 属于共享 types。

授权范围、自动复用条件和混合批次筛选只在
[授权契约](../../reference/runtime/authorization-matcher.md) 定义，不在本文重复。

模型对待评估动作评分，程序按 strict ≤ 2、relaxed ≤ 9 放行。
模型失败、10 分或完整证据超出预算时转人工，不裁掉执行参数后放行。

结构化输出的 `autoRepair` 只处理 schema 校验失败、LangChain 的
`OutputParserException` 及 provider 原生 parser 抛出的 `ZodError`，通过原生
`Runnable.withRetry` 做有限修复。默认允许一次额外调用，配置最多三次；
修复请求保留原始证据，并追加一条有长度上限的校验反馈，
只携带字段路径和错误代码，或通用解析失败标记，不回传非法输出、provider 错误正文。
后续失败替换这条反馈，不累积新的上下文。显式关闭适用于推断和默认结构化方法，
不改变兼容端点的 `jsonMode` 例外及显式 `method` / `strict`。

transport 重试由模型 SDK 的 `maxRetries` 和 backoff 负责；SDK 最终抛出的网络、
限流、认证或配置错误不会再进入 schema 修复；没有明确 parser 类型的
`SyntaxError` / `TypeError` 也不推测为非法响应。若额外修复次数为 R、SDK 额外重试
次数为 T，一次逻辑评估最多发起 `(1 + R) × (1 + T)` 个 provider 请求；默认
R=1、Host 默认 T=2，最多六个（只有每个逻辑调用都用完 transport 重试后又得到
非法结构时才达到此上限）。取消会结束等待，并在每次实际调用前检查同一 signal，
禁止 backoff 结束后再发起模型请求。私有审批及修复继续使用 `callbacks: []`，
保留继承的 signal、metadata 和 configurable；修复耗尽仍走转人工结果，
不改变 policy task 的检查点边界和 strict / relaxed 阈值。

具体风险边界见[系统提示](../../../packages/pet-agent/src/autoReview/prompts/templates.ts)，
由 [auto-review eval](../../../tests/agent-evals/src/auto-review-risk.eval.ts) 验证。

## Resume input validation

Toolkit Review uses one strict Zod schema for the canonical ordered
`{ decisions: [...] }` response and `{ action: 'cancel' | 'interrupt_run' }`.
Identifiers retain their existing whitespace normalization. The schema validates
the transport shape; matching the current review and option, validating inputs
and authorization effects, and requiring every approval before executing a batch
remain Runtime policy.

`ReviewInterrupt` passes this schema to LangGraph's
`interrupt(payload, { responseSchema })`. Native validation rejects malformed
values before adding them to the node's consumed resume history. The Runtime
catches `isInvalidResume()` and uses the existing `invalid_decision` interaction,
while letting `GraphInterrupt` propagate unchanged. This also permits an old
checkpoint's already-recorded malformed slots to replay through the invalid
decision loop before consuming a corrected response at its pending slot; no
private Pregel access or checkpoint rewrite is required.

LangGraph records an interrupt-addressed `Command` routing map before running the
node, so native validation alone does not keep malformed command envelopes out
of storage. Agent Session turns in the Host preflight the response against the
same Runtime schema when its interrupt ID matches the pending review. Malformed
input re-presents that review with the existing invalid-decision view and leaves
the run waiting, without invoking the graph, writing a resume, or reevaluating
policy. This feedback is a view projection; the stored review remains unchanged.
Stale and closed interrupt handling retains its existing owner and behavior.
Direct LangGraph callers can still retain the upstream addressed routing entry;
they should preflight through `isValidHumanReviewResume()` when that storage
boundary matters. Native validation still prevents consuming it as a valid slot.

Direct graph clients receive the native `response_schema` metadata. Agent
Session and UI contracts continue to render `ReviewSpec`, which already owns
the view, options and form input; they do not gain a second JSON-schema form
contract. Approve, Respond, Reject, Cancel, whole-batch stopping and thread grants
retain their existing semantics.

## LangGraph 1.5.1 saver and message compatibility

The locked `langchain` 1.5.14 `createAgent` uses `MessagesValue`, a
`ReducedValue` with `messagesStateReducer`; it does not opt into experimental
`MessagesDeltaValue` or `DeltaChannel`. The root Orchestrator likewise uses
`messagesStateReducer`. No current default message path needs delta-history replay.

LangGraph 1.5.0 changed the saver write-order contract
([upstream #2961](https://github.com/langchain-ai/langgraphjs/pull/2961)). FileSaver
persists the optional `taskPath` and numerical write index, and returns writes
from both `getTuple()` and `list()` using the official `writesSortKey` comparator.
Version-1 manifests remain readable: missing paths use `''`, and missing indices
come from the existing storage key. Reads do not rewrite old manifests; a later
write adds the metadata without changing checkpoint values or retention policy.
Checkpoint advancement validates manifest identity and reachable object hashes
within the namespace it can prune. Reused content-addressed objects are checked
before a new checkpoint or pending write references them. Startup maintenance
and GC validate every namespace before pruning or sweeping. A damaged reference
aborts the affected operation instead of erasing potential recovery evidence.
Advancing one namespace does not reread unrelated completed subgraphs.

This does not reconstruct task paths that old writers never recorded. Follow
upstream's drain-before-upgrade boundary for an incomplete parallel delta-writing
superstep, or functional tasks under Send/error-handler paths whose identities
changed. That boundary is separate from this PR's newly checkpointed Review policy.
It does not make every old checkpoint incompatible.

FileSaver still retains only the latest checkpoint per namespace. It rejects
unsnapshotted Delta checkpoints before publishing/pruning, and explicitly rejects
requests for missing ancestor delta history, instead of silently rebuilding empty
state. A DeltaChannel works only when its snapshot is actually present in every
saved checkpoint; `snapshotFrequency: 1` alone does not guarantee this when
a later step updates only other channels. Other delta graphs need a full-history
saver. This is a supported-storage boundary, not evidence of
a failure in the current default Agent topology. No production data is migrated.

LangGraph 1.5.1 also converts message chunks into ordinary messages in both
message reducers ([upstream #3038](https://github.com/langchain-ai/langgraphjs/pull/3038)).
FileSaver regressions exercise real `createAgent` invoke and v2/v3 streaming,
Review interruption, tool-call edit/rejection, fresh saver instances, and the next
model input. Parsed calls must not be rebuilt from stale `tool_call_chunks`.
This fix is not a general synchronization rule for every message representation:
v3 also has canonical `content` tool-call blocks. With the unchanged core 1.2.13,
clearing only `tool_calls` while leaving those blocks can reconstruct calls on
reload; deleting a call must update both representations. The regression fixture
does so explicitly. Current Toolkit Review Reject retains calls with terminal
ToolMessages, while Cancel removes the whole message; neither relies on clearing
only that array. This separately reproduced fixture risk is not a claim of a
production failure and does not change `reasoningPassback`.

The Host v3 projection also consumes initial text in `content-block-start`,
while filtering reasoning/thinking blocks from public text, including committed
message and tool-call fallbacks. Integration fixtures use the actual Host graph
service and FileSaver with a deterministic streaming model, and separately use
the model factory's native ChatOpenAI path against localhost SSE. The latter
verifies the next provider request carries the aggregated reasoning and the
matching tool result, without calling a paid service.

A separate limitation remains for custom LangChain chat models that implement
only the legacy `_streamResponseChunks` bridge: a text block and tool-call chunk
both indexed `0` can collide in core 1.2.13's `convertChunksToEvents`, losing
the parsed tool call. A marked TODO regression captures the observed failure;
the native ChatOpenAI event path does not reproduce it in the localhost fixture.
The public `AgentModels` and `createSubagent` contracts accept caller-provided
`BaseChatModel`s, but mixed text and tool calls through this legacy v3 bridge
cannot currently be guaranteed. The exact upstream issue is
[langchainjs #11074](https://github.com/langchain-ai/langchainjs/issues/11074);
its proposed fixes are not merged as of this review, and the latest available
core 1.3.2 still contains the colliding index logic. No claim is made that a
particular production provider has exhibited this failure.

## Replay-safe Review policy

[ToolkitReviewMiddleware](../../../packages/pet-agent/src/agent/orchestrator/toolkitReviewMiddleware.ts)
prepares tool-specific review requests and resolves the global policy in a
checkpointed `task('toolkitReviewPolicy', ...)`. On native review resume, the
recorded task result prevents repeating that policy work. Toolkit `request()`
and `canAutoApprove()` preparation can replay and must remain deterministic.
The nested-task replay fix is included in LangGraph 1.5.1; the earlier private
Pregel resume-field compatibility helper was removed. See
[issue #749](https://github.com/pinpawo/pinpawo-agent/issues/749). This prevents
repeating the recorded policy task on native review resume; it does not provide
an exactly-once guarantee for external tool side effects across crashes.

## Review semantics

A single model message can propose multiple tool calls. Required review is
resolved for the batch before any reviewed call executes. The
[ReviewInterrupt implementation](../../../packages/pet-agent/src/agent/orchestrator/interrupt/reviewInterrupt.ts)
owns response resolution and the resulting message transition.

- **Approve:** after the batch validates, reviewed tools execute under their
  authorization rules.
- **Respond:** the provided information becomes guidance for the reviewed child;
  all tool calls in that model action are skipped and receive paired results.
- **Reject:** all tool calls in that model action are skipped. The runtime
  preserves the action and appends paired cancellation tool results before
  ending the current round.
- **Cancel:** the unexecuted proposed action is removed and the current round
  ends; no rejection result is fabricated.
- **Invalid or stale response:** the Host checks the pending interrupt identity;
  the Runtime checks the option and input. A recoverable invalid response can
  present the review again without executing tools.

Reject and cancel produce an explicit unexecuted-action explanation. No further
Supervisor, model, tool or Capability finalize call is made to stop that round.
A later explicit user message enters Entry and may continue the preserved plan.
See [Native human review interrupts](interrupt.md) for the current behavior.

## Running cancellation

Cancelling an active run aborts execution; it does not create a synthetic task
pause interrupt. An already-pending human review remains pending. Cancellation
cannot roll back an external side effect already committed by a tool; tools
should honor `AbortSignal` where possible. See [settleAbortedRun](../../../packages/pet-agent/src/agent/orchestrator/interrupt/settleAbortedRun.ts).

## Layer ownership

The Agent Session interface projects an interrupt and submits a response by ID.
The Host routes the command and validates it against the current checkpoint;
the Runtime resolves the review and owns its message transition. LangGraph owns
checkpointed execution and native interrupt resume. Exact wire shapes are in the
[session projection reference](../../reference/runtime/session-projection.md).
