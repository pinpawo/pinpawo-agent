# Tool operation summary 与 block kind

状态：Draft（方向已确认，2026-10-20）。实现分三个 PR 推进，见末尾「落地顺序」。
取代 [architecture-refactor.md §6](architecture-refactor.md#6-operation-metadata-草案) 里的
`summarizeInput/summarizeOutput/summarizeError` 与 `details` 设计。

## 1. 目标与分层

Toolkit 负责把自己的工具输入投影成可展示的摘要，Host 和客户端不认识具体工具。
摘要只用一组通用的展示原语（block）表达，客户端按 block 的 kind 渲染，
不靠字段名或工具名猜语义。

按一次 tool call 的生命周期分三层：

| 层 | 是什么 | 本设计在这一层的约定 |
| --- | --- | --- |
| 源头 | 模型发出的 tool call 参数，schema 由 toolkit 定义 | `summarize` 与参数 schema 放在一起，只是参数的投影（§2.2） |
| 过程 | tool call 的执行 pipeline：审批、自动审核、执行、事件 | 只通过一个入口计算摘要，按 callId 复用；执行结果用原始输出（§2.3） |
| 终端 | TUI、Studio Console，以及读文本的模型（自动审核、审批 prompt） | 默认都走同一个文本渲染；客户端可以对部分 kind 做原生渲染，其余回退到默认文本（§2.4） |

三层共用的类型定义在 contracts（§2.1）。

## 2. 接口

### 2.1 共享类型（`@pinpawo/agent-contracts`）

```ts
export type OperationSummary = {
  /** 单行。作用对象：路径、cwd、URL、仓库。 */
  target?: string;
  /** 单行。标题行显示的那句话；shell 类工具可以直接是命令。 */
  summary?: string;
  /** 按顺序展示。 */
  blocks?: OperationBlock[];
};

/**
 * 编写端：封闭 union。toolkit 只能产出这里列出的 kind。
 * 每个 block 都带 `text`：它是该 block 的纯文本降级形态。
 */
export type OperationBlock =
  | { kind: 'code'; text: string; language?: string; truncated?: true }
  /** 补丁原文，按 format 声明的格式解释；不做格式转换。 */
  | { kind: 'diff'; format: 'unified' | 'v4a'; text: string; path?: string; truncated?: true }
  | { kind: 'text'; text: string; label?: string; truncated?: true };

/** 接收端：可能收到更新版本 Host 发来的、本版本不认识的 kind。 */
export type UnknownOperationBlock = { kind: string; text: string; truncated?: true } & JsonObject;
export type ReceivedOperationBlock = OperationBlock | UnknownOperationBlock;

export const OPERATION_BLOCK_KINDS: readonly OperationBlock['kind'][];
export function isKnownOperationBlock(block: ReceivedOperationBlock): block is OperationBlock;
/** 接收端守卫：已知 kind 逐字段严格校验；未知 kind 要求 `kind`、`text` 为字符串且其余字段都是 JSON。 */
export function isOperationSummary(value: unknown): value is OperationSummary;
export function assertNever(value: never): never;

/** 默认渲染：所有终端共用，也是回退路径。 */
export function operationBlockToText(block: ReceivedOperationBlock): string;
export function operationSummaryToText(summary: OperationSummary): string;
```

**编写端与接收端分开。** 编写端（toolkit、pet-agent 统一入口）只用封闭的 `OperationBlock`；
接收端（parser、默认渲染、客户端）的类型是 `ReceivedOperationBlock`。接收端先用
`isKnownOperationBlock` 分出未知 kind 走 `text` 降级，再对已知 kind 做穷尽检查（§3.3）。

**兼容承诺的范围。** 未知 kind 降级只覆盖「双方都已采用 blocks 协议之后」新增的 kind。
不认识 blocks 的旧客户端不在承诺内，按仓库约定不兼容。

**diff 的格式。** `apply_patch` 的输入是 V4A，unified diff 来自 git 一类工具；两者都按原文放进
`text`，用 `format` 标明。默认渲染和客户端都只按行首 `+`/`-` 着色，不解析、不转换，也不为了展示
去读文件拼出 unified diff。

### 2.2 源头：toolkit（`@pinpawo/pet-agent` 的 `ToolOperationMetadata`）

```ts
type ToolOperationMetadata = {
  title?: string;
  summarize?: (input: unknown) => OperationSummary | null;
};
```

- `summarize` 只看 tool call 参数，和参数 schema 写在同一个 toolkit 里，一起维护。
- 必须是纯函数：同步、不做 I/O、结果确定、可以重复调用。参数相同，摘要就相同。
- 只描述「这次调用要做什么」。不再有 output/error 摘要。

### 2.3 过程：执行 pipeline

- **唯一入口** pet-agent `summarizeToolOperation(definition, input)`。审批策略、自动审核、
  Host 事件归一化都只调它，不直接调 `summarize`。它负责：
  - 字符串 input 先尝试按 JSON 解析；
  - 捕获 `summarize` 抛出的异常，返回 null；
  - 用 `isOperationSummary` 校验，不合格整体丢弃；
  - `target`/`summary` 折成单行，只作标题；多行内容（如多行命令）由 toolkit 放进 code block；
  - 单个 block 的 `text` 超过单块上限时截断并设 `truncated: true`；所有 block 的 `text`
    合计超过总上限时，超出部分同样截断或丢弃并标记，保证摘要总量有界。
- **截断只影响展示，不替代审批事实。**
  - 自动审核仍把完整参数作为 `Input facts` 提交，摘要只是帮助理解的附加信息；
    完整参数超出审核预算时转人工审批，不能凭被截断的摘要自动批准。
  - 人工审批中被截断的 block 会显示截断标记。
- **按 callId 复用第一个有效摘要。** 只有拿到完整、有效 input 的事件（通常是 `on_tool_start`）
  才计算摘要。Host 的 operation tracker 缓存这次调用第一个非空摘要，后续 phase 复用。
  没有 input、或 input 不完整导致摘要为空的事件不缓存空结果，后面的事件拿到有效 input 时
  仍会计算并缓存。因为 `summarize` 是纯函数，审批和自动审核各自调用入口得到的结果与时间线
  一致；不要求跨 pet-agent/Host 传递同一个对象。
- **执行结果**：时间线用 phase（完成、失败、中断）加工具原始输出表达，pipeline 不再做
  output 摘要。

### 2.4 终端

| 终端 | 形状 |
| --- | --- |
| 审批视图 `HumanReviewView` | `{ kind: 'operation'; title?: string } & OperationSummary`。没有 operation 摘要的审批仍用 plain/markdown。 |
| 时间线事件 `AgentOperationEvent.operation` | 携带 `target/summary/blocks`；没有 `details`。 |

**默认文本渲染是统一的 pipeline。** `operationSummaryToText`（contracts）是唯一的默认渲染：

- 模型 prompt（`reviewViewToText`、自动审核）直接用它；
- TUI、Console 对没有原生渲染的 kind，以及整个不支持的视图，都回退到它；
- 它对已知 kind 的格式：code → 带 language 的代码块；diff → diff 代码块；text → label 小标题加正文；
  未知 kind → 原样输出 `text`；
- `truncated` 的 block 末尾都带截断标记，未知 kind 也一样；输出总量受 §2.3 的总上限约束。

**原生渲染是可选增强。** 客户端可以挑部分 kind 做更好的显示，其余走默认文本：

```ts
switch (block.kind) {
  case 'diff': return renderColoredDiff(block);
  default: return renderPlainText(operationBlockToText(block));
}
```

TUI 和 Console 的原生渲染约定：

- 标题行：取 summary、target、title 中第一个有值的；不按工具名判断。
- `code`：等宽，保留换行，不重排；language 只是提示。
- `diff`：按行首 `+`/`-` 着色（unified 和 V4A 通用）；有 path 时显示。
- `text`：普通文本，可折行；有 label 时作为小标题。
- `truncated`：block 末尾提示「内容已截断」。
- 审批展示全部 block；时间线默认只显示标题行，展开或 PageUp 时显示 block。
- 没有原生渲染的 kind（包括未知 kind）：显示默认文本，不拒收。

## 3. 新增 block kind 的流程（固定约定）

kind 是 contracts 里的封闭集合。Toolkit 不能自定义 kind；新工具只能组合已有 kind。
需要新 kind 时，按下面的流程走，不允许跳步。

### 3.1 先回答三个问题

在 PR 描述里逐条写明，答不上来就不加：

1. **为什么现有 kind 组合不出来？** 只是换个样式不算理由。
2. **它是展示原语，而不是工具语义吗？** 名字和字段描述「怎么显示」，不能描述「是哪个工具的什么数据」（`table` 可以，`git_status` 不行）。
3. **它的 `text` 降级形态是什么？** 旧客户端只看 `text` 也必须能让人做出审批决定。

### 3.2 PR 必须包含的改动

PR 标题：`Operation blocks: add <kind>`。

| 位置 | 要做的事 | 必须 |
| --- | --- | --- |
| `packages/agent-contracts` | `OperationBlock` 加成员（必须含 `text` 和 `truncated?`）；`OPERATION_BLOCK_KINDS` 加名；`isOperationSummary` 校验新字段 | 是 |
| contracts 默认渲染 | `operationBlockToText` 加这个 kind 的文本格式 | 是 |
| contracts 测试 | 合法、缺 `text`、多余字段、字段类型错、默认文本、截断标记，各一条 | 是 |
| pet-agent 统一入口 | 若新 kind 除 `text` 外还有大字段，补截断规则 | 视情况 |
| 至少一个 toolkit | 真正用上它；不加没有使用者的 kind | 是 |
| 本文档 | §2.1 类型、§2.4 默认文本格式各补一条 | 是 |
| TUI、Studio Console | 原生渲染 | 否，可同 PR 也可以后补；没做之前走默认文本 |

### 3.3 编译期保障

`operationBlockToText` 是唯一要求覆盖所有已知 kind 的函数，写法固定为「先分出未知 kind，再穷尽已知 kind」：

```ts
export function operationBlockToText(block: ReceivedOperationBlock): string {
  if (!isKnownOperationBlock(block)) return withTruncatedMarker(block.text, block.truncated);
  switch (block.kind) {
    case 'code': ...
    case 'diff': ...
    case 'text': ...
    default: return assertNever(block);
  }
}
```

漏写新 kind 的默认文本，`npm run typecheck` 就失败。客户端的 switch 用 `default` 回退到默认文本，
不要求覆盖所有 kind。

### 3.4 运行期保障

未知 kind 由默认渲染取 `text` 显示（§2.4），用于 Host 和客户端版本错开时的实时显示。
这不是旧数据兼容：存储里的旧数据仍按仓库约定不兼容。contracts 的契约测试覆盖：

- 未知 kind 带 `text` 且字段都是 JSON 时通过校验，并按 `text` 降级显示（含截断标记）；
- 未知 kind 缺 `text` 或含非 JSON 字段时拒收；
- 已知 kind 的多余字段、错误类型、`diff` 缺 `format` 时拒收。

### 3.5 验证

`npm run build` 后 `npm run typecheck`；contracts、pet-agent、tui 测试；
PR 里附 TUI 审批和时间线的截图。

## 4. 落地顺序

每步一个 PR，前一个合并后再开下一个：

1. contracts：`OperationSummary`、`OperationBlock`、`isOperationSummary`、`assertNever`、默认文本渲染和测试。
2. pet-agent + 全部 toolkit：`summarize` 和统一入口，Host tracker 按 callId 复用；审批视图改用 OperationSummary；
   删除 `diff` 审批视图、`summarizeOutput`、`summarizeError`、`details`；
   时间线事件换成新字段，TUI 和 Console 先全部走默认文本。
3. 客户端：TUI 和 Console 对 diff 等 kind 做原生渲染；删除 `OPERATION_PAYLOAD_DETAIL_KEYS`、
   `SHELL_TOOL_LABELS`、`isApplyPatchOperation` 等按字段名或工具名的判断。
