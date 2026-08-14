# Pet Agent Orchestrator Route Design

> 状态：Draft v1
> 日期：2026-04-01

## 1. 文档目标

这份文档单独说明 orchestrator graph 中 `route` 节点的设计。

它回答三个问题：

- `route` 节点到底是什么角色
- 为什么不用 structured output 路由
- `route` 如何把任务委托给 capability

## 2. 基本结论

`route` 节点不是一个轻量分类器。

它就是主 orchestrator agent 的一次推理，负责在每轮输入里做两件事之一：

1. 直接回复用户
2. 把任务委托给某个 capability

因此，`route` 节点不再输出一个五字段的 structured output JSON，而是改成：

- 直接回复：输出自由文本
- capability 委托：调用 `delegate_capability` 工具

## 3. 为什么不用 structured output

之前的 structured output 方案存在三个问题：

1. direct reply 也要被塞进 JSON 字段，回复质量和自然度受约束
2. route 做了一次很重的推理，但最后只吐一个很窄的 JSON，产出价值偏低
3. prompt 里要解释很多条件字段规则，例如：
   - `mode=direct` 时 `reply` 必填
   - `capability/task/context_summary` 必须为 `null`

这些规则不是 LLM 最自然的行为。

而 tool call 路由更符合模型本身的决策方式：

- 要么直接说话
- 要么调用一个委托工具

## 4. route 节点行为

### 4.1 输入

`route` 节点接收：

- 当前消息历史 `messages`
- 当前 actor 信息
- 当前可用 capability 列表

### 4.2 输出

`route` 节点只会产生两类结果之一：

#### A. direct reply

模型直接输出自然语言回复。

graph state 中写入：

- `routeMode = "direct"`
- `directReply = <自由文本>`
- `activeCapability = null`

#### B. capability delegation

模型调用 `delegate_capability` 工具。

graph state 中写入：

- `routeMode = "capability"`
- `activeCapability = <capability name>`
- `capabilityTask = <明确任务>`
- `capabilityContextSummary = <简短上下文摘要>`

## 5. delegate_capability 工具

### 5.1 作用

`delegate_capability` 不是业务工具。

它只是 orchestrator 的委派动作，用来表达：

- 这轮不应由 orchestrator 直接完成
- 应该交给某个 capability subagent 继续执行

### 5.2 输入结构

```typescript
type DelegateCapabilityInput = {
  capability: string;
  task: string;
  context_summary: string;
};
```

约束：

- 一轮 route 推理最多调用一次
- `task` 必须是明确任务，不只是 capability 名称
- `context_summary` 只保留 capability 真正需要的最小上下文

## 6. graph 中的后续处理

### 6.1 direct 路径

如果 `route` 直接回复：

- 不再创建 direct subagent
- `direct` 节点只负责把 `directReply` 写成最终 `AIMessage`

这样可以避免为普通聊天再跑第二个 subagent。

### 6.2 capability 路径

如果 `route` 调用了 `delegate_capability`：

- graph 进入 `capability` 节点
- `capability` 节点创建对应的 subagent
- 把以下信息作为 handoff 传入：
  - `task`
  - `context_summary`
  - 原始 `messages`

capability subagent 负责真正执行能力逻辑。

## 7. 优点

这套设计的直接好处有：

1. direct reply 是自由文本，不再受 JSON schema 约束
2. route prompt 更短，不需要解释大量条件字段
3. route 的输出更符合 LLM 的自然决策方式
4. direct 路径不再重复起一个 subagent，减少一层重复推理

## 8. 当前约束

当前实现有一个明确边界：

- direct 路径不创建 subagent
- 因此 direct 回复阶段不会使用 global tools

这意味着当前版本更适合：

- 普通直接聊天
- capability 委托

如果后续希望 direct 路径也能稳定使用 global tools，需要单独设计 direct execution model。

## 9. 与 capability 文档的关系

- orchestrator route 的职责，以本文件为准
- 当前 Capability / Toolkit 定义以
  [Capability / Toolkit V2 契约](../../reference/extensions/capability-toolkit.md)为准；
  组合理由见
  [Capability / Toolkit 组合设计](toolkit-composition.md)
