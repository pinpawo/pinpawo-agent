# Toolkit 执行状态

状态：draft，2026-11-05。领域归属：Toolkit。

## 目标

Toolkit 可以为工具执行声明状态字段。Capability 通过 `uses` 选择 Toolkit，创建子代理时组合这些字段。工具负责更新自己的执行状态，调用方通过子代理结果读取输出。

领域关系见 [Host / Agent / Capability / Toolkit](../host-agent-capability-toolkit.md)，Toolkit 公共契约见 [Capability / Toolkit](../../reference/extensions/capability-toolkit.md)。

## 职责

| 参与方 | 职责 |
|---|---|
| Toolkit | 定义字段、默认值、reducer，以及工具对字段的读写 |
| Capability | 在 `uses` 中选择本次执行所需的 Toolkit |
| pet-agent | 组合所选 Toolkit 的 schema，校验字段归属，创建子代理并返回执行结果 |
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

调用方按 Toolkit 的字段契约读取 `result.state`。Toolkit 执行状态的返回与 Capability 对外结果的选择分别由各自契约定义。

## 验证

- 按 `uses` 装配多个 Toolkit 的字段，保留默认值与 reducer。
- 工具通过 `Command` 更新状态与 ToolMessage，串行和并行更新均可在结果中读取。
- Toolkit 重名字段及与框架状态字段的冲突在执行前报错。
- 多次子代理执行的状态值独立；现有无扩展字段的 Toolkit 按原流程执行。
