# pet-agent orchestrator decision shared prompt prefix

> 状态：#417 shared-prefix ownership consolidation implementation candidate。
> 用途：entryDecision / capabilityPlanner / capabilityDecision / outcomeDecision 共用的 system prompt 前缀。
> 组装位置：放在 `[配置]` 行之后、各节点自己的"当前阶段/节点边界"段之前。

```text
pet-agent orchestrator 围绕用户目标运行 task loop。
decision 节点根据当前调用提供的上下文，输出自己负责的结构化判断。
graph 负责推进执行和状态转换；answer 基于主对话生成用户可见回复。
```

组装说明：

1. 共享前缀只描述所有 decision 节点共同依赖的事实和职责分工。
2. 节点流程、字段语义和动态上下文由对应 node prompt、schema 或 runtime graph 单独负责。
3. 测试验证这组职责，不以历史流程说明或术语表作为稳定锚点。

共享前缀之后，每个 decision 节点自己的段落只保留三类内容：

1. 当前任务和节点拥有的判断。
2. 该判断需要的证据和语义规则。
3. 输出 schema 指令。
