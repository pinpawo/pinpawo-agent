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
| 终端 | TUI、Studio Console，以及读文本的模型（自动审核、审批 prompt） | 只按 block kind 渲染，不认识工具（§2.4） |

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

/** 每个 block 都带 `text`：它是该 block 的纯文本降级形态。 */
export type OperationBlock =
  | { kind: 'code'; text: string; language?: string; truncated?: true }
  | { kind: 'diff'; text: string; path?: string; truncated?: true }   // text 为 unified diff
  | { kind: 'text'; text: string; label?: string; truncated?: true };

export const OPERATION_BLOCK_KINDS: readonly OperationBlock['kind'][];
export function isOperationSummary(value: unknown): value is OperationSummary;
export function assertNever(value: never): never;
```

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
  - `target`/`summary` 折成单行；
  - 单个 block 的 `text` 超过上限时截断并设 `truncated: true`。
- **按 callId 复用。** Host 的 operation tracker 在一次调用的第一个事件上算出摘要，后续
  phase 复用，不再逐个事件重算和合并。因为 `summarize` 是纯函数，审批和自动审核各自
  调用入口得到的结果与时间线一致；不要求跨 pet-agent/Host 传递同一个对象。
- **执行结果**：时间线用 phase（完成、失败、中断）加工具原始输出表达，pipeline 不再做
  output 摘要。

### 2.4 终端

| 终端 | 形状 |
| --- | --- |
| 审批视图 `HumanReviewView` | `{ kind: 'operation'; title?: string } & OperationSummary`。没有 operation 摘要的审批仍用 plain/markdown。 |
| 时间线事件 `AgentOperationEvent.operation` | 携带 `target/summary/blocks`；没有 `details`。 |
| 模型文本（`reviewViewToText`、自动审核 prompt） | code → 带 language 的代码块；diff → diff 代码块；text → label 小标题加正文。 |

TUI 和 Console 的渲染约定：

- 标题行：取 summary、target、title 中第一个有值的；不按工具名判断。
- `code`：等宽，保留换行，不重排；language 只是提示。
- `diff`：按 unified diff 渲染，`+`/`-` 着色；有 path 时显示。
- `text`：普通文本，可折行；有 label 时作为小标题。
- `truncated`：block 末尾提示「内容已截断」。
- 审批展示全部 block；时间线默认只显示标题行，展开或 PageUp 时显示 block。
- **未知 kind**：把 `text` 当等宽纯文本显示，不拒收。

## 3. 新增 block kind 的流程（固定约定）

kind 是 contracts 里的封闭集合。Toolkit 不能自定义 kind；新工具只能组合已有 kind。
需要新 kind 时，按下面的流程走，不允许跳步。

### 3.1 先回答三个问题

在 PR 描述里逐条写明，答不上来就不加：

1. **为什么现有 kind 组合不出来？** 只是换个样式不算理由。
2. **它是展示原语，而不是工具语义吗？** 名字和字段描述「怎么显示」，不能描述「是哪个工具的什么数据」（`table` 可以，`git_status` 不行）。
3. **它的 `text` 降级形态是什么？** 旧客户端只看 `text` 也必须能让人做出审批决定。

### 3.2 一个 PR 改完所有地方

PR 标题：`Operation blocks: add <kind>`。改动清单：

| 位置 | 要做的事 |
| --- | --- |
| `packages/agent-contracts` | `OperationBlock` 加成员（必须含 `text` 和 `truncated?`）；`OPERATION_BLOCK_KINDS` 加名；`isOperationSummary` 校验新字段 |
| contracts 测试 | 合法、缺 `text`、多余字段、字段类型错，各一条 |
| pet-agent 统一入口 | 若新 kind 除 `text` 外还有大字段，补截断规则 |
| pet-agent 模型文本 | `reviewViewToText` 和自动审核 prompt 的写法 |
| TUI | 审批（`reviewContentLines`）和时间线（`operationDisplay`）的渲染，加测试 |
| Studio Console | `PetSessionView` 的渲染 |
| 至少一个 toolkit | 真正用上它；不加没有使用者的 kind |
| 本文档 | §2.1 类型、§2.4 终端约定各补一条 |

### 3.3 编译期保障

所有按 kind 分支的代码都写成：

```ts
switch (block.kind) {
  case 'code': ...
  case 'diff': ...
  case 'text': ...
  default: return assertNever(block);
}
```

漏改任何一处，`npm run typecheck` 就失败。按 kind 分支时不要用 `if` 链或查表，否则编译器发现不了遗漏。

### 3.4 运行期保障

未知 kind 走 `text` 降级（§2.4），用于 Host 和客户端版本错开时的实时显示。
这不是旧数据兼容：存储里的旧数据仍按仓库约定不兼容。降级路径在 contracts 和 TUI 各有一条测试。

### 3.5 验证

`npm run build` 后 `npm run typecheck`；contracts、pet-agent、tui 测试；
PR 里附 TUI 审批和时间线的截图。

## 4. 落地顺序

每步一个 PR，前一个合并后再开下一个：

1. contracts：`OperationSummary`、`OperationBlock`、`isOperationSummary`、`assertNever` 和测试。
2. pet-agent + 全部 toolkit：`summarize` 和统一入口，Host tracker 按 callId 复用；审批视图改用 OperationSummary；
   删除 `diff` 审批视图、`summarizeOutput`、`summarizeError`、`details`；
   时间线事件换成新字段，TUI 和 Console 先做到能编译（blocks 暂按 `text` 显示）。
3. 客户端：TUI 和 Console 按 §2.4 渲染；删除 `OPERATION_PAYLOAD_DETAIL_KEYS`、
   `SHELL_TOOL_LABELS`、`isApplyPatchOperation` 等按字段名或工具名的判断。
