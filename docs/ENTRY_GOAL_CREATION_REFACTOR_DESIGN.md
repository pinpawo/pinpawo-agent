# Entry 收缩为 Goal Creation 的设计

> 状态：Implemented on this branch；real-model latency/token baseline pending
>
> 依赖：#619、#621、#622、#625 已合并；trace-scoped private Planner、Planner
> terminal commit 与 General 默认候选已经成为生产基线。
>
> 目标：删除 Entry 对“直接回答还是开始规划”的语义判断，只保留一次 run 的稳定目标创建；
> 所有新任务统一进入 Capability Planner，由 Planner 决定执行、直答、等待用户或不可执行。

## 1. 结论

保留一个轻量入口节点，但把它从 `entryDecision` 收缩为 `goalCreation`。

`goalCreation` 只读取主对话并创建根图需要持久保存的 `runUserGoal`。模型不再输出 JSON、
function call 或其他结构化对象；它输出的整段普通文本本身就是 User Goal：

```ts
type UserGoal = string;
```

该文本不会作为 assistant message 追加到 canonical conversation，只作为 Root state 中的目标值保存。
Goal Creation 不再输出 `answer | needs_plan`，也不判断是否需要工具。完成目标创建后固定进入
`capabilityPlanner(entry)`。

Planner entry 新增无 payload 的 `answer_directly` terminal action，用于表示：当前目标可以由
Answer 基于 canonical main conversation 直接回复，不需要启动 Capability execution。

目标拓扑：

```text
START
  -> prepare
  -> compactContext
  -> goalCreation
  -> capabilityPlanner(entry)
       |-- execute_plan       -> capability
       |-- answer_directly    -> answer
       |-- user_input_required-> answer
       `-- unavailable        -> answer

capability
  -> plannerBoundaryIterationGuard
  -> capabilityPlanner(boundary)
       |-- continue_current   -> capability
       |-- execute_plan       -> capability
       |-- goal_done          -> answer
       |-- user_input_required-> answer
       `-- unavailable        -> answer
```

新格式 checkpoint 上，`resume_active` 的两条既有路径保持不变：

- pending delegation 直接恢复 Capability；
- awaiting-decision delegation 直接恢复 boundary Planner；
- resume 不重新创建目标，也不创建新的 Planner session。

包含旧对象格式 `UserGoal` 的 checkpoint 不恢复、不迁移，直接返回明确的不兼容提示，要求用户重新发起任务。

## 2. 为什么现在可以收缩 Entry

在 #619 之前，Entry 与旧 Planner / Outcome 分工不完整，Entry 需要提前挡住一些不应进入执行链路的请求。

完成 private Planner 重构后，Planner 已经拥有：

- entry task boundary；
- Capability discovery 与选择；
- `execute_plan`；
- `request_user_input`；
- `report_unavailable`；
- boundary 的 `continue_current`、`execute_plan` 与 `complete_goal`；
- 同一 trace 的私有 checkpoint 与上下文。

因此，当前 Entry 剩余的 `answer | needs_plan` 判断已经成为第二个 Planner：

- Entry 判断是否需要调用工具；
- Planner 再判断是否存在可执行计划；
- 两者都会处理歧义、已有事实和执行必要性；
- Entry 的 result-availability eval 与 Planner entry eval 存在重叠。

删除这层判断后，一个新目标只有一个规划所有者：Capability Planner。

### 2.1 为什么 Goal Creation 不再使用结构化输出

当前 Entry 的结构化输出同时承载两类信息：

- 控制路由：`answer | needs_plan`；
- 目标内容：`planner_objective` 与 `planner_context`。

路由被删除后，剩余语义只有“生成一个 User Goal”。继续要求 JSON schema 或 function call 不再提供
控制价值，反而保留了 provider structured-output 差异、tool-call 形状错误、repair retry 和两套 transport。

目标本身天然是文本：它需要准确保留路径、URL、约束、指代与必要背景，但 Root 不需要分别读取这些
组成部分。因此完整模型文本可以直接成为稳定的 `UserGoal` 值。

这不意味着整个 orchestrator 取消结构化控制：Planner 的 terminal action 会直接改变 graph route，仍必须
使用已建立的 terminal tool 协议；Goal Creation 没有路由选择，所以不需要结构化输出。

## 3. 为什么不立即完全删除入口节点

根图仍需要一个稳定、公开、可 checkpoint 的 `runUserGoal`。它被以下运行时逻辑消费：

- Planner entry 与后续 boundary invocation；
- `TaskActiveDelegation.userGoal`，用于 interruption / resume；
- Answer 的当前目标范围；
- trace 内多 task 的统一验收目标；
- telemetry 与调试事实。

Planner 的完整上下文必须保持私有。除 terminal action 和 plan tasks 外，Planner 不应把目标理解、
搜索结果、文档内容或自由文本提交到 Root。让 Planner 顺便输出规范化 `UserGoal` 会扩大 Root/Planner
协议并破坏该边界。

因此本次不把目标创建塞进 Planner commit，而是保留一个职责单一的 `goalCreation` 节点。

以后只有在以下条件得到验证后，才继续讨论删除 `goalCreation`：

1. Root 可以用确定性代码从当前请求构造足够稳定的 `runUserGoal`；
2. “继续处理这些”“把刚才的问题发 issue”等跨消息指代不需要额外模型归一化；
3. resume 与 Answer 不依赖 Planner 私有目标解释；
4. 不需要把任何 Planner 私有语义提升到 Root state。

## 4. 职责边界

### 4.1 Goal Creation 拥有

`goalCreation` 只负责回答：

> 这一次用户正在要求完成什么，理解该目标必须保留哪些已经确认的背景？

它可以读取：

- canonical main conversation 中的用户与助手消息；
- 已接受的 handoff copy；
- main context compaction summary；
- 解释路径、时间和当前环境所必需的稳定 runtime facts。

它输出一段完整、紧凑的目标文本。当前目的、必要背景、已确认约束和被消解的指代自然地写在同一个
文本值中，不再人为拆成 `objective` 与 `context` 两个字段。

它必须：

- 保留编号、URL、路径、顺序和用户显式约束；
- 只根据已确认主对话消解指代；
- 对缺失对象或范围保持原始不确定性，不猜测答案；
- 将非空但含糊的用户请求仍表示为目标，交给 Planner 判断是否需要用户输入。

### 4.2 Goal Creation 不拥有

它不得：

- 判断是否需要工具；
- 判断已有结果是否足够回复；
- 查看 Capability registry 或 Capability 文档；
- 选择 Capability；
- 拆分 task 或生成 plan；
- 判断 `unavailable`；
- 生成用户可见问题或回复；
- 修改 active delegation 或 Planner checkpoint。

### 4.3 Planner entry 拥有

Planner entry 在收到稳定 `runUserGoal` 后统一决定：

- 需要执行时提交最短 `execute_plan`；
- 不需要执行时提交 `answer_directly`；
- 缺少必须由用户提供的信息时提交 `user_input_required`；
- 当前 effective workspace 确实无法执行时提交 `unavailable`。

Planner 可以使用私有 General 默认文档和 `grep_search` 发现更具体的 Capability，但 Root 仍只看见
terminal action 与 plan tasks。

### 4.4 Answer 拥有

Answer 仍然是唯一用户可见回复节点：

- `answer_directly` -> `reply_mode=direct`；
- `user_input_required` -> `reply_mode=user_input_required`；
- `unavailable` -> `reply_mode=blocked`；
- boundary `goal_done` -> `reply_mode=goal_done`。

Planner 不提供 answer 文本、问题、理由或 gap note。Answer 根据 `runUserGoal`、canonical main
conversation 和根图闭合事实生成回复。

## 5. Goal Creation 协议

### 5.1 文本就是协议

删除 Entry 的整个结构化输出协议：

```ts
type UserGoal = string;
```

Goal Creation 直接调用普通 chat model，读取返回消息的文本内容：

```ts
const response = await model.invoke(messages, runnableConfig);
const userGoal = readMessageText(response).trim();
```

整个 `userGoal` 字符串是值，不从中解析标题、XML、JSON、前缀或段落。模型即使输出一段或多段文本，
Root 也只把完整文本当作目标数据。该响应不进入 `state.messages`，因此不会伪装成对用户的回复。

定义一个统一的 `USER_GOAL_MAX_CHARS`，取代原来的 objective/context 两个字段上限。建议初始值为
`6_000`，等于现有两个字段预算之和。运行时只做以下形状验证：

- trim 后非空；
- 字符数不超过 `USER_GOAL_MAX_CHARS`；
- provider 返回的内容可被现有 `readMessageText()` 读取。

后续 prompt 统一把这个字符串作为一个只读数据块渲染，不再拆字段：

```text
<run_user_goal role="task_boundary" source="orchestrator_state" trust="read_only">
<![CDATA[
完整 User Goal 文本
]]>
</run_user_goal>
```

不再存在：

- Goal Creation structured-output schema；
- Goal Creation tool/function binding；
- JSON mode 与 route-functions 两套 transport；
- structured-output auto-repair；
- `route_to_answer`；
- `route_to_planner`；
- `action: answer | needs_plan`；
- “是否需要工具”的 Entry prompt 规则。

### 5.2 输入顺序

保持当前 Entry 已验证的上下文顺序：

```text
System(goal creation contract)
Synthetic runtime facts
Compaction summaries, when present
Canonical main conversation
Latest user request
```

不注入：

- Capability registry；
- Capability documents；
- Planner private messages；
- delegation lane transcript；
- task draft 或 future plan。

### 5.3 失败行为

- 空文本或超出统一预算时 fail closed，并报告明确的 Goal Creation protocol error；
- model invocation failure 原样传播，不进行结构化修复重试；
- 普通 assistant text 就是 `UserGoal`，不再猜测或解析其中的结构；
- 不使用“复制最后一条消息”作为静默 fallback；
- 空用户请求应在 invocation contract 更早的位置拒绝，而不是创建虚假目标。

这里仍需要一次语义模型调用，因为跨消息指代需要读取主对话；取消的是不稳定的结构化 transport，
不是目标归一化本身。

## 6. Planner terminal protocol 变化

新增：

```ts
type PlannerAction =
  | 'answer_directly'
  | 'continue_current'
  | 'execute_plan'
  | 'goal_done'
  | 'user_input_required'
  | 'unavailable';
```

对应 terminal tool：

```text
answer_directly({})
```

语义：canonical main conversation 已包含 Answer 回复当前目标所需的事实，或者目标本身只需要 Answer 的
知识性、解释性或对话性回复；不应启动 Capability execution。

它不得携带：

- answer text；
- reason；
- context；
- question；
- tasks。

模式约束：

| mode | 允许 action |
|---|---|
| entry | `answer_directly`, `execute_plan`, `user_input_required`, `unavailable` |
| boundary | `continue_current`, `execute_plan`, `goal_done`, `user_input_required`, `unavailable` |

`answer_directly` 不得用于 boundary。boundary 已有 executor evidence 时，目标完成使用 `goal_done`；
仍缺执行使用 `continue_current` 或 `execute_plan`。

不能复用 `goal_done` 表示 entry 直答，因为 `goal_done` 的既有语义是“已接受的执行证据完成了目标”。

## 7. Root transition

### 7.1 Fresh run

`goalCreation` 成功后机械更新：

```ts
{
  runUserGoal: userGoal,
  runNextDelegation: null,
  runCapabilityPlan: [],
}
```

并固定 dispatch：

```ts
Send('capabilityPlanner', {
  mode: 'entry',
  plannerState: {
    runId,
    traceId,
    runUserGoal: userGoal,
    runDelegationSummaries,
    runCapabilityPlan: [],
  },
})
```

### 7.2 Planner entry result

| commit | Root transition |
|---|---|
| `execute_plan` | materialize first delegation -> `capability` |
| `answer_directly` | clear next plan, keep `runUserGoal`, `runLatestDelegationOutcome=null` -> `answer` |
| `user_input_required` | set matching closed outcome -> `answer` |
| `unavailable` | set matching closed outcome -> `answer` |

`answer_directly` 不写入 `runLatestDelegationOutcome`，因为它不是 delegation outcome。Answer 在没有
active delegation、planner failure 或 closed execution outcome 时自然选择 `direct` mode。

### 7.3 Resume

`prepare` 先验证持久化 `UserGoal` 是否为新协议的字符串。验证通过后，`afterContextPrep` 的 resume 分支
不经过 `goalCreation`：

```text
resume_active + legacy goal     -> answer[checkpoint_incompatible]
resume_active + pending          -> capability
resume_active + awaiting_decision-> plannerBoundaryIterationGuard
otherwise                        -> goalCreation
```

`runUserGoal` 继续由 `TaskActiveDelegation.userGoal` 恢复。Planner 继续使用相同 `traceId` 与既有
private checkpoint namespace。

`checkpoint_incompatible` 是 fail-closed 的运行时终态：Answer 直接返回固定提示，不调用 Goal Creation、
Planner、Answer model 或 Capability。它不是可恢复的 `resume_active` 状态；返回提示时会清除失效的
`taskActiveDelegation`，也不触发任何旧状态转换。

## 8. 状态与隐私不变量

本次必须保持：

1. `runUserGoal` 是 Root 可见的稳定 task boundary，不包含 Capability 文档或 Planner 搜索结果；
2. Planner 私有消息、General 文档、grep 结果与压缩摘要只存在于 Planner checkpoint；
3. Planner 对 Root 的唯一语义输出仍是 terminal action 和 `tasks[]`；
4. `TaskActiveDelegation.userGoal` 继续保存创建 delegation 时的目标快照；
5. 同一 task 的 resume 保持 `traceId`，新 run 只更换 `runId`；
6. Goal Creation 不拥有独立 session、checkpoint 或 resume protocol；
7. Answer 不读取 Planner 私有 state。

新的 `UserGoal` 字符串会让大部分代码只做整体传递。现有生产字段读取机械收缩为：

- `buildRunUserGoalContext()` 直接渲染整个字符串；
- Answer blocked fallback 直接使用 `runUserGoal`；
- Planner、delegation snapshot、resume 与 telemetry 继续整体复制，不再理解子字段。

## 9. 代码影响范围

预计生产代码只涉及四个窄面：

### A. Entry -> Goal Creation

- 将 `createEntryDecisionRunner` 收缩为 goal creation runner；
- 使用普通 model `invoke()`，将返回文本整体保存为 `runUserGoal`；
- `UserGoal` 从 `{ objective, context }` 收缩为 string；
- `buildRunUserGoalContext()` 与 Answer blocked fallback 改为直接消费字符串；
- 删除 Entry structured-output schema、route tools、transport 分支与 auto-repair；
- runner 成功后固定 dispatch Planner；
- prompt 删除 result availability / tool requirement 判断。

### B. Planner terminal action

- `PLANNER_ACTIONS` 增加 `answer_directly`；
- 增加无参数 terminal tool；
- entry prompt 描述直答边界；
- `parsePlannerCommit` 增加 entry/boundary mode invariant。

### C. Graph 与命名

- graph node 从 `entryDecision` 改名为 `goalCreation`；
- `afterContextPrep` 的普通 fresh-run route 改为 `goalCreation`；
- 新格式 checkpoint 的 resume routes 不变；
- prepare 对旧对象格式目标 fail closed，并以 `checkpoint_incompatible` 进入 Answer；
- telemetry component/name 同步改名。

### D. Answer 映射

- Planner entry 的 `answer_directly` 固定进入 Answer direct mode；
- 增加 `checkpoint_incompatible` runtime reason，直接返回固定提示，不调用 Answer model；
- 无需新增 Planner -> Answer payload；
- `runUserGoal` 在直答路径上不再是 `null`。

不涉及：

- Planner checkpoint namespace；
- Planner private state schema；
- General 默认候选；
- `grep_search`；
- Capability executor；
- toolkit authorization / review；
- 新格式 delegation resume 的既有语义；
- context compaction 算法；
- artifact handoff。

## 10. 不兼容策略与清理

这是内部 graph contract 的一次 hard cut。新状态只读写字符串；运行时代码不把 `UserGoal` 定义为
`string | legacy object`，也不提供旧格式 adapter、自动迁移或兼容模式参数。

部署后若恢复到包含旧目标对象，或缺少新版 `traceId` 的 active-delegation checkpoint：

```ts
type LegacyUserGoal = {
  objective: string;
  context: string | null;
};
```

运行时必须在 resume 入口、进入任何模型或 Capability 节点前识别为 `checkpoint_incompatible`，并返回稳定提示：该任务由
旧版本创建，当前版本无法继续，请重新发起或重述任务。这个结果不得伪装成
`planner_checkpoint_missing`，也不得从 `objective` / `context` 猜测、拼接或重建字符串目标，或从
`transcriptRunId` 推断缺失的 `traceId`。

不兼容处理必须满足：

- 默认行为和唯一行为都是拒绝旧格式；
- 不存在启动参数、invoke option、环境变量或隐藏 feature flag 可以重启旧 Entry 协议；
- 不调用模型生成错误说明，避免一次确定性协议错误再引入模型不稳定性；
- 固定回复后清除失效的 active delegation，后续运行不会再次尝试恢复旧状态；
- telemetry 单独记录 `checkpoint_incompatible`，以便观察 hard cut 的实际影响；
- 用户重新发起任务后按新协议创建新的字符串目标和新的 task trace。

删除或替换：

- `EntryDecision` / `EntryOutcome` 的 `answer | needs_plan` union；
- `buildEntryDecisionSchema()` 与 Entry structured-output options；
- `route_to_answer` / `route_to_planner`；
- `entryDecisionProtocol` provider 配置；
- result-availability Entry dataset 和 scorer；
- prompt 中“需要任何工具则 needs_plan”的规则；
- graph event / metadata 中不再准确的 `entryDecision` 命名。

保留并调整：

- objective/context 总预算合并为一个 `USER_GOAL_MAX_CHARS`；
- canonical conversation 与 compaction 输入；
- Entry 中已经验证的路径、URL、编号与指代保真 eval。

如果外部 telemetry 或测试依赖 graph node name，应在同一 PR 中同步，不通过永久 alias 保留旧节点。

## 11. 测试计划

### 11.1 Goal Creation

- 当前明确请求生成稳定的非空目标文本；
- “把这些也发 issue”能从已接受主对话结果消解“这些”；
- 路径、URL、编号、顺序和限制不丢失；
- 必要背景自然保留在同一目标文本中，无关历史不进入目标；
- 未确认对象不被猜测；
- runner 不调用 `withStructuredOutput()` 或 `bindTools()`；
- 输出文本不追加到 canonical messages；
- 空文本与超预算文本 fail closed；
- 不存在 JSON/function transport repair 调用；
- 新 checkpoint 只写 string，代码中不存在 legacy goal 转换函数。

### 11.2 Planner entry

- 问候、解释、已有事实复述 -> `answer_directly`，不创建 delegation；
- 读取当前目录、修改文件、访问网页 -> `execute_plan`；
- 缺少会改变执行结果的目标或选择 -> `user_input_required`；
- effective workspace 无可执行 Capability -> `unavailable`；
- `answer_directly` 带 tasks 或出现在 boundary 时被拒绝；
- entry 的 `goal_done` 继续被拒绝。

### 11.3 Lifecycle

- fresh run 恰好调用一次 Goal Creation；
- fresh run 无论是否执行都恰好进入一次 Planner entry；
- direct answer 路径没有 Capability invocation；
- execution 路径的 task count 与 Capability names 不变；
- boundary 不回到 Goal Creation；
- `resume_active` 不重新创建目标；
- resume 保持 trace 与 private Planner checkpoint；
- 旧 `{objective, context}` 或缺少 `traceId` 的 delegation checkpoint 返回 `checkpoint_incompatible`，且 Goal Creation、Planner、
  Answer model 与 Capability 的 invocation count 都为零；
- 不兼容路径给出重新发起任务的固定用户提示，不尝试转换旧目标；
- Planner 私有文档和搜索结果不进入 Root state / Answer prompt / root stream。

### 11.4 Regression

- `npm test -w @pinpawo/pet-agent`；
- `npm run typecheck`；
- `npm run build`；
- lifecycle model eval：direct / clarify / unavailable / one-task / multi-task / resume。

## 12. 成本与延迟

必须明确记录调用数变化：

| 请求类型 | 当前 | 目标 |
|---|---|---|
| 需要 Capability execution | Entry + Planner + Capability... | Goal Creation + Planner + Capability... |
| 直接回答 | Entry + Answer | Goal Creation + Planner + Answer |
| 需要用户澄清 | Entry + Answer | Goal Creation + Planner + Answer |

因此：

- 执行型请求的语义模型调用数基本不变；
- 直答与澄清请求增加一次 Planner 调用；
- Planner 对这类请求不应调用 `grep_search`，应在第一次模型决策提交 terminal action；
- lifecycle eval 必须记录 latency、input/output tokens 与 invocation count 的变化。

本次不为了省这一次调用重新引入 Entry 路由判断。若成本不可接受，应单独验证确定性 Goal Creation，
而不是恢复两个语义决策节点。

## 13. 实施拆分

建议一个小 PR、两个可独立 review 的提交：

### Commit 1：Planner 接管直答路由

- 增加 `answer_directly` terminal action/tool；
- 增加 mode invariant 与单元测试；
- Root 将它映射到 Answer direct mode；
- 此时旧 Entry 尚未产生该 action，生产行为基本不变。

### Commit 2：Entry 收缩为 Goal Creation

- `UserGoal` 收缩为 string，Goal Creation 改用普通文本输出；
- 删除 Entry schema、route tools、transport 分支与 auto-repair；
- prompt 改为只生成目标文本；
- graph 固定进入 Planner entry；
- 删除旧 `answer | needs_plan` route；
- 更新 lifecycle tests、evals、telemetry 与 raw docs。

两个提交都不修改 Planner persistence、General discovery 或 Capability execution，因此 review 可以集中在
控制协议和路由变化。

## 14. 完成定义

以下条件同时成立才算完成：

1. fresh run 不再存在独立的 result-availability / tool-required Entry decision；
2. `runUserGoal` 由职责单一的 Goal Creation 创建；
3. Goal Creation 的普通文本响应整体成为 `UserGoal`，不经过 JSON、function call 或文本解析；
4. 所有 fresh goals 固定进入 private Planner entry；
5. Planner 可以用无 payload 的 `answer_directly` 路由 Answer；
6. direct、clarify、unavailable、execute 与 resume 生命周期测试通过；
7. Planner 私有上下文没有新增 Root 泄漏面；
8. `entryDecision` 的旧 schema、route tools、transport、prompt、eval 和 telemetry 命名已清理；
9. Planner persistence、General 默认候选、Capability executor 与 resume 行为无回归；
10. 旧 UserGoal checkpoint 只会得到明确的 `checkpoint_incompatible` 结果，且不存在迁移代码或兼容模式；
11. direct 请求新增一次 Planner 调用的成本与延迟已经由 eval 记录并接受。
