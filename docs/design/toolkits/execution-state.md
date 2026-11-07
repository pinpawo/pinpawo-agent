# Toolkit 执行状态

状态：draft，2026-11-05。领域归属：Toolkit。

## 目标

Toolkit 可以为工具执行声明状态字段。Capability 通过 `uses` 选择 Toolkit，创建子代理时组合这些字段。工具更新执行状态，Toolkit 显式提取对外结果，pet-agent 汇总并传递公共结果。

领域关系见 [Host / Agent / Capability / Toolkit](../host-agent-capability-toolkit.md)，Toolkit 公共契约见 [Capability / Toolkit](../../reference/extensions/capability-toolkit.md)。

## 职责

| 参与方 | 职责 |
|---|---|
| Toolkit | 定义字段、默认值、reducer、工具读写与对外结果提取 |
| Capability | 在 `uses` 中选择本次执行所需的 Toolkit |
| pet-agent | 组合 schema，校验字段归属，创建子代理，汇总 Toolkit 明确返回的公共结果 |
| LangChain / LangGraph | 执行原生 state 更新和 reducer |

schema 在创建子代理时确定，状态值在执行过程中更新。状态作用域是一次 Capability 子代理执行。

## 声明

`AgentToolkit` 增加可选的 `stateSchema`，类型为 LangGraph 原生 `StateSchema`。Toolkit 在 schema 中提供字段默认值；需要累计或合并的字段使用 `ReducedValue`。

```ts
import { StateSchema, ReducedValue } from '@langchain/langgraph';
import { z } from 'zod/v4';
import { defineToolkit } from '@pinpawo/pet-agent';

const collectedPaths = new StateSchema({
  collectedPaths: new ReducedValue<string[], string[]>(
    z.array(z.string()).default([]) as never,
    { reducer: (current, next) => [...new Set([...current, ...next])] },
  ),
});

const toolkit = defineToolkit({
  name: 'file-collection',
  description: 'Collect file paths during execution.',
  stateSchema: collectedPaths,
  instructions: 'Use the collection tools when the task requires collecting files.',
  tools: [],
});
```

Toolkit 的 schema 随 registry generation 一起固化字段定义。多个 Capability 可以复用同一个 Toolkit 定义，各自执行时持有独立的状态值。

## 装配

```text
Capability uses
  -> selected Toolkit stateSchema fields
  -> combined StateSchema
  -> SubagentRunInput.stateSchema
  -> createAgent({ stateSchema })
```

`resolveToolkitExecution` 按所选 Toolkit 的顺序组合字段，并保留原生字段定义、默认值与 reducer。`createSubagent` 将组合后的 schema 传给 `createAgent`。

每个字段由一个 Toolkit 声明。所选 Toolkit 之间出现字段重名时，装配报错并指出字段与所属 Toolkit；字段占用框架保留字段（如 `messages`、`jumpTo`、`structuredResponse`、对象原型字段）或已装配 middleware 的状态字段时，子代理创建报错。

声明为空的 Toolkit 使用现有子代理状态。组合范围由本次选中的 Toolkit 决定。

## 工具更新

工具通过 `ToolRuntime.state` 读取状态，通过原生 `Command` 更新状态与工具结果：

```ts
import { ToolMessage } from '@langchain/core/messages';
import { Command } from '@langchain/langgraph';

function recordPath(path: string, toolCallId: string) {
  return new Command({
    update: {
      collectedPaths: [path],
      messages: [new ToolMessage({
        content: `Collected ${path}`,
        name: 'collect_path',
        tool_call_id: toolCallId,
      })],
    },
  });
}
```

同一字段收到多次更新时，按 Toolkit 声明的 reducer 合并。比如并行收集多个路径时，上例保留各次更新并按路径去重。

## 结果

`SubagentResult.state` 保存原生 `agent.invoke` 的返回值，类型为只读的 `Record<string, unknown>`。原有 `messages`、`output`、用量与审核结果字段继续表达各自的结果。

Toolkit 通过可选的同步 `getResult(state)` 解释自己的状态，并返回公共结果贡献：

```ts
import type { Deliverable } from '@pinpawo/agent-contracts';

type ToolkitResult = { deliverables: readonly Deliverable[] };
type GetResult = (state: Readonly<Record<string, unknown>>) => ToolkitResult;
```

公共 `deliverables` 表达对请求方交付的引用。Toolkit 的内部字段由 Toolkit 自己命名和解释；例如 artifacts 从 `publishedRefs` 提取发布引用，返回 `{ deliverables }`。

pet-agent 按本次 Capability 的 `uses` 顺序调用已选 Toolkit 的 `getResult`，校验结果对象与引用，按 URI 保留首次出现的完整引用。未提供 `getResult` 的 Toolkit 贡献为空；提供函数时须返回合法结果，空数组表示本次没有交付物。结果函数同步读取已有 state。

结果提取在子代理返回后、Capability `finalize` 之前执行。`finalize` 沿用文字 `output` 收尾语义。审核拒绝或取消时，已产生的结果进入执行记录，最终公开引用仍由既有验收选择决定；执行抛出错误或中止时，沿原错误通道结束。

## 验证

- 按 `uses` 装配多个 Toolkit 的字段，保留默认值与 reducer。
- 工具通过 `Command` 更新状态与 ToolMessage，串行和并行更新均可在结果中读取。
- Toolkit 重名字段及与框架状态字段的冲突在执行前报错。
- 多次子代理执行的状态值独立；现有无扩展字段的 Toolkit 按原流程执行。
- 不同 Toolkit 从各自内部字段提供结果；框架只汇总明确返回的公共结果，缺省、校验与取消行为确定。
